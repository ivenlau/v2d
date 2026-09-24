/**
 * E2E 复现：转存链路是否打通。
 * 无 115 账号 —— 预期任务走到「失败（115 鉴权/目录错误）」即证明
 * popup→SW→offscreen→worker→事件回传 全链路可达。
 */
import http from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const ROOT = '/root/code/v2d'
const EXT = `${ROOT}/.output/chrome-mv3`
const PORT = 8899

// ── fixture：假 mp4（内容无所谓，扩展按扩展名分类） ──
mkdirSync(`${ROOT}/e2e/fixtures`, { recursive: true })
writeFileSync(`${ROOT}/e2e/fixtures/video.mp4`, Buffer.alloc(2 * 1024 * 1024, 7))
const pageHtml = `<!doctype html><html><body><video src="/video.mp4" controls></video></body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/video.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 2 * 1024 * 1024 })
    res.end(Buffer.alloc(2 * 1024 * 1024, 7))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(pageHtml)
})
await new Promise((r) => server.listen(PORT, r))
console.log('fixture server on', PORT)

// ── 启动带扩展的 Chromium ──
const context = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})

const swLogs = []
function attachSwConsole(sw) {
  sw.on('console', (msg) => {
    const line = `[SW] ${msg.text()}`
    swLogs.push(line)
    console.log(line)
  })
}
context.serviceWorkers().forEach(attachSwConsole)
context.on('serviceworker', (sw) => {
  console.log('[e2e] SW 出现:', sw.url())
  attachSwConsole(sw)
})

let sw = context.serviceWorkers().find((s) => s.url().includes('chrome-extension'))
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host
console.log('[e2e] extension id =', extId)

// ── 打开视频页（触发嗅探） ──
const videoPage = await context.newPage()
await videoPage.goto(`http://localhost:${PORT}/video.html`)
await videoPage.waitForTimeout(2500) // 引擎 A 登记请求

// ── 从扩展页驱动 transfer115 ──
const manager = await context.newPage()
await manager.goto(`chrome-extension://${extId}/manager.html`)
await manager.waitForTimeout(500)

const list = await manager.evaluate(async (port) => {
  const tabs = await chrome.tabs.query({ url: `http://localhost:${port}/*` })
  const tabId = tabs[0]?.id
  if (tabId === undefined) return { error: 'no tab' }
  const r = await chrome.runtime.sendMessage({ type: 'list', tabId })
  return { ...r, tabId }
}, PORT)
console.log('[e2e] 候选:', JSON.stringify(list?.candidates?.map((c) => ({ id: c.id, kind: c.kind, url: c.url.slice(0, 60) }))))
const cand = list?.candidates?.find((c) => c.kind === 'file')
if (!cand) {
  console.error('[e2e] ❌ 未嗅探到直链候选——嗅探引擎问题', JSON.stringify(list))
  await context.close()
  server.close()
  process.exit(1)
}

const submit = await manager.evaluate(async ({ tabId, id }) => {
  // E2E：直接写入启用状态（无头环境无法点设置页开关）
  await chrome.storage.local.set({
    settings: { badge: true, blacklist: [], mseHookSites: [], v115: { enabled: true } },
  })
  return chrome.runtime.sendMessage({ type: 'transfer115', tabId, id, pageTitle: 'e2e' })
}, { tabId: list.tabId, id: cand.id })
console.log('[e2e] transfer115 提交结果:', JSON.stringify(submit))

// ── 轮询任务状态 40s ──
let final = null
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await manager.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'transferList' })
    return r
  })
  const t = r?.tasks?.[0]
  if (t) {
    process.stdout.write(`\r[e2e] 任务状态: ${t.state} ${t.error ?? ''}          `)
    if (['done', 'failed', 'cancelled'].includes(t.state)) {
      final = t
      break
    }
  }
}
console.log('')
if (final) {
  console.log(`[e2e] ✅ 任务终态: ${final.state}\n  error: ${final.error ?? '（无）'}`)
  console.log('[e2e] 结论: 事件回传链路打通（popup→SW→offscreen→worker→事件）' )
} else {
  console.log('[e2e] ❌ 40 秒内任务未到终态——链路确实卡死')
}

await context.close()
server.close()
