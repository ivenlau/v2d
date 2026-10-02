/**
 * 保存收口 + DASH 进度修复验证（真实 B站视频）：
 *   1. 下载期进度采样：downloading 阶段应出现多次 received 递增 + speedBps>0 + size 已知
 *      （修复前整个下载期 received 恒 0，只在轨道完成时跳变）
 *   2. popup 任务行显示「轨道 x/2」而非「分段」
 *   3. 管理页「保存到文件」：Chrome 下载 complete、任务 done、暂存文件删除（修复前 NETWORK_FAILED）
 *   4. 弹窗「保存到文件」：同上
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const EXT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url))
const BVID = 'BV1GJ411x7h7'

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

const getTask = (id) =>
  manager.evaluate(async (id) => {
    const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
    return tasks.find((x) => x.id === id)
  }, id)

/** 走一遍真实 pipeline 到 staged；期间采样下载进度并断言弹窗任务行文案 */
async function pipelineToStaged(tag, { sample = false } = {}) {
  const page = await context.newPage()
  await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(3000)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(4000)
  await page.evaluate((url) => {
    const f = document.createElement('iframe')
    f.src = url
    f.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:640px;z-index:999999'
    document.body.appendChild(f)
  }, `chrome-extension://${extId}/popup.html?embedded=1&run=${tag}`)
  let panel = null
  for (let i = 0; i < 20 && !panel; i++) {
    await new Promise((r) => setTimeout(r, 500))
    panel = page.frames().find((f) => f.url().includes(`run=${tag}`))
  }
  await panel.waitForSelector('.item', { timeout: 20000 })
  await panel.locator('.split-main').first().click()

  const samples = []
  let metaTexts = []
  let taskId = null
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, sample ? 400 : 1000))
    const t = await manager.evaluate(async () => {
      const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
      return tasks.filter((x) => x.kind === 'dash' && x.dest === 'local').sort((a, b) => b.createdAt - a.createdAt)[0]
    })
    if (!t) continue
    taskId = t.id
    if (sample && t.state === 'downloading') {
      samples.push({ received: t.received ?? 0, size: t.size ?? 0, speed: t.speedBps ?? 0 })
      metaTexts.push(...(await panel.locator('.task .task-meta').allTextContents()))
    }
    if (t.state === 'staged') break
    if (t.state === 'failed') throw new Error(`[${tag}] 失败: ${t.error}`)
  }
  if (!taskId) throw new Error(`[${tag}] 无任务`)
  await page.close()
  return { taskId, samples, metaTexts }
}

// ═══ 1+2: 下载期进度采样 + 轨道文案 ═══
console.log('════ 进度采样 + 轨道文案 ════')
const first = await pipelineToStaged('run1', { sample: true })
const positive = first.samples.filter((s) => s.received > 0)
const withSpeed = first.samples.filter((s) => s.speed > 0)
const knownSize = first.samples.filter((s) => s.size > 0 && s.received > 0 && s.received < s.size)
console.log(`[e2e] downloading 期采样 ${first.samples.length} 个：received>0 ${positive.length} 个，speed>0 ${withSpeed.length} 个，0<received<size ${knownSize.length} 个`)
if (first.samples.length < 4) throw new Error('downloading 期采样过少——进度事件未接通')
if (positive.length < 3) throw new Error('received 未随下载递增——进度事件未接通')
if (!withSpeed.length) throw new Error('无速度上报')
if (!knownSize.length) throw new Error('无「部分完成且 total 已知」样本——size 未预探测')
const trackLabels = first.metaTexts.filter((m) => m.includes('轨道'))
const segLabels = first.metaTexts.filter((m) => m.includes('分段'))
console.log(`[e2e] 弹窗任务行文案：含「轨道」${trackLabels.length} 条，含「分段」${segLabels.length} 条`)
if (!trackLabels.length) throw new Error('弹窗未显示「轨道」文案')
if (segLabels.length) throw new Error('弹窗仍在显示「分段」文案')
console.log(`[e2e] 样本示例: ${JSON.stringify(first.samples.slice(2, 5))}`)
const t1 = await getTask(first.taskId)
console.log(`[e2e] ✅ 进度修复验证通过 (staged: ${t1.state}, ${t1.size} bytes)`)

// ═══ 3: 管理页保存到文件 ═══
console.log('\n════ 管理页保存 ════')
await manager.locator(`[data-task-id="${first.taskId}"] .actions .btn.primary`).click()
let rec3 = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const t = await getTask(first.taskId)
  if (t?.state === 'done' || t?.state === 'failed' || t?.state === 'staged') {
    rec3 = (await manager.evaluate(async () => {
      const recs = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 3 })
      return recs[0] ? { state: recs[0].state, error: recs[0].error ?? '-', url: recs[0].url.slice(0, 40) } : null
    }))
    if (t.state !== 'saving') {
      console.log(`[e2e] 任务态: ${t.state} | 下载记录: ${JSON.stringify(rec3)}`)
      break
    }
  }
}
const final3 = await getTask(first.taskId)
if (final3.state !== 'done') throw new Error(`管理页保存后任务态=${final3.state}，error=${final3.error}`)
if (rec3?.state !== 'complete') throw new Error(`Chrome 下载未完成: ${JSON.stringify(rec3)}（修复前是 interrupted/NETWORK_FAILED）`)
// dispose 可能要重新拉起 offscreen 宿主——轮询等待清理
let opfs3 = '存在'
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 500))
  opfs3 = await manager.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory()
    try { await (await root.getDirectoryHandle('staging')).getFileHandle(`${id}.part`); return '存在' } catch { return '已删除' }
  }, first.taskId)
  if (opfs3 !== '存在') break
}
console.log(`[e2e] ✅ 管理页保存：下载 complete、任务 done、暂存文件${opfs3}`)
if (opfs3 !== '已删除') throw new Error('暂存文件未清理')

// ═══ 4: 弹窗保存到文件 ═══
console.log('\n════ 弹窗保存 ════')
const second = await pipelineToStaged('run2')
const page2 = await context.newPage()
await page2.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page2.evaluate((url) => {
  const f = document.createElement('iframe')
  f.src = url
  f.style.cssText = 'position:fixed;left:10px;top:10px;width:420px;height:640px;z-index:999999'
  document.body.appendChild(f)
}, `chrome-extension://${extId}/popup.html?embedded=1&save2=1`)
let panel2 = null
for (let i = 0; i < 20 && !panel2; i++) {
  await new Promise((r) => setTimeout(r, 500))
  panel2 = page2.frames().find((f) => f.url().includes('save2=1'))
}
await panel2.waitForSelector('.task .mini-btn', { timeout: 20000 })
const saveBtn = panel2.locator('.task .mini-btn', { hasText: '保存到文件' }).first()
await saveBtn.click()
let rec4 = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const t = await getTask(second.taskId)
  if (t && t.state !== 'saving' && t.state !== 'staged') {
    rec4 = (await manager.evaluate(async () => {
      const recs = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 3 })
      return recs[0] ? { state: recs[0].state, error: recs[0].error ?? '-' } : null
    }))
    console.log(`[e2e] 任务态: ${t.state} | 下载记录: ${JSON.stringify(rec4)}`)
    break
  }
}
const final4 = await getTask(second.taskId)
if (final4.state !== 'done') throw new Error(`弹窗保存后任务态=${final4.state}，error=${final4.error}`)
if (rec4?.state !== 'complete') throw new Error(`弹窗保存 Chrome 下载未完成: ${JSON.stringify(rec4)}`)
console.log('[e2e] ✅ 弹窗保存：下载 complete、任务 done')

await context.close()
console.log('\n全部通过 ✅')
