/**
 * Offscreen 宿主桥（§3.1）：runtime 消息 ↔ worker。
 *  - SW 发 v2d/offscreen-start / v2d/offscreen-cancel
 *  - worker 事件经 runtime.sendMessage('v2d/task-event') 回 SW 与 popup
 *  - 本地保存：Chrome = 读 OPFS 建 blob URL 交 SW 走 chrome.downloads；
 *    Safari = 通知 SW 进入待保存态，管理页按钮以用户手势取 blob URL 触发 <a download>
 */

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const blobUrls = new Map<string, string>()
/** 已转发 start、尚未看到终态的任务（worker 崩溃时统一标失败用） */
const activeTasks = new Set<string>()

// Worker 资产加载失败/顶层异常目前是「静默死亡」：postMessage 不报错、事件永不到来。
// 必须在此捕获并显式上报，否则任务永远停在「下载中」。
worker.addEventListener('error', (e) => {
  const msg = `传输 Worker 崩溃: ${e.message || '未知错误（脚本加载失败?）'}`
  console.error('[V2D offscreen]', msg)
  for (const taskId of [...activeTasks]) {
    activeTasks.delete(taskId)
    void chrome.runtime
      .sendMessage({ type: 'v2d/task-event', taskId, state: 'failed', error: msg })
      .catch(() => {})
  }
})
worker.addEventListener('messageerror', () => {
  console.error('[V2D offscreen] worker messageerror（消息反序列化失败）')
})

worker.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as
    | { type?: string; taskId?: string; fileName?: string; size?: number; state?: string }
    | undefined
  if (data?.type === 'v2d/task-event' && data.taskId) {
    // 终态任务移出活跃表
    if (data.state === 'done' || data.state === 'failed' || data.state === 'cancelled') {
      activeTasks.delete(data.taskId)
    }
  }
  if (data?.type === 'v2d/task-staged' && data.taskId) {
    const taskId: string = data.taskId
    // 平台分叉：Chrome 有 downloads API → 自动走 SW 保存；Safari 无 downloads →
    // 通知 SW 进入待保存态，由管理页/弹窗按钮以用户手势触发 <a download>
    if (import.meta.env.CHROME) {
      void (async () => {
        try {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('staging')
          const fh = await dir.getFileHandle(`${taskId}.part`)
          const file = await fh.getFile()
          const blobUrl = URL.createObjectURL(file)
          blobUrls.set(taskId, blobUrl)
          await chrome.runtime.sendMessage({
            type: 'v2d/task-blob',
            taskId,
            blobUrl,
            fileName: data.fileName,
          })
        } catch (err) {
          await chrome.runtime
            .sendMessage({
              type: 'v2d/task-event',
              taskId,
              state: 'failed',
              error: `暂存文件读取失败: ${String(err)}`,
            })
            .catch(() => {})
        }
      })()
    } else {
      void chrome.runtime
        .sendMessage({
          type: 'v2d/task-staged-ready',
          taskId,
          fileName: data.fileName,
          size: data.size,
        })
        .catch(() => {})
    }
    return
  }
  void chrome.runtime.sendMessage(data).catch(() => {
    /* SW 休眠时事件会丢；任务终态靠 SW 恢复逻辑兜底 */
  })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'v2d/offscreen-start') {
    console.log('[V2D offscreen] 收到启动任务', msg.task?.id, msg.task?.kind, msg.task?.dest)
    activeTasks.add(msg.task.id)
    worker.postMessage({ type: 'start', task: msg.task })
    sendResponse({ ok: true })
  } else if (msg?.type === 'v2d/offscreen-cancel') {
    worker.postMessage({ type: 'cancel', taskId: msg.taskId })
    sendResponse({ ok: true })
  } else if (msg?.type === 'v2d/offscreen-pause') {
    worker.postMessage({ type: 'pause', taskId: msg.taskId })
    sendResponse({ ok: true })
  } else if (msg?.type === 'v2d/dispose-file') {
    void (async () => {
      const url = blobUrls.get(msg.taskId)
      if (url) {
        URL.revokeObjectURL(url)
        blobUrls.delete(msg.taskId)
      }
      try {
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('staging')
        await dir.removeEntry(`${msg.taskId}.part`)
      } catch {
        /* ignore */
      }
    })()
    sendResponse({ ok: true })
  } else if (msg?.type === 'getStagedBlob') {
    // Safari：管理页/弹窗请求待保存产物的 blob URL（可从 OPFS 重建，SW 重启后仍可保存）
    void (async () => {
      let url = blobUrls.get(msg.taskId)
      try {
        if (!url) {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('staging')
          const fh = await dir.getFileHandle(`${msg.taskId}.part`)
          const file = await fh.getFile()
          url = URL.createObjectURL(file)
          blobUrls.set(msg.taskId, url)
        }
        sendResponse({ ok: true, blobUrl: url, fileName: msg.fileName })
      } catch (err) {
        sendResponse({ ok: false, error: `暂存文件读取失败: ${String(err)}` })
      }
    })()
    return true
  }
  return false
})

export {}
