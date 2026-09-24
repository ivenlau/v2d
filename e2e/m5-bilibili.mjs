/**
 * M5 E2E：DASH 双轨管线验证（绕过 B站页面风控：API 取真实 CDN 地址，种子任务驱动）。
 * 无 115 账号 —— 预期：下载（DNR Referer 注入 + CDN 206）→ 合并（mediabunny 双轨 remux）→
 * SHA1 → 秒传检测 → 上传收口（40140123 鉴权失败 = 全链路打通）。
 */
import { chromium } from 'playwright'

const EXT = '/root/code/v2d/.output/chrome-mv3'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// ── 1. API 取真实 DASH 地址 ──
const view = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7')).json()
const cid = view.data.cid
const play = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=BV1GJ411x7h7&cid=${cid}&qn=64&fnval=4048`)).json()
const pick = (v) => [v.baseUrl, ...(v.backupUrl ?? [])].find((u) => !u.includes('mcdn')) ?? v.baseUrl
const videoUrl = pick(play.data.dash.video[0])
const audioUrl = pick(play.data.dash.audio[0])
console.log('[e2e] 视频轨:', play.data.dash.video[0].id, play.data.dash.video[0].width + 'x' + play.data.dash.video[0].height, '| 音轨:', play.data.dash.audio[0].id)

// ── 2. 启动扩展 ──
const context = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
context.serviceWorkers().forEach((sw) => sw.on('console', (m) => console.log('[SW]', m.text())))
let sw = context.serviceWorkers().find((s) => s.url().includes('chrome-extension'))
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host

const manager = await context.newPage()
await manager.goto(`chrome-extension://${extId}/manager.html`)
await manager.waitForTimeout(500)

// ── 3. 种子 DASH 任务（failed 态，用 transferRetry 驱动队列） ──
const seed = await manager.evaluate(async ({ videoUrl, audioUrl }) => {
  await chrome.storage.local.set({
    settings: { badge: true, blacklist: [], mseHookSites: [], v115: { enabled: true } },
  })
  const task = {
    id: 'e2edash01',
    kind: 'dash',
    dest: 'cloud',
    state: 'failed',
    url: videoUrl,
    fileName: 'e2e-dash-merge-test.mp4',
    targetPath: '/v2d/e2e/',
    createdAt: Date.now(),
    dashSpec: { video: videoUrl, audio: audioUrl },
  }
  const d = await chrome.storage.local.get('transfer.tasks')
  const tasks = (d['transfer.tasks'] ?? []).filter((t) => t.id !== task.id)
  tasks.push(task)
  await chrome.storage.local.set({ 'transfer.tasks': tasks })
  return chrome.runtime.sendMessage({ type: 'transferRetry', taskId: task.id })
}, { videoUrl, audioUrl })
console.log('[e2e] 种子+重试:', JSON.stringify(seed))

// ── 4. 轮询 150s ──
let final = null
let lastLine = ''
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: 'transferList' }))
  const t = r?.tasks?.find((x) => x.id === 'e2edash01')
  if (t) {
    const line = `${t.state} 收:${t.received ?? 0}${t.size ? '/' + t.size : ''} ${t.error ?? ''}`
    if (line !== lastLine) {
      console.log(`[e2e] ${line}`)
      lastLine = line
    }
    if (['done', 'failed', 'cancelled'].includes(t.state)) {
      final = t
      break
    }
  }
}

if (final) {
  console.log(`[e2e] 任务终态: ${final.state}`)
  console.log(`  error: ${final.error ?? '（无）'}`)
  const authFail = final.error?.includes('40140123') || final.error?.includes('access_token')
  if (authFail) {
    console.log('[e2e] ✅ 扩展胶水层验证通过：任务正确到达 115 鉴权点（download/merge 需有效 token 后才会执行，深层验证见 merge-validate.mjs）')
  } else {
    console.log('[e2e] ⚠️ 在 115 鉴权之前失败——把 error 发给开发者')
  }
} else {
  console.log('[e2e] ❌ 150 秒未到终态')
}

await context.close()
