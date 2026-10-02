/**
 * 桌面 Chrome B站适配修复验证（真实页面全链路）：
 *   1. 打开 B站视频页 → 注入 popup 面板 iframe（悬浮球同款入口）
 *   2. 断言 DASH 候选 + 分辨率下拉可展开（修复①：qMenu 未挂 DOM）
 *   3. 选非默认清晰度 → 点下载 → 队列
 *   4. 断言任务走 dash 合并管线到达 staged（修复②：kind 映射丢 dash）
 *   5. 校验 OPFS 暂存产物：mp4 box 结构含 vide+soun 双轨（此前只会存视频轨裸流）
 *   6. 校验 DNR Referer 会话规则覆盖 bilivideo.com/cn（修复④）
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const EXT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url))
const BVID = 'BV1GJ411x7h7'
const TASK_ID = 'e2efixdash'

const context = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium', // 品牌 Chrome 137+ 已禁用 --load-extension，须用 playwright chromium
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})
context.serviceWorkers().forEach((sw) => sw.on('console', (m) => console.log('[SW]', m.text())))
let sw = context.serviceWorkers().find((s) => s.url().includes('chrome-extension'))
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 })
const extId = new URL(sw.url()).host
console.log('[e2e] 扩展 id:', extId)

// 管理页：当控制台用（轮询任务 / 读 DNR 规则 / 读 OPFS 产物）
const manager = await context.newPage()
await manager.goto(`chrome-extension://${extId}/manager.html`)
// 关掉设置页预置依赖，防止黑名单/角标设置缺省干扰
await manager.evaluate(async () => {
  const cur = (await chrome.storage.local.get('settings'))['settings'] ?? {}
  await chrome.storage.local.set({
    settings: { badge: true, blacklist: [], mseHookSites: [], ...cur, v115: { enabled: false } },
  })
})

// ── 1. 打开 B站视频页（首访可能拿不到 SSR playinfo，带 cookie 重载一次） ──
const page = await context.newPage()
await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(4000)
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const hasPlayinfo = await page.evaluate(() => {
  const p = /** @type {any} */ (window).__playinfo__
  return !!(p?.data?.dash?.video?.length || p?.dash?.video?.length)
})
console.log('[e2e] 页面 SSR __playinfo__:', hasPlayinfo)
if (!hasPlayinfo) console.log('[e2e] ⚠️ 无 playinfo（风控/改版），弹窗可能没有 DASH 候选')

// ── 2. 注入 popup 面板 iframe（与悬浮球面板同一入口 popup.html?embedded=1） ──
await page.evaluate((url) => {
  const f = document.createElement('iframe')
  f.src = url
  f.style.cssText = 'position:fixed;left:20px;top:20px;width:420px;height:640px;border:2px solid red;z-index:999999;background:#fff'
  document.body.appendChild(f)
}, `chrome-extension://${extId}/popup.html?embedded=1&e2e=1`)

let panel = null
for (let i = 0; i < 20 && !panel; i++) {
  await new Promise((r) => setTimeout(r, 500))
  panel = page.frames().find((f) => f.url().includes('popup.html?embedded=1&e2e=1'))
}
if (!panel) throw new Error('popup 面板 iframe 未加载（frames: ' + page.frames().map((f) => f.url()).join(' | ') + '）')
await panel.waitForSelector('.item', { timeout: 20000 })

const badge = await panel.locator('.item .badge').first().textContent()
const qLabel = await panel.locator('.split-quality span').first().textContent().catch(() => null)
console.log('[e2e] 候选类型:', badge, '| 默认清晰度:', qLabel)
if (badge !== 'DASH') throw new Error(`期望 DASH 候选，实际 ${badge}`)

// ── 2.5 DASH 视频预览出帧（previewable 放行 + 常驻 media Referer 规则） ──
const preview = await panel.evaluate(async () => {
  const v = document.querySelector('.item .thumb video')
  if (!v) return { found: false, size: '' }
  for (let i = 0; i < 60; i++) {
    if (v.videoWidth > 0) return { found: true, size: `${v.videoWidth}x${v.videoHeight}` }
    await new Promise((r) => setTimeout(r, 250))
  }
  return { found: true, size: '0x0' }
})
console.log('[e2e] DASH 预览:', JSON.stringify(preview))
if (!preview.found) throw new Error('DASH 候选未渲染 <video> 预览（previewable 未放行）')
if (preview.size === '0x0') throw new Error('DASH 预览 <video> 未出帧（常驻 Referer 规则未生效）')
console.log('[e2e] ✅ DASH 预览出帧')
// 布局快照：确认卡片两行结构（无「N 种清晰度」等元信息行）
const panelEl = await page.waitForSelector('iframe[src*="e2e=1"]')
await panelEl.screenshot({ path: process.env.TEMP + '/bili-popup.png' })

// ── 3. 分辨率下拉展开 + 切换（修复①验证点） ──
await panel.locator('.split-quality').first().click()
await panel.locator('.q-menu.open').waitFor({ state: 'visible', timeout: 3000 })
const options = await panel.locator('.q-menu.open .menu-item').allTextContents()
console.log('[e2e] 下拉清晰度项:', JSON.stringify(options))
if (options.length < 2) throw new Error('清晰度下拉应至少 2 项')
await panel.locator('.q-menu.open .menu-item').nth(1).click() // 选第二个（非默认最高）
const qLabel2 = await panel.locator('.split-quality span').first().textContent()
console.log('[e2e] 切换后清晰度:', qLabel2)
if (qLabel2 === qLabel) throw new Error('切换清晰度未生效')

// ── 4. 点下载 → 任务入队 ──
await panel.locator('.split-main').first().click()
await panel.waitForSelector('.toast.show', { timeout: 5000 }).catch(() => {})
console.log('[e2e] 已点击下载')

// ── 5. 轮询任务到 staged（修复②/③验证点：走 dash 合并管线且不被看门狗误杀） ──
let final = null
let last = ''
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const r = await manager.evaluate(async (id) => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.find((t) => t.id === id)
  }, TASK_ID).catch(() => null)
  // popup 提交的任务 id 未知，这里直接取队列最新一条 dash 任务
  const t = r ?? (await manager.evaluate(async () => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.find((x) => x.kind === 'dash')
  }))
  if (t) {
    const line = `${t.id} ${t.state} ${t.kind} 收:${t.received ?? 0}${t.size ? '/' + t.size : ''} ${t.error ?? ''}`
    if (line !== last) { console.log('[e2e]', line); last = line }
    if (['staged', 'done', 'failed', 'cancelled'].includes(t.state)) { final = t; break }
  }
}
if (!final) throw new Error('120 秒未到终态')
if (final.state !== 'staged') throw new Error(`期望 staged，实际 ${final.state}: ${final.error ?? ''}`)
console.log('[e2e] ✅ DASH 合并管线到达 staged，文件名:', final.fileName, '大小:', final.size)

// ── 6. 校验产物 box 结构：必须是含 vide+soun 双轨的 mp4 ──
const check = await manager.evaluate(async (id) => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('staging')
  const fh = await dir.getFileHandle(`${id}.part`)
  const file = await fh.getFile()
  const buf = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer())
  const type = (o) => String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7])
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
  const handlers = []
  const walk = (start, end) => {
    let o = start
    while (o + 8 <= end) {
      const dv = new DataView(buf.buffer, buf.byteOffset + o, 8)
      const size = dv.getUint32(0)
      if (size < 8 || o + size > end) break
      const t = type(o)
      if (t === 'hdlr') handlers.push(String.fromCharCode(buf[o + 16], buf[o + 17], buf[o + 18], buf[o + 19]))
      else if (CONTAINERS.has(t)) walk(o + 8, o + size)
      o += size
    }
  }
  walk(0, buf.length)
  return { size: file.size, handlers, brand: String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) }
}, final.id)
console.log('[e2e] 产物:', JSON.stringify(check))
if (check.brand !== 'isom' && check.brand !== 'mp42') throw new Error(`产物 brand 异常: ${check.brand}`)
if (!check.handlers.includes('vide')) throw new Error('产物缺视频轨')
if (!check.handlers.includes('soun')) throw new Error('产物缺音频轨（视频轨裸流未合并）——修复②未生效')

// ── 7. Referer 常驻会话规则（覆盖 bilivideo 域 + media/xhr 两类资源） ──
const dnrRule = await manager.evaluate(async () => {
  const rules = await chrome.declarativeNetRequest.getSessionRules()
  return (
    rules.find(
      (r) => r.action.type === 'modifyHeaders' && (r.condition.requestDomains ?? []).includes('bilivideo.com'),
    ) ?? null
  )
})
console.log('[e2e] DNR 规则:', JSON.stringify({ domains: dnrRule?.condition.requestDomains, types: dnrRule?.condition.resourceTypes }))
if (!dnrRule) throw new Error('未找到 bilivideo 的常驻 Referer 规则')
if (!(dnrRule.condition.resourceTypes ?? []).includes('media')) throw new Error('Referer 规则应覆盖 media（弹窗预览依赖）')

console.log('[e2e] ✅ 全部验证通过')
await context.close()
