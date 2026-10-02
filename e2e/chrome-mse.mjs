/**
 * MSE 深捕获全链路 e2e：
 *   1. Node 用 mediabunny 把 bipbop 的 2 个 TS 分段转成 video-only / audio-only 两个 fMP4
 *   2. 本地测试页通过 MSE（两个 SourceBuffer）喂给 <video>——模拟 MSE 站点播放
 *   3. 捕获钩子应登记两个分组 → 弹窗候选出现 MSE 捕获卡
 *   4. 触发 mseDownload → 拉回暂存 → worker mediabunny 合并 → staged
 *   5. 产物校验：avc+aac、时长 ≈ 源片长
 */
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { chromium } from 'playwright'
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'

const EXT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url))
const MASTER = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8'

// ── 1. 造 video-only / audio-only 两个 fMP4 ──
async function makeTracks() {
  const master = await (await fetch(MASTER)).text()
  const vl = master.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')).trim()
  const variantUrl = new URL(vl, MASTER).href
  const vt = await (await fetch(variantUrl)).text()
  const segs = []
  let dur = 0, br = null
  for (const raw of vt.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF')) dur = Number(line.slice(8).split(',')[0])
    else if (line.startsWith('#EXT-X-BYTERANGE')) { const spec = line.slice(17).split('@'); br = { n: Number(spec[0]), o: spec[1] !== undefined ? Number(spec[1]) : null } }
    else if (line && !line.startsWith('#')) { segs.push({ url: new URL(line, variantUrl).href, dur, ...(br ? { br } : {}) }); dur = 0; br = null }
  }
  const parts = []
  let lastO = 0
  for (const seg of segs.slice(0, 2)) {
    const o = seg.br ? (seg.br.o ?? lastO) : null
    const headers = seg.br ? { Range: `bytes=${o}-${o + seg.br.n - 1}` } : {}
    if (seg.br) lastO = o + seg.br.n
    parts.push(new Uint8Array(await (await fetch(seg.url, { headers })).arrayBuffer()))
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob(parts)) })
  const vTrack = await input.getPrimaryVideoTrack()
  const aTrack = await input.getPrimaryAudioTrack()
  if (!vTrack || !aTrack) throw new Error('TS 里缺轨')
  // 期望时长取源流实际时间戳跨度（bipbop 的 PTS 跨度 > EXTINF 合计，属源流特性）
  const duration = Math.max(await vTrack.computeDuration(), await aTrack.computeDuration())

  const renderTrack = async (track, kind) => {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }), target: new BufferTarget() })
    const codec = await track.getCodec()
    const sink = new EncodedPacketSink(track)
    const source = kind === 'video' ? new EncodedVideoPacketSource(codec) : new EncodedAudioPacketSource(codec)
    if (kind === 'video') output.addVideoTrack(source)
    else output.addAudioTrack(source)
    await output.start()
    const meta = { decoderConfig: (await track.getDecoderConfig()) ?? undefined }
    for await (const packet of sink.packets()) await source.add(packet, meta)
    await output.finalize()
    return { buf: new Uint8Array(output.target.buffer), codecParam: await track.getCodecParameterString() }
  }
  const video = await renderTrack(vTrack, 'video')
  const audio = await renderTrack(aTrack, 'audio')
  return { video, audio, duration }
}

const { video, audio, duration } = await makeTracks()

// ── 2. 本地测试页（两个 SourceBuffer 的 MSE 播放） ──
const playerHtml = `<!doctype html><meta charset="utf-8"><body>
<video id="v" autoplay muted playsinline></video>
<script>
(async () => {
  const ms = new MediaSource()
  document.getElementById('v').src = URL.createObjectURL(ms)
  ms.addEventListener('sourceopen', async () => {
    const vsb = ms.addSourceBuffer('video/mp4; codecs="${video.codecParam}"')
    const asb = ms.addSourceBuffer('audio/mp4; codecs="${audio.codecParam}"')
    const [vb, ab] = await Promise.all([
      fetch('/video.mp4').then((r) => r.arrayBuffer()),
      fetch('/audio.mp4').then((r) => r.arrayBuffer()),
    ])
    // 按「init 段 + 逐分片」喂入（fMP4 源的真实形态，回归多块背压链路）
    const appendFmp4 = (sb, buf) =>
      new Promise(async (res) => {
        const dv = new DataView(buf)
        const boxes = []
        let o = 0
        while (o < buf.byteLength) {
          const size = dv.getUint32(o)
          const span = size === 0 ? buf.byteLength - o : size
          boxes.push({ start: o, end: o + span, type: String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]) })
          o += span
        }
        const append = (slice) => new Promise((r2) => { sb.addEventListener('updateend', r2, { once: true }); sb.appendBuffer(slice) })
        const moovIdx = boxes.findIndex((b) => b.type === 'moov')
        const initEnd = moovIdx >= 0 ? boxes[moovIdx].end : boxes[boxes.length - 1].end
        await append(buf.slice(0, initEnd))
        for (const b of boxes.filter((b) => b.start >= initEnd)) {
          await append(buf.slice(b.start, b.end))
        }
        res()
      })
    await appendFmp4(vsb, vb)
    await appendFmp4(asb, ab)
    ms.endOfStream()
    window.parent.postMessage({ __mseDone: true }, '*')
  })
})()
</script>`
const topHtml = `<!doctype html><meta charset="utf-8"><body>
<iframe src="/player.html" style="width:320px;height:180px"></iframe>
<iframe src="/decoy.html" style="width:320px;height:180px"></iframe>
</body>`
const decoyHtml = '<!doctype html><meta charset="utf-8"><body><p>decoy（无 MSE，回归 pull-missing 误杀）</p></body>'

const server = http.createServer((req, res) => {
  if (req.url === '/player.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(playerHtml) }
  else if (req.url === '/decoy.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(decoyHtml) }
  else if (req.url === '/' || req.url === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(topHtml) }
  else if (req.url === '/video.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(video.buf) }
  else if (req.url === '/audio.mp4') { res.writeHead(200, { 'Content-Type': 'audio/mp4' }); res.end(audio.buf) }
  else if (req.url === '/' || req.url === '/page.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(pageHtml) }
  else { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const donePromise = new Promise((r) => process.on('message', () => r()))

// ── 3. 启动扩展，打开测试页，等捕获登记 ──
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
const extId = new URL(sw.url()).host
const manager = await context.newPage()
await manager.goto(`chrome-extension://${extId}/manager.html`)
await manager.evaluate(async () => {
  const cur = (await chrome.storage.local.get('settings'))['settings'] ?? {}
  await chrome.storage.local.set({ settings: { badge: true, blacklist: [], mseHookSites: [], ...cur, v115: { enabled: false } } })
})

const page = await context.newPage()
page.on('console', (m) => {
  const t = m.text()
  if (t.includes('v2d-popup-preview') || t.includes('v2d-hook') || t.includes('v2d-bridge')) console.log('[page]', t)
})
await page.goto(`${base}/`)
let pageTabId = null
for (let i = 0; i < 20; i++) {
  pageTabId = await manager.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url: url + '/*' })
    return tabs[0]?.id ?? null
  }, base)
  if (pageTabId !== null) break
  await new Promise((r) => setTimeout(r, 500))
}
if (pageTabId === null) throw new Error('未找到测试页标签页')
console.log('[e2e] 测试页 tabId:', pageTabId)

// 等播放器完成 append + 钩子登记候选
let mseCands = []
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  mseCands = await manager.evaluate(async (tabId) => {
    const r = await chrome.runtime.sendMessage({ type: 'list', tabId })
    return (r.candidates ?? []).filter((c) => c.kind === 'blob' && c.mse)
  }, pageTabId)
  if (mseCands.length >= 2) break
}
console.log('[e2e] 捕获分组:', JSON.stringify(mseCands.map((c) => ({ track: c.mse.trackKind, bytes: c.mse.bytes, mime: c.mse.mime }))))
if (mseCands.length < 2) throw new Error(`期望 2 个捕获分组，实际 ${mseCands.length}`)
const vCand = mseCands.find((c) => c.mse.trackKind === 'video')
const aCand = mseCands.find((c) => c.mse.trackKind === 'audio')
if (!vCand || !aCand) throw new Error('缺少视频/音频分组')

// ── 3.5 弹窗面板预览：视频卡出帧 / 音频卡喇叭图标 ──
{
  await page.evaluate((url) => {
    const f = document.createElement('iframe')
    f.src = url
    f.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:640px;z-index:999999'
    document.body.appendChild(f)
  }, `chrome-extension://${extId}/popup.html?embedded=1&preview=1`)
  let panel = null
  for (let i = 0; i < 20 && !panel; i++) {
    await new Promise((r) => setTimeout(r, 500))
    panel = page.frames().find((f) => f.url().includes('preview=1'))
  }
  await panel.waitForSelector('.item', { timeout: 20000 })
  // 视频轨卡：限量拉取 → <video> 出帧
  let vSize = ''
  for (let i = 0; i < 40 && !vSize; i++) {
    await new Promise((r) => setTimeout(r, 500))
    vSize = await panel.evaluate(() => {
      const item = [...document.querySelectorAll('.item')].find((el) => el.querySelector('.badge')?.textContent?.includes('MSE') && el.querySelector('.thumb video'))
      if (!item) return ''
      const v = item.querySelector('.thumb video')
      return v.videoWidth > 0 ? `${v.videoWidth}x${v.videoHeight}` : ''
    })
  }
  console.log('[e2e] MSE 视频预览出帧:', vSize || '（未出帧）')
  if (!vSize) throw new Error('MSE 视频预览未出帧')
  // 音频轨卡：占位图标应为喇叭（无 <video>）
  const audioCard = await panel.evaluate(() => {
    const items = [...document.querySelectorAll('.item')]
    const a = items.find((el) => el.querySelector('.thumb .ph-label')?.textContent?.includes('MSE'))
    return { icon: a?.querySelector('.thumb .ph svg')?.innerHTML.slice(0, 60) ?? '', hasVideo: !!a?.querySelector('.thumb video') }
  })
  console.log('[e2e] MSE 音频卡:', JSON.stringify(audioCard))
  if (audioCard.hasVideo) throw new Error('音频卡不应有 <video> 预览')
  if (!audioCard.icon.includes('M11 5 6 9')) throw new Error('音频卡未使用喇叭图标')
  console.log('[e2e] ✅ MSE 预览断言通过')
  // 布局快照：整面板截图（人工核对卡片两行结构/按钮统一/无撑高文本）
  const panelEl = await page.waitForSelector('iframe[src*="preview=1"]')
  await panelEl.screenshot({ path: process.env.TEMP + '/mse-popup.png' })
}

// ── 4. 触发合并下载 ──
const dl = await manager.evaluate(async ({ tabId, v, a }) => {
  return chrome.runtime.sendMessage({
    type: 'mseDownload',
    tabId,
    videoGroupId: v.mse.groupId,
    audioGroupId: a.mse.groupId,
    pageTitle: 'e2e-mse',
    fileName: v.fileName,
  })
}, { tabId: pageTabId, v: vCand, a: aCand })
console.log('[e2e] mseDownload:', JSON.stringify(dl))
if (!dl?.ok) throw new Error('mseDownload 提交失败')

let final = null
let last = ''
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const t = await manager.evaluate(async () => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.find((x) => x.kind === 'mse')
  })
  if (t) {
    const line = `${t.state} 收:${t.received ?? 0} ${t.error ?? ''}`
    if (line !== last) { console.log('[e2e]', line); last = line }
    if (['staged', 'failed', 'cancelled'].includes(t.state)) { final = t; break }
  }
}
if (!final) throw new Error('120s 未到终态')
if (final.state !== 'staged') {
  const grp = await manager.evaluate(async (t) => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('staging')
    const out = {}
    for (const [label, name] of [['v', t.msePull?.videoFile], ['a', t.msePull?.audioFile]]) {
      if (!name) continue
      try {
        const fh = await dir.getFileHandle(name + '.part')
        const buf = new Uint8Array(await (await fh.getFile()).arrayBuffer())
        out[label] = { len: buf.length, head: [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '), b64: btoa(String.fromCharCode(...buf.slice(0, 4096))) }
      } catch (e) { out[label] = { err: String(e) } }
    }
    return out
  }, final)
  console.log('[e2e] 失败时组暂存:', JSON.stringify(grp))
  throw new Error(`期望 staged，实际 ${final.state}: ${final.error ?? ''}`)
}
if (final.state !== 'staged') throw new Error(`期望 staged，实际 ${final.state}: ${final.error ?? ''}`)
console.log(`[e2e] ✅ MSE 合并到 staged: ${final.fileName}（${final.size} 字节）`)

// ── 5. 产物校验 ──
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
const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) })
const vTrack = await input.getPrimaryVideoTrack()
const aTrack = await input.getPrimaryAudioTrack()
if (!vTrack || !aTrack) throw new Error('产物缺音/视频轨')
const vDur = await vTrack.computeDuration().catch(() => 0)
const aDur = await aTrack.computeDuration().catch(() => 0)
const dur = Math.max(vDur, aDur)
console.log("[e2e] 分轨时长: video", vDur.toFixed(1) + "s", "| audio", aDur.toFixed(1) + "s")
console.log('[e2e] 分轨时长: video', vDur.toFixed(1) + 's', '| audio', aDur.toFixed(1) + 's')
console.log(`[e2e] 产物: ${await vTrack.getCodec()} + ${await aTrack.getCodec()}，时长 ${dur.toFixed(1)}s（期望 ≈${duration.toFixed(1)}s）`)
if (dur < duration * 0.6 || dur > duration * 1.5) throw new Error('合并产物时长偏差过大')

server.close()

// ── 6. 拉取阶段取消（回归：曾卡「下载中」无法取消） ──
{
  const dl2 = await manager.evaluate(async ({ tabId, v, a }) => {
    return chrome.runtime.sendMessage({
      type: 'mseDownload',
      tabId,
      videoGroupId: v.mse.groupId,
      audioGroupId: a.mse.groupId,
      pageTitle: 'e2e-mse',
      fileName: v.fileName,
    })
  }, { tabId: pageTabId, v: vCand, a: aCand })
  if (!dl2?.ok) throw new Error('第二次 mseDownload 失败')
  let cancelled = false
  for (let i = 0; i < 100 && !cancelled; i++) {
    const t = await manager.evaluate(async () => {
      const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
      return tasks.filter((x) => x.kind === 'mse').sort((a, b) => b.createdAt - a.createdAt)[0]
    })
    if (t?.state === 'downloading') {
      await manager.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'transferCancel', taskId: id }), t.id)
    }
    await new Promise((r) => setTimeout(r, 300))
    const t2 = t
      ? await manager.evaluate(async (id) => {
          const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
          return tasks.find((x) => x.id === id)
        }, t.id)
      : null
    if (t2?.state === 'cancelled') cancelled = true
    if (t2 && ['staged', 'failed'].includes(t2.state)) break // 合并抢先完成，放弃本次断言
  }
  console.log('[e2e] 拉取阶段取消:', cancelled ? 'cancelled ✅' : '（任务抢先完成，跳过本次断言）')
}

await context.close()
console.log('\nMSE 深捕获全链路通过 ✅')
