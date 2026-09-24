/**
 * 传输队列（SW 侧协调，§3.1/§6）：串行执行（M2；并发设置 M4 引入）。
 *  - offline 通道：SW 内轻请求（add_task_urls → 自适应轮询；失败按策略降级 upload）
 *  - upload 通道：ensureOffscreen → worker 管线（OPFS 暂存 + SHA1 + 秒传/直传）
 * 任务元数据存 chrome.storage.local（M2 量级足够；M4 换 IndexedDB）。
 */

import type { MediaCandidate, V115Settings } from '@/core/types'
import { classifyLink } from '@/providers/115/offline'
import type { OfflineTask } from '@/providers/115/openapi'
import { offlineDone, offlineFailed } from '@/providers/115/openapi'
import { client115, TOKEN_STORAGE_KEY } from '@/providers/115/runtime'

export type TaskState =
  | 'queued'
  | 'offline-adding'
  | 'offline-polling'
  | 'downloading'
  | 'hashing'
  | 'checking'
  | 'uploading'
  | 'saving'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TransferTask {
  id: string
  kind: 'offline' | 'upload' | 'hls'
  /** cloud = 转存 115；local = 保存本地（hls 走队列） */
  dest: 'cloud' | 'local'
  state: TaskState
  url: string
  fileName: string
  targetPath: string
  pageTitle?: string
  /** hls：用户选择的清晰度（media playlist URL）；空 = 自动选最高 */
  variantUrl?: string
  size?: number
  /** downloading：已收字节；offline：percentDone 借用 uploaded 展示 */
  received?: number
  uploaded?: number
  speedBps?: number
  /** hls 分段进度 */
  segmentsDone?: number
  segmentsTotal?: number
  pickCode?: string
  instant?: boolean
  error?: string
  /** 直链断点续传：已收字节对应的 SHA1 中间状态（base64，hash-wasm save()） */
  hashStateB64?: string
  createdAt: number
  finishedAt?: number
}

const TASKS_KEY = 'transfer.tasks'
const MAX_TASKS = 50
const POLL_TIMEOUT_MS = 30 * 60_000

let tasks: TransferTask[] | null = null
let pumping = false
const cancelled = new Set<string>()
const uploadWaiters = new Map<string, () => void>()
let lastPersist = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function loadTasks(): Promise<TransferTask[]> {
  if (!tasks) {
    const obj = await chrome.storage.local.get(TASKS_KEY)
    tasks = (obj[TASKS_KEY] as TransferTask[] | undefined) ?? []
  }
  return tasks
}

async function persist(force = false): Promise<void> {
  if (!tasks) return
  const now = Date.now()
  if (!force && now - lastPersist < 1000) return
  lastPersist = now
  tasks = [...tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_TASKS).reverse()
  await chrome.storage.local.set({ [TASKS_KEY]: tasks })
}

export async function listTasks(): Promise<TransferTask[]> {
  return loadTasks()
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'unknown'
  }
}

/** 默认目标规则（§9.2 模板）：/来自浏览器/{host}/{YYYY-MM}/ */
function joinTargetPath(targetRoot: string | undefined, url: string): string {
  const base = (targetRoot?.trim() || '/来自浏览器').replace(/\/+$/, '')
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return `${base}/${safeHost(url)}/${ym}/`
}

function genTaskId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 从直链/磁力/ed2k 推断文件名（离线彩蛋任务展示用） */
function fileNameFromLink(url: string): string {
  if (url.startsWith('magnet:')) {
    const dn = /[?&]dn=([^&]+)/.exec(url)
    if (dn) {
      try {
        return decodeURIComponent(dn[1])
      } catch {
        return dn[1]
      }
    }
    return '离线任务-' + url.slice(0, 40)
  }
  if (url.startsWith('ed2k://')) {
    const parts = url.split('|')
    return parts[2] || '离线任务'
  }
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(seg) || '离线任务'
  } catch {
    return '离线任务'
  }
}

/** 手动彩蛋：提交 115 离线任务（直链/磁力/ed2k） */
export async function enqueueOffline(url: string, settings: V115Settings): Promise<TransferTask> {
  if (!classifyLink(url)) {
    throw new Error('无法识别的链接：支持 http(s) 直链、magnet、ed2k')
  }
  const base = (settings.targetRoot?.trim() || '/来自浏览器').replace(/\/+$/, '')
  const task: TransferTask = {
    id: genTaskId(),
    kind: 'offline',
    dest: 'cloud',
    state: 'queued',
    url: url.trim(),
    fileName: fileNameFromLink(url.trim()),
    targetPath: `${base}/离线任务/`,
    createdAt: Date.now(),
  }
  const all = await loadTasks()
  all.push(task)
  await persist(true)
  void pump()
  return task
}

export async function enqueueTransfer(
  cand: MediaCandidate,
  settings: V115Settings,
  pageTitle?: string,
  opts: { dest: 'cloud' | 'local'; variantUrl?: string } = { dest: 'cloud' },
): Promise<TransferTask> {
  // hls/dash 候选走合并管线（M3 支持 HLS；DASH 在 M5）；直链一律浏览器直传（秒传优先）
  const isHls = cand.kind === 'hls' || cand.kind === 'dash'
  const task: TransferTask = {
    id: genTaskId(),
    kind: isHls ? 'hls' : 'upload',
    dest: opts.dest,
    state: 'queued',
    url: cand.url,
    fileName: cand.fileName ?? 'video.mp4',
    targetPath: joinTargetPath(settings.targetRoot, cand.url),
    pageTitle,
    variantUrl: opts.variantUrl,
    createdAt: Date.now(),
  }
  const all = await loadTasks()
  all.push(task)
  await persist(true)
  void pump()
  return task
}

export async function cancelTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return false
  cancelled.add(taskId)
  if (
    task.state === 'downloading' || task.state === 'hashing' || task.state === 'uploading' ||
    task.state === 'queued' || task.state === 'paused'
  ) {
    if (task.state === 'paused') {
      // 暂停态无运行中的管线：直接标记取消
      task.state = 'cancelled'
      task.finishedAt = Date.now()
      await persist(true)
      void pump()
      return true
    }
    try {
      await chrome.runtime.sendMessage({ type: 'v2d/offscreen-cancel', taskId })
    } catch {
      /* offscreen 可能已关闭 */
    }
  }
  return true
}

/** 暂停（仅直链下载阶段可暂停：上传中断无分片续传，暂停无意义） */
export async function pauseTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task || task.kind !== 'upload' || task.state !== 'downloading') return false
  task.state = 'paused'
  await persist(true)
  try {
    await chrome.runtime.sendMessage({ type: 'v2d/offscreen-pause', taskId })
  } catch {
    /* offscreen 可能已关闭 */
  }
  // 关键：暂停要释放串行队列槽位，否则泵死锁在 await 上，
  // 后续所有任务永远「排队」（历史 bug）。paused 事件再置状态是幂等的
  releaseWaiter(taskId)
  return true
}

/** 继续：从断点重新入队（worker 以 OPFS 文件偏移 + hash 状态恢复） */
export async function resumeTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task || task.state !== 'paused') return false
  task.state = 'queued'
  await persist(true)
  void pump()
  return true
}

/** 重试失败/取消的任务（保留断点） */
export async function retryTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task || (task.state !== 'failed' && task.state !== 'cancelled')) return false
  task.state = 'queued'
  task.error = undefined
  task.finishedAt = undefined
  await persist(true)
  void pump()
  return true
}

/** 删除终态任务记录并清理暂存文件 */
export async function deleteTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return false
  const terminal = task.state === 'done' || task.state === 'failed' || task.state === 'cancelled'
  if (!terminal) return false
  tasks = (await loadTasks()).filter((t) => t.id !== taskId)
  await persist(true)
  try {
    await chrome.runtime.sendMessage({ type: 'v2d/dispose-file', taskId })
  } catch {
    /* ignore */
  }
  return true
}

/** 清除全部终态任务 */
export async function clearFinishedTasks(): Promise<number> {
  const all = await loadTasks()
  const finished = all.filter(
    (t) => t.state === 'done' || t.state === 'failed' || t.state === 'cancelled',
  )
  for (const t of finished) await deleteTask(t.id)
  return finished.length
}

/** SW 冷启动恢复：非终态任务重回队列（offscreen 独立于 SW 存活，此处处理 SW 被杀的场景） */
export async function recoverStuckTasks(): Promise<void> {
  const all = await loadTasks()
  let changed = false
  for (const t of all) {
    if (t.state === 'saving') {
      // blob URL 所在的交接流程随 SW 死亡丢失，无法自动续
      t.state = 'failed'
      t.error = '浏览器重启导致保存中断，请重试'
      t.finishedAt = Date.now()
      changed = true
    } else if (t.state === 'paused') {
      // 暂停态保持（用户手动继续），但暂存仍在磁盘
      continue
    } else if (t.state !== 'queued' && t.state !== 'done' && t.state !== 'failed' && t.state !== 'cancelled') {
      t.state = 'queued'
      t.error = undefined
      changed = true
    }
  }
  if (changed) {
    await persist(true)
    void pump()
  }
}

// ── 队列主循环（串行） ──────────────────────────────────────────────────
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const all = await loadTasks()
      const next = all.find((t) => t.state === 'queued')
      if (!next) break
      next.state = next.kind === 'offline' ? 'offline-adding' : 'downloading'
      await persist(true)
      try {
        if (next.kind === 'offline') {
          await runOfflineTask(next)
        } else {
          await runUploadTask(next)
        }
      } catch (e) {
        // 任何未预期异常都不能卡死串行队列：标记失败并继续
        next.state = 'failed'
        next.error = `任务异常: ${e instanceof Error ? e.message : String(e)}`
        next.finishedAt = Date.now()
        await persist(true)
      }
      // 离线失败降级会把任务置回 queued，循环自然衔接直传
    }
    await maybeCloseOffscreen()
  } finally {
    pumping = false
  }
}

// ── offline 通道（手动彩蛋：SW 内轻请求） ──────────────────────────────
async function runOfflineTask(task: TransferTask): Promise<void> {
  const client = client115()
  const fail = (reason: string): void => {
    void (async () => {
      task.state = 'failed'
      task.error = reason
      task.finishedAt = Date.now()
      await persist(true)
    })()
  }
  try {
    task.state = 'offline-adding'
    await client.offlineAdd(task.url, task.targetPath)
  } catch (e) {
    // 非会员/配额不足/链接不支持 → 明确失败（离线为手动通道，不自动降级）
    return fail(
      `离线任务提交失败: ${msg(e)}。提示：115 离线为会员功能；网页直链可改用视频嗅探里的「☁ 转存115」（浏览器直传）`,
    )
  }

  task.state = 'offline-polling'
  await persist(true)

  const deadline = Date.now() + POLL_TIMEOUT_MS
  let interval = 3000
  while (Date.now() < deadline) {
    await sleep(interval)
    interval = Math.min(interval + 1000, 10_000)
    if (cancelled.has(task.id)) {
      task.state = 'cancelled'
      task.finishedAt = Date.now()
      await persist(true)
      return
    }
    let matched: OfflineTask | undefined
    let page = 1
    for (;;) {
      const { tasks: list, page_count } = await client.offlineList(page)
      matched = list.find((t) => t.url === task.url)
      if (matched || !page_count || page >= page_count) break
      page += 1
    }
    if (!matched) continue
    if (offlineDone(matched)) {
      // 完成即清云端任务记录（保留文件本身）
      await client.offlineDel(String(matched.info_hash ?? ''), 0).catch(() => {})
      task.state = 'done'
      task.finishedAt = Date.now()
      await persist(true)
      return
    }
    if (offlineFailed(matched)) {
      return fail('115 服务器拉取失败：链接可能需要登录态或有防盗链；网页直链可改用「☁ 转存115」浏览器直传')
    }
    task.uploaded = Math.round(Number(matched.percentDone ?? 0))
    await persist()
  }
  return fail('离线任务超时未完成（30 分钟）')
}

// ── upload 通道（offscreen worker） ────────────────────────────────────
function releaseWaiter(taskId: string): void {
  const resolve = uploadWaiters.get(taskId)
  if (resolve) {
    uploadWaiters.delete(taskId)
    resolve()
  }
}

/**
 * 启动 offscreen 管线。⚠️ createDocument 返回时页面监听器可能尚未注册
 * （MV3 已知竞态）——「接收端不存在」必须重试，否则任务永远无法开始。
 */
async function sendOffscreenStart(payload: unknown): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await ensureOffscreen()
      const resp = (await chrome.runtime.sendMessage(payload)) as { ok?: boolean } | undefined
      if (resp?.ok) {
        console.log('[V2D] offscreen 启动成功（第', attempt + 1, '次尝试）')
        return true
      }
      console.warn('[V2D] offscreen 启动响应异常，重试', attempt + 1, resp)
    } catch (e) {
      console.warn('[V2D] offscreen 未就绪，重试', attempt + 1, e instanceof Error ? e.message : e)
    }
    await sleep(300)
  }
  console.error('[V2D] offscreen 启动重试耗尽')
  return false
}

async function runUploadTask(task: TransferTask): Promise<void> {
  // 先占 waiter 再发消息：完成/暂停事件可能先于 start 响应到达
  const waiterDone = new Promise<void>((resolve) => uploadWaiters.set(task.id, resolve))
  // ⚠️ dedicated worker 没有 chrome.* API：token 必须随任务载荷注入
  const tokenData = (await chrome.storage.local.get(TOKEN_STORAGE_KEY))[TOKEN_STORAGE_KEY] as
    | { access_token?: string; refresh_token?: string }
    | undefined
  const started = await sendOffscreenStart({
    type: 'v2d/offscreen-start',
    task: {
      id: task.id,
      kind: task.kind === 'hls' ? 'hls' : 'direct',
      dest: task.dest,
      url: task.url,
      fileName: task.fileName,
      targetPath: task.targetPath,
      ...(task.variantUrl ? { variantUrl: task.variantUrl } : {}),
      // 断点续传元数据（仅直链；worker 校验 hash 状态与暂存长度一致才续传）
      ...(task.hashStateB64 ? { hashStateB64: task.hashStateB64 } : {}),
      ...(task.received !== undefined ? { received: task.received } : {}),
      ...(tokenData?.access_token || tokenData?.refresh_token
        ? {
            token: {
              access_token: String(tokenData.access_token ?? ''),
              refresh_token: String(tokenData.refresh_token ?? ''),
            },
          }
        : {}),
    },
  })
  if (!started) {
    uploadWaiters.delete(task.id)
    task.state = 'failed'
    task.error = '无法启动传输管线（offscreen 未就绪），请重试'
    task.finishedAt = Date.now()
    await persist(true)
    return
  }
  // 启动在途期间用户可能已暂停/取消：把停止信号补送给已启动的管线
  if (task.state === 'paused' || task.state === 'cancelled') {
    try {
      await chrome.runtime.sendMessage({
        type: task.state === 'paused' ? 'v2d/offscreen-pause' : 'v2d/offscreen-cancel',
        taskId: task.id,
      })
    } catch {
      /* ignore */
    }
  }
  // 看门狗：管线 120s 无任何终态/暂停事件 → 判定死亡，避免任务永远「下载中」
  const outcome = await Promise.race([
    waiterDone.then(() => 'settled' as const),
    sleep(120_000).then(() => 'timeout' as const),
  ])
  if (outcome === 'timeout') {
    releaseWaiter(task.id)
    if (task.state !== 'paused' && task.state !== 'done') {
      task.state = 'failed'
      task.error = '传输管线 120 秒无响应（可能已崩溃），请重试；若反复出现请把 service worker 控制台日志发给开发者'
      task.finishedAt = Date.now()
      await persist(true)
    }
    // 补一个停止信号，防止僵尸管线继续占用
    try {
      await chrome.runtime.sendMessage({ type: 'v2d/offscreen-cancel', taskId: task.id })
    } catch {
      /* ignore */
    }
  }
}

export interface OffscreenTaskPayload {
  id: string
  url: string
  fileName: string
  targetPath: string
}

/** offscreen worker 事件入口（offscreen document 通过 runtime.sendMessage 汇报） */
export async function applyTaskEvent(e: {
  taskId: string
  state?: TaskState
  received?: number
  uploaded?: number
  size?: number
  speedBps?: number
  segmentsDone?: number
  segmentsTotal?: number
  hashStateB64?: string
  error?: string
  pickCode?: string
  instant?: boolean
}): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === e.taskId)
  if (!task) {
    console.warn('[V2D] 收到未知任务事件', e.taskId, e.state)
    return
  }
  console.log('[V2D] 任务事件', e.taskId, e.state ?? '', e.error ?? '')
  if (e.state) task.state = e.state
  if (e.received !== undefined) task.received = e.received
  if (e.uploaded !== undefined) task.uploaded = e.uploaded
  if (e.size !== undefined) task.size = e.size
  if (e.speedBps !== undefined) task.speedBps = e.speedBps
  if (e.segmentsDone !== undefined) task.segmentsDone = e.segmentsDone
  if (e.segmentsTotal !== undefined) task.segmentsTotal = e.segmentsTotal
  if (e.hashStateB64 !== undefined) task.hashStateB64 = e.hashStateB64
  if (e.error !== undefined) task.error = e.error
  if (e.pickCode !== undefined) task.pickCode = e.pickCode
  if (e.instant !== undefined) task.instant = e.instant

  const terminal = e.state === 'done' || e.state === 'failed' || e.state === 'cancelled'
  if (terminal) {
    task.finishedAt = Date.now()
    await persist(true)
    releaseWaiter(e.taskId)
  } else if (e.state === 'paused') {
    // 暂停同样释放队列槽位（泵继续跑后续任务）
    await persist(true)
    releaseWaiter(e.taskId)
  } else {
    await persist()
  }
}

// ── 本地保存交接：offscreen 建好 blob URL 后由 SW 发起原生下载 ──────────
export async function handleTaskBlob(taskId: string, blobUrl: string, fileName: string): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return
  task.state = 'saving'
  task.fileName = fileName
  await persist(true)
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `V2D/${fileName}`,
      saveAs: false,
    })
    await waitForDownload(downloadId)
    task.state = 'done'
    task.finishedAt = Date.now()
  } catch (e) {
    task.state = 'failed'
    task.error = e instanceof Error ? e.message : String(e)
    task.finishedAt = Date.now()
  }
  await persist(true)
  // 释放 offscreen 侧资源（blob URL + 暂存文件）
  try {
    await chrome.runtime.sendMessage({ type: 'v2d/dispose-file', taskId })
  } catch {
    /* offscreen 可能已关闭 */
  }
  void pump()
}

function waitForDownload(downloadId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return
      const state = delta.state?.current
      if (state === 'complete' || state === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener)
        resolve()
      }
    }
    chrome.downloads.onChanged.addListener(listener)
  })
}

// ── offscreen 生命周期 ─────────────────────────────────────────────────
export async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  })
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'V2D 传输管线（OPFS 暂存 + 分片直传）',
    })
  }
}

async function maybeCloseOffscreen(): Promise<void> {
  const all = await loadTasks()
  const active = all.some(
    (t) =>
      t.state === 'downloading' || t.state === 'hashing' || t.state === 'uploading' ||
      t.state === 'saving' ||
      t.state === 'offline-adding' || t.state === 'offline-polling' || t.state === 'queued',
  )
  if (!active) {
    try {
      await chrome.offscreen.closeDocument()
    } catch {
      /* 本来就没开 */
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
