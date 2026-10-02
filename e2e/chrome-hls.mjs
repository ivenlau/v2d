/**
 * HLS 全链路 e2e（TS 转封装 + AES-128 解密回归，mux.js 路径错误的防再犯线）：
 *   1. Node 取 Apple bipbop 多码率流 → 截短为 4 段（绝对 URL，保留 #EXT-X-KEY 等头）→ localhost 提供
 *   2. 种 failed 的 hls 任务 → transferRetry 驱动管线：下载 → [AES-128 解密] → mux.js 转封装 → staged
 *   3. OPFS 产物用 mediabunny 校验：音视频轨存在、时长 ≈ EXTINF 合计（解密/转封装产出垃圾会在此暴露）
 */
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { chromium } from 'playwright'
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny'

const EXT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url))
const MASTER = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8'
const SEGMENTS = 4

// ── 1. 截短播放列表 ──
const masterText = await (await fetch(MASTER)).text()
const variantLine = masterText.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))
if (!variantLine) throw new Error('master 里没找到 variant')
const variantUrl = new URL(variantLine.trim(), MASTER).href
const variantText = await (await fetch(variantUrl)).text()
const keyLine = variantText.split('\n').find((l) => l.trim().startsWith('#EXT-X-KEY'))
console.log('[e2e] 加密方式:', keyLine?.trim() ?? '（无）')

const out = []
let segCount = 0
for (const raw of variantText.split('\n')) {
  const line = raw.trim()
  if (!line) continue
  if (!line.startsWith('#')) {
    segCount++
    if (segCount > SEGMENTS) break
    out.push(new URL(line, variantUrl).href) // 绝对化：截短后的清单由 localhost 提供
  } else {
    if (line.startsWith('#EXT-X-ENDLIST')) continue
    out.push(line)
  }
}
out.push('#EXT-X-ENDLIST')
const playlistText = out.join('\n')
const expectedDuration = out
  .filter((l) => l.startsWith('#EXTINF'))
  .reduce((s, l) => s + (Number(l.slice(8).split(',')[0]) || 0), 0)
console.log(`[e2e] 截短为 ${segCount} 段，期望时长 ≈ ${expectedDuration.toFixed(1)}s`)

const server = http.createServer((req, res) => {
  if (req.url === '/seg-first.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!doctype html><meta charset="utf-8"><body>
<script>
  fetch('/seg.ts').catch(() => {})
  setTimeout(() => fetch('/e2e.m3u8').catch(() => {}), 2000)
</script>`)
    return
  }
  // .ts 路径回真实的 TS MIME（否则 mpegurl 会让分类器把它当清单）
  if (req.url?.endsWith('.ts')) {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    res.end(playlistText)
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
  res.end(playlistText)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const playlistHttpUrl = `http://127.0.0.1:${port}/e2e.m3u8`

// ── 2. 启动扩展，种任务驱动管线 ──
const context = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
const sw = await new Promise((res) => {
  const s = context.serviceWorkers().find((x) => x.url().includes('chrome-extension'))
  if (s) res(s)
  else context.once('serviceworker', res)
})
void sw
const swLogAll = (m) => console.log('[SW]', m.text())
sw.on('console', swLogAll)
context.on('serviceworker', (nsw) => nsw.on('console', swLogAll))
const manager = await context.newPage()
await manager.goto(`chrome-extension://${new URL(sw.url()).host}/manager.html`)
await manager.evaluate(async () => {
  const cur = (await chrome.storage.local.get('settings'))['settings'] ?? {}
  await chrome.storage.local.set({ settings: { badge: true, blacklist: [], mseHookSites: [], ...cur, v115: { enabled: false } } })
})

await manager.evaluate(async (url) => {
  const task = {
    id: 'e2ehls001',
    kind: 'hls',
    dest: 'local',
    state: 'failed',
    url,
    fileName: 'e2e-hls.mp4',
    targetPath: '/v2d/e2e/',
    createdAt: Date.now(),
  }
  const d = await chrome.storage.local.get('transfer.tasks')
  const list = (d['transfer.tasks'] ?? []).filter((t) => t.id !== task.id)
  list.push(task)
  await chrome.storage.local.set({ 'transfer.tasks': list })
  return chrome.runtime.sendMessage({ type: 'transferRetry', taskId: task.id })
}, playlistHttpUrl)

let final = null
let last = ''
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const t = await manager.evaluate(async () => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.find((x) => x.id === 'e2ehls001')
  })
  if (t) {
    const line = `${t.state} 分段:${t.segmentsDone ?? 0}/${t.segmentsTotal ?? 0} ${t.error ?? ''}`
    if (line !== last) {
      console.log('[e2e]', line)
      last = line
    }
    if (['staged', 'failed', 'cancelled'].includes(t.state)) {
      final = t
      break
    }
  }
}
if (!final) throw new Error('150s 未到终态')
if (final.state !== 'staged') throw new Error(`期望 staged，实际 ${final.state}: ${final.error ?? ''}`)
console.log(`[e2e] ✅ HLS 管线到 staged，大小 ${final.size}`)

// ── 3. 产物校验（mediabunny）──
const b64 = await manager.evaluate(async (id) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('staging')
  const fh = await dir.getFileHandle(`${id}.part`)
  const file = await fh.getFile()
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(bin)
}, final.id)
const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
console.log('[e2e] 产物大小:', bytes.byteLength)
const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) })
const vTrack = await input.getPrimaryVideoTrack()
const aTrack = await input.getPrimaryAudioTrack()
if (!vTrack) throw new Error('产物缺视频轨（转封装失败？）')
if (!aTrack) throw new Error('产物缺音频轨')
const vDur = await vTrack.computeDuration().catch(() => 0)
const aDur = await aTrack.computeDuration().catch(() => 0)
const dur = Math.max(vDur, aDur)
console.log(
  `[e2e] 轨道: ${await vTrack.getCodec()} + ${await aTrack.getCodec()}，时长 ${dur.toFixed(1)}s（期望 ≈${expectedDuration.toFixed(1)}s）`,
)
if (dur < expectedDuration * 0.5 || dur > expectedDuration * 1.6) {
  throw new Error('时长偏差过大——解密/转封装可能产出了垃圾数据')
}

// ── 4. HLS 预览（hls.js 弹窗挂载）+ 分段先到清优回归 ──
{
  const sniffer = await context.newPage()
  const base = new URL(playlistHttpUrl).origin
  // 该页面加载即 fetch 分段（先到），2s 后 fetch 清单（后到）——复刻真实站点的到达顺序竞态
  await sniffer.goto(`${base}/seg-first.html`)
  const listTs = async () => {
    // 从 manager 页代查该标签页的候选
    return manager.evaluate(async (urlPrefix) => {
      const tabs = await chrome.tabs.query({ url: urlPrefix + '/*' })
      if (!tabs[0]?.id) return -2
      const r = await chrome.runtime.sendMessage({ type: 'list', tabId: tabs[0].id })
      return (r.candidates ?? []).map((c) => ({ k: c.kind, u: c.url.slice(-30) }))
    }, base)
  }
  await new Promise((r) => setTimeout(r, 1000)) // 分段已到、清单尚未到（页面 2s 后才拉清单）
  const beforeList = await listTs()
  console.log('[e2e] 清单前候选:', JSON.stringify(beforeList))
  const tsBefore = beforeList.filter((c) => c.k === 'file').length
  if (tsBefore < 1) throw new Error('ts 分段候选未注册（100KB 阈值/路由问题？）')
  await sniffer.evaluate((u) => fetch(u).catch(() => {}), playlistHttpUrl)
  await new Promise((r) => setTimeout(r, 1500))
  const afterList = await listTs()
  console.log('[e2e] 清单后候选:', JSON.stringify(afterList))
  if (afterList.some((c) => c.k === 'file' && c.u.endsWith('.ts'))) throw new Error('清单出现后 ts 分段候选未被清除')

  const extId = new URL(sw.url()).host
  await sniffer.evaluate((url) => {
    const f = document.createElement('iframe')
    f.src = url
    f.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:640px;z-index:999999'
    document.body.appendChild(f)
  }, `chrome-extension://${extId}/popup.html?embedded=1&hlspreview=1`)
  let panel = null
  for (let i = 0; i < 20 && !panel; i++) {
    await new Promise((r) => setTimeout(r, 500))
    panel = sniffer.frames().find((f) => f.url().includes('hlspreview=1'))
  }
  if (!panel) throw new Error('HLS 预览面板未加载')
  await panel.waitForSelector('.item', { timeout: 20000 })
  const badge = await panel.locator('.item .badge').first().textContent()
  console.log('[e2e] 候选类型:', badge)
  if (badge !== 'HLS') throw new Error(`期望 HLS 候选，实际 ${badge}`)

  let vSize = ''
  for (let i = 0; i < 60 && !vSize; i++) {
    await new Promise((r) => setTimeout(r, 500))
    vSize = await panel.evaluate(() => {
      const item = [...document.querySelectorAll('.item')].find((el) => el.querySelector('.thumb video'))
      if (!item) return ''
      const v = item.querySelector('.thumb video')
      return v.videoWidth > 0 ? `${v.videoWidth}x${v.videoHeight}` : ''
    })
  }
  console.log('[e2e] HLS 预览出帧:', vSize || '（未出帧）')
  if (!vSize) throw new Error('HLS 预览未出帧（hls.js 挂载失败？）')
  const panelEl = await sniffer.waitForSelector('iframe[src*="hlspreview=1"]')
  await panelEl.screenshot({ path: process.env.TEMP + '/hls-popup.png' })
  await sniffer.close()
}

server.close()
await context.close()
console.log('\nHLS 全链路通过 ✅')
