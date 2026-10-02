/**
 * 队列衔接 + 取消修复验证（--disable-http-cache 保证真实下载时长）：
 *   1. task A staged 后，retry 出的 B 应立即被泵拉起（修复前等 ~120s 看门狗）
 *   2. 排队中的 C（B 下载期间）取消 → 立即 cancelled（修复前无效果、之后照常下载）
 *   3. 下载中的 B 取消 → cancelled（回归）
 *   4. popup × 对 staged 的 A → 任务删除（修复前空操作）
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const EXT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url))
const context = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--disable-http-cache'],
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

const getTask = (id) =>
  manager.evaluate(async (id) => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.find((x) => x.id === id)
  }, id)

// 确定性窗口：B 用不可路由地址让 fetch 挂起（永远「下载中」），C 稳定处于「排队中」。
// 网络快慢不再影响测试；B 的挂起 fetch 同样可被取消中断（AbortController）。
const hangSpec = { video: 'http://10.255.255.1/v.m4s' }

// ── task A：真实 pipeline 到 staged（popup 下载） ──
const page = await context.newPage()
await page.goto('https://www.bilibili.com/video/BV1GJ411x7h7/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(3000)
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(4000)
await page.evaluate((url) => {
  const f = document.createElement('iframe')
  f.src = url
  f.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:640px;z-index:999999'
  document.body.appendChild(f)
}, `chrome-extension://${extId}/popup.html?embedded=1&run=qa`)
let panel = null
for (let i = 0; i < 20 && !panel; i++) {
  await new Promise((r) => setTimeout(r, 500))
  panel = page.frames().find((f) => f.url().includes('run=qa'))
}
await panel.waitForSelector('.item', { timeout: 20000 })
await panel.locator('.split-main').first().click()
let taskA = null
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  taskA = await manager.evaluate(async () => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.filter((x) => x.kind === 'dash' && x.dest === 'local').sort((a, b) => b.createdAt - a.createdAt)[0]
  })
  if (taskA?.state === 'staged') break
}
if (taskA?.state !== 'staged') throw new Error(`task A 未到 staged: ${taskA?.state}`)
console.log(`[e2e] task A staged ✅ (${taskA.fileName})`)

// ── 种 failed 的 B → retry：B 应立即被泵拉起 ──
const seed = (id) =>
  manager.evaluate(async ({ id, spec }) => {
    const task = {
      id, kind: 'dash', dest: 'local', state: 'failed',
      url: spec.video, fileName: `${id}.mp4`, targetPath: '/v2d/e2e/',
      createdAt: Date.now(), dashSpec: spec,
    }
    const d = await chrome.storage.local.get('transfer.tasks')
    const list = (d['transfer.tasks'] ?? []).filter((t) => t.id !== id)
    list.push(task)
    await chrome.storage.local.set({ 'transfer.tasks': list })
    return chrome.runtime.sendMessage({ type: 'transferRetry', taskId: id })
  }, { id: 'e2eQueB', spec: hangSpec })
await seed('e2eQueB')

let pickedUp = false
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const b = await getTask('e2eQueB')
  if (b && b.state !== 'queued' && b.state !== 'failed') {
    pickedUp = true
    console.log(`[e2e] B 在 ${i + 1}s 内被泵拉起 → ${b.state} ✅`)
    break
  }
}
if (!pickedUp) throw new Error('B 超过 15s 未被拉起——队列仍被阻塞')

// ── 种 C → retry → queued（B 下载中占用队列）→ 排队期取消 ──
await manager.evaluate(async ({ id, spec }) => {
  const task = {
    id, kind: 'dash', dest: 'local', state: 'failed',
    url: spec.video, fileName: `${id}.mp4`, targetPath: '/v2d/e2e/',
    createdAt: Date.now(), dashSpec: spec,
  }
  const d = await chrome.storage.local.get('transfer.tasks')
  const list = (d['transfer.tasks'] ?? []).filter((t) => t.id !== id)
  list.push(task)
  await chrome.storage.local.set({ 'transfer.tasks': list })
  return chrome.runtime.sendMessage({ type: 'transferRetry', taskId: id })
}, { id: 'e2eQueC', spec: hangSpec })
await new Promise((r) => setTimeout(r, 1000))
const cBefore = await getTask('e2eQueC')
console.log(`[e2e] 取消前 C 状态: ${cBefore?.state}`)
if (cBefore?.state !== 'queued') throw new Error(`C 应处于 queued，实际 ${cBefore?.state}（B 下载不够慢？）`)

await manager.evaluate(async () => chrome.runtime.sendMessage({ type: 'transferCancel', taskId: 'e2eQueC' }))
let cCancelled = false
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if ((await getTask('e2eQueC'))?.state === 'cancelled') { cCancelled = true; break }
}
if (!cCancelled) throw new Error(`排队中的 C 取消后状态=${(await getTask('e2eQueC'))?.state}（应为 cancelled）`)
console.log('[e2e] 排队中的 C 取消 → cancelled ✅')

// ── 下载中的 B 取消（回归；200ms 轮询尽快捕捉 downloading 态） ──
let bDownloading = false
for (let i = 0; i < 300 && !bDownloading; i++) {
  await new Promise((r) => setTimeout(r, 200))
  const st = (await getTask('e2eQueB'))?.state
  if (st === 'staged') break // 窗口错过，由下方断言给出明确报错
  bDownloading = st === 'downloading'
}
if (!bDownloading) throw new Error('B 未进入 downloading（10MB 下载窗口不应错过）')
await manager.evaluate(async () => chrome.runtime.sendMessage({ type: 'transferCancel', taskId: 'e2eQueB' }))
let bCancelled = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if ((await getTask('e2eQueB'))?.state === 'cancelled') { bCancelled = true; break }
}
if (!bCancelled) throw new Error(`下载中的 B 取消后状态=${(await getTask('e2eQueB'))?.state}`)
console.log('[e2e] 下载中的 B 取消 → cancelled ✅')

// ── popup × 对 staged 的 A → 删除 ──
await panel.locator('.task', { hasText: 'Rick Astley' }).locator('.task-cancel').click()
let aDeleted = false
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (!(await getTask(taskA.id))) { aDeleted = true; break }
}
if (!aDeleted) throw new Error(`popup × 后 staged 任务仍存在：${(await getTask(taskA.id))?.state}`)
console.log('[e2e] popup × 对 staged 任务 → 已删除 ✅')

await context.close()
console.log('\n全部通过 ✅')
