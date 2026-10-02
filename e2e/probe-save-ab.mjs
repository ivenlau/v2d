/**
 * A/B 对照：管理页保存流程唯一的实质差异 = a.click() 后删 OPFS 暂存的时机。
 *   A 组：点击后等 8s 再删（≈弹窗路径的延迟删除）
 *   B 组：点击后立刻删（= manager saveStagedById 现状）
 * 观测 chrome.downloads 的 state/error。
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const EXT = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url))
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

async function pipelineToStaged(tag) {
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
  }, `chrome-extension://${extId}/popup.html?embedded=1&run=${tag}`)
  let panel = null
  for (let i = 0; i < 20 && !panel; i++) {
    await new Promise((r) => setTimeout(r, 500))
    panel = page.frames().find((f) => f.url().includes(`run=${tag}`))
  }
  await panel.waitForSelector('.item', { timeout: 20000 })
  await panel.locator('.split-main').first().click()
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const t = await manager.evaluate(async () => {
      const { tasks = [] } = await chrome.runtime.sendMessage({ type: 'transferList' })
      return tasks.filter((x) => x.kind === 'dash' && x.dest === 'local').sort((a, b) => b.createdAt - a.createdAt)[0]
    })
    if (t?.state === 'staged') { await page.close(); return t.id }
    if (t?.state === 'failed') throw new Error(`[${tag}] 失败: ${t.error}`)
  }
  throw new Error(`[${tag}] 未到 staged`)
}

async function abSave(taskId, delayMs) {
  // 在管理页内联复刻保存序列，唯一变量 = removeEntry 的延迟
  return manager.evaluate(async ({ taskId, delayMs }) => {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('staging')
    const fh = await dir.getFileHandle(`${taskId}.part`)
    const file = await fh.getFile()
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = `ab-${delayMs}ms.mp4`
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    await dir.removeEntry(`${taskId}.part`).catch(() => {})
    return file.size
  }, { taskId, delayMs })
}

const lastRec = () =>
  manager.evaluate(async () => {
    const [r] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 })
    return { state: r?.state, error: r?.error ?? '-', name: r?.filename.split('\\').pop() }
  })

for (const [tag, delay] of [['A-delay8s', 8000], ['B-immediate', 0]]) {
  console.log(`\n════ ${tag}（删除延迟 ${delay}ms）════`)
  const taskId = await pipelineToStaged(tag)
  const size = await abSave(taskId, delay)
  await new Promise((r) => setTimeout(r, 8000))
  console.log(`[${tag}] 暂存文件 ${size} 字节 → 下载记录:`, JSON.stringify(await lastRec()))
}

await context.close()
console.log('\nA/B 完成')
