/**
 * Offscreen 宿主桥（§3.1）：runtime 消息 ↔ worker。
 *  - SW 发 v2d/offscreen-start / v2d/offscreen-cancel
 *  - worker 事件经 runtime.sendMessage('v2d/task-event') 回 SW 与 popup
 *  - 本地保存：统一进入待保存态，由弹窗（自动）/管理页按钮触发 <a download>（文件名受控）
 */

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
const blobUrls = new Map<string, string>()
/** 已转交「待保存」的任务：后续 worker 事件（迟到的下载/校验）一律丢弃，防状态回退 */
const stagedPosted = new Set<string>()
/** 已转发 start、尚未看到终态的任务（worker 崩溃时统一标失败用） */
const activeTasks = new Set<string>()
/** MSE 捕获落盘的暂存写句柄（本上下文无 SyncAccessHandle，用 createWritable 追加） */
const mseWriters = new Map<string, { w: FileSystemWritableFileStream; size: number }>()

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
    // 已转交待保存的任务：丢弃迟到事件（防状态回退）
    if (stagedPosted.has(data.taskId)) return
    // 终态任务移出活跃表
    if (data.state === 'done' || data.state === 'failed' || data.state === 'cancelled') {
      activeTasks.delete(data.taskId)
    }
  }
  if (data?.type === 'v2d/task-staged' && data.taskId) {
    const taskId: string = data.taskId
    stagedPosted.add(taskId)
    // 全平台统一进入待保存态：由弹窗（开着时自动）/管理页按钮触发 <a download>。
    // 不走 SW 的 downloads API + blob URL——那条路 filename 会被 Chromium 忽略，
    // 落成「随机 UUID」文件名（弹窗/管理页的 <a download> 文件名受控）
    void chrome.runtime
      .sendMessage({
        type: 'v2d/task-staged-ready',
        taskId,
        fileName: data.fileName,
        size: data.size,
      })
      .catch(() => {})
    return
  }
  void chrome.runtime.sendMessage(data).catch(() => {
    /* SW 休眠时事件会丢；任务终态靠 SW 恢复逻辑兜底 */
  })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'v2d/offscreen-start') {
    console.log('[V2D offscreen] 收到启动任务', msg.task?.id, msg.task?.kind, msg.task?.dest)
    stagedPosted.delete(msg.task.id)
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
    // 删完再响应：调用方（SW）收到响应后可能立即排空队列并关闭本文档——
    // 先响应再删会被 close 中途杀死，暂存文件泄漏（e2e 实测必现）
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
        /* 不存在/已删除 */
      }
      sendResponse({ ok: true })
    })()
    return true // 异步响应
  } else if (msg?.type === 'v2d/mse-stage-write') {
    // MSE 捕获数据块落盘（页面桥逐块等待本响应，天然串行）
    void (async () => {
      try {
        let entry = mseWriters.get(msg.file)
        if (!entry) {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('staging', { create: true })
          const fh = await dir.getFileHandle(`${msg.file}.part`, { create: true })
          const size = (await fh.getFile()).size
          const w = await fh.createWritable({ keepExistingData: true })
          await w.seek(size)
          entry = { w, size }
          mseWriters.set(msg.file, entry)
        }
        const chunk = Uint8Array.from(atob(msg.chunk), (c) => c.charCodeAt(0))
        await entry.w.write(chunk)
        entry.size += chunk.byteLength
        sendResponse({ ok: true })
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true
  } else if (msg?.type === 'v2d/mse-stage-close') {
    void (async () => {
      const entry = mseWriters.get(msg.file)
      if (entry) {
        mseWriters.delete(msg.file)
        try {
          await entry.w.close()
        } catch {
          /* ignore */
        }
      }
      sendResponse({ ok: true })
    })()
    return true
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
