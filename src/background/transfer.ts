/**
 * 传输队列（SW 侧协调，§3.1/§6）：串行执行（M2；并发设置 M4 引入）。
 *  - offline 通道：SW 内轻请求（add_task_urls → 自适应轮询；失败按策略降级 upload）
 *  - upload 通道：ensureOffscreen → worker 管线（OPFS 暂存 + SHA1 + 秒传/直传）
 * 任务元数据存 chrome.storage.local（M2 量级足够；M4 换 IndexedDB）。
 */

import type { DashSpec, MediaCandidate, V115Settings } from '@/core/types'
import { classifyLink } from '@/providers/115/offline'
import type { OfflineTask } from '@/providers/115/openapi'
import { offlineDone, offlineFailed } from '@/providers/115/openapi'
import { client115, TOKEN_STORAGE_KEY } from '@/providers/115/runtime'
import { addCandidates, listCandidates } from '@/core/sniffer/store'
import { fingerprint } from '@/core/sniffer/hash'
import { buildFileName } from '@/core/name'

export type TaskState =
  | 'queued'
  | 'offline-adding'
  | 'offline-polling'
  | 'downloading'
  | 'hashing'
  | 'transmuxing'
  | 'checking'
  | 'uploading'
  | 'saving'
  | 'staged'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TransferTask {
  id: string
  kind: 'offline' | 'upload' | 'hls' | 'dash' | 'mse'
  /** cloud = 转存 115；local = 保存本地（hls/dash 走队列） */
  dest: 'cloud' | 'local'
  state: TaskState
  url: string
  fileName: string
  targetPath: string
  pageTitle?: string
  /** hls：用户选择的清晰度（media playlist URL）；空 = 自动选最高 */
  variantUrl?: string
  /** dash：双轨 DASH 描述符（视频轨 + 可选音频轨直链） */
  dashSpec?: DashSpec
  /** mse：捕获任务的目标页与分组（页面内存中的数据，任务启动时拉回） */
  mse?: { tabId: number; videoGroupId: string; audioGroupId?: string }
  /** mse：拉取完成后的暂存文件名（staging/{file}.part）与容器 */
  msePull?: { videoFile: string; audioFile?: string; container: 'mp4' | 'webm' }
  /** Safari/iOS：合并产物已就绪，等待用户在管理页点「保存到文件」 */
  stagedFileName?: string
  stagedSize?: number
  /** Chrome：保存中任务的 chrome.downloads 记录 id（onChanged 收口用，SW 休眠也不丢） */
  downloadId?: number
  /** 页面 <a download> 保存中：blob URL（onChanged 按 url 匹配收口；SW 重启恢复用） */
  savingBlobUrl?: string
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
  /** 非致命说明（如 HLS 转封装回退 .ts 的原因）；不改变任务状态 */
  note?: string
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
/** 每任务最近一次管线事件时间（看门狗续期用；有事件 = 管线活着） */
const lastTaskEventAt = new Map<string, number>()
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
  // Safari/iOS：镜像任务数据到 App Group，供壳 App 内嵌任务页渲染
  if (!import.meta.env.CHROME) mirrorToAppGroup()
}

/** 经原生桥把任务列表镜像进 App Group（失败静默，App 侧退化为空列表） */
function mirrorToAppGroup(): void {
  try {
    chrome.runtime.sendNativeMessage(
      'com.ivenlau.v2d',
      { type: 'mirror', tasks },
      () => {
        void chrome.runtime.lastError
      },
    )
  } catch {
    /* ignore */
  }
}

/** Safari：消费壳 App 写入的操作命令（App 内嵌任务页的按钮） */
export async function pollAppCommands(): Promise<void> {
  if (import.meta.env.CHROME) return
  try {
    const r = await new Promise<{ commands?: Array<{ action: string; taskId: string }> }>((resolve) => {
      chrome.runtime.sendNativeMessage(
        'com.ivenlau.v2d',
        { type: 'commands-get' },
        (resp: { commands?: Array<{ action: string; taskId: string }> }) => resolve(resp ?? {}),
      )
    })
    for (const c of r.commands ?? []) {
      if (c.action === 'retry') await retryTask(c.taskId)
      if (c.action === 'cancel') await cancelTask(c.taskId)
      if (c.action === 'delete') await deleteTask(c.taskId)
    }
    if ((r.commands ?? []).length) {
      chrome.runtime.sendNativeMessage('com.ivenlau.v2d', { type: 'commands-clear' }, () => {
        void chrome.runtime.lastError
      })
    }
  } catch {
    /* 原生桥不可用（Chrome 平台/未授予）忽略 */
  }
}

export async function listTasks(): Promise<TransferTask[]> {
  return loadTasks()
}

/** 外部（E2E/其他上下文）直接写 storage 时使内存缓存失效 */
export function invalidateTaskCache(): void {
  tasks = null
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

/** 合并产物的容器统一是 mp4：清单/分段扩展名（.m3u8/.mpd/.m4s）不允许漏到落盘名 */
function forceMergeExt(name: string): string {
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name.replace(/\.[a-z0-9]{2,5}$/i, '.mp4') : `${name}.mp4`
}

export async function enqueueTransfer(
  cand: MediaCandidate,
  settings: V115Settings,
  pageTitle?: string,
  opts: { dest: 'cloud' | 'local'; variantUrl?: string; fileName?: string } = { dest: 'cloud' },
): Promise<TransferTask> {
  // hls/dash 候选走合并管线；直链一律浏览器直传（秒传优先）
  const isHls = cand.kind === 'hls'
  const isDash = cand.kind === 'dash'
  const task: TransferTask = {
    id: genTaskId(),
    kind: isDash ? 'dash' : isHls ? 'hls' : 'upload',
    dest: opts.dest,
    state: 'queued',
    url: cand.url,
    fileName: forceMergeExt(opts.fileName?.trim() || cand.fileName || 'video.mp4'),
    targetPath: joinTargetPath(settings.targetRoot, cand.url),
    pageTitle,
    variantUrl: opts.variantUrl,
    ...(isDash
      ? {
          dashSpec: {
            video: opts.variantUrl ?? cand.variants?.[0]?.url ?? cand.url,
            ...(cand.dashAudioUrl ? { audio: cand.dashAudioUrl } : {}),
            ...(cand.dashAudioOptional ? { audioOptional: true } : {}),
          } satisfies DashSpec,
        }
      : {}),
    createdAt: Date.now(),
  }
  const all = await loadTasks()
  all.push(task)
  await persist(true)
  void pump()
  return task
}

// ── MSE 深捕获（引擎 C）：分组登记 + 拉取落盘 ──────────────────────────
export interface MseGroupInfo {
  /** 复合 id：`${frameId}:${钩子内分组号}`——分组归属页面内的具体框架 */
  groupId: string
  mime: string
  bytes: number
  appends: number
  trackKind: 'video' | 'audio' | 'combined'
  overflow?: boolean
  title: string
}

/** 页面内存中的捕获数据是真相源；这里只存摘要（SW 重启后等下一次上报即恢复） */
const mseGroups = new Map<number, Map<string, MseGroupInfo & { frameId: number }>>()

/** 页面捕获钩子上报摘要：登记内存态 + upsert 候选（弹窗卡片，bytes 实时增长） */
export async function applyMseGroups(
  tabId: number,
  frameId: number,
  groups: MseGroupInfo[],
): Promise<void> {
  // 按框架合并（多框架页面各自上报，不能整体替换）
  const map = mseGroups.get(tabId) ?? new Map()
  for (const g of groups) map.set(`${frameId}:${g.groupId}`, { ...g, frameId })
  mseGroups.set(tabId, map)
  for (const [compositeId, g] of map) {
    const id = fingerprint(`mse|${tabId}|${compositeId}`)
    await addCandidates(tabId, [
      {
        id,
        tabId,
        url: `mse://${tabId}/${compositeId}`,
        kind: 'blob',
        origin: 'mse',
        mime: g.mime,
        size: g.bytes,
        probed: true,
        fileName: buildFileName({
          title: `${g.title || 'MSE 捕获'}·${g.trackKind === 'audio' ? '音频' : '视频'}`,
          url: '',
          ext: g.mime.includes('webm') ? 'webm' : 'mp4',
        }),
        mse: {
          groupId: compositeId,
          mime: g.mime,
          bytes: g.bytes,
          appends: g.appends,
          trackKind: g.trackKind,
          ...(g.overflow ? { overflow: true } : {}),
        },
        discoveredAt: Date.now(),
      },
    ])
  }
}

/** 入队 MSE 捕获任务（dest local：拉回 → 合并 → 待保存） */
export async function enqueueMseTransfer(
  req: { tabId: number; videoGroupId: string; audioGroupId?: string; pageTitle?: string; fileName?: string },
  settings: V115Settings,
): Promise<TransferTask> {
  const task: TransferTask = {
    id: genTaskId(),
    kind: 'mse',
    dest: 'local',
    state: 'queued',
    url: `mse://${req.tabId}/${req.videoGroupId}`,
    fileName: forceMergeExt(req.fileName?.trim() || 'MSE 捕获.mp4'),
    targetPath: joinTargetPath(settings.targetRoot, `mse://${req.tabId}/capture`),
    pageTitle: req.pageTitle,
    mse: {
      tabId: req.tabId,
      videoGroupId: req.videoGroupId,
      ...(req.audioGroupId ? { audioGroupId: req.audioGroupId } : {}),
    },
    createdAt: Date.now(),
  }
  const all = await loadTasks()
  all.push(task)
  await persist(true)
  void pump()
  return task
}

interface MsePullSession {
  file: string
  /** 下载任务拉取才有关联任务（预览拉取无任务，不更新进度） */
  taskId?: string
  received: number
  /** 预览限量：拉够即止（钩子侧同步截断） */
  maxBytes?: number
  finish: (err?: Error) => void
}
const msePulls = new Map<string, MsePullSession>()

/** 预览限量：拉前 1.5MB（fMP4/WebM 的 init+首分片足够出首帧），弹窗读完即弃 */
// 预览限量：必须覆盖「init 段 + 第一个完整分片」才能出帧（截断在分片中间 <video> 解析
// 不到帧就直接报错）。真实站点 1080p 首分片普遍 1~4MB，1.5MB 会切坏——取 8MB。
// 数据写入临时暂存、弹窗读完即弃，内存只是瞬态。
const MSE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

/** SW 重启会丢 mseGroups 内存态：让页面钩子重新上报一次摘要并等待（钩子 1s 节流内应答） */
async function requestMseReannounce(tabId: number): Promise<void> {
  try {
    const sent = chrome.tabs.sendMessage(tabId, { type: 'v2d/mse-announce' })
    if (sent instanceof Promise) await sent.catch(() => {})
  } catch {
    /* 页面已关闭 */
  }
  await sleep(1200)
}

/** 弹窗预览：从页面限量拉取一个捕获组到临时暂存文件（调用方读完自行 dispose） */
export async function startMsePreview(
  tabId: number,
  groupId: string,
): Promise<{ ok: true; file: string } | { ok: false; reason: string }> {
  let g = mseGroups.get(tabId)?.get(groupId)
  if (!g) {
    await requestMseReannounce(tabId)
    g = mseGroups.get(tabId)?.get(groupId)
  }
  if (!g) return { ok: false, reason: '捕获数据不存在（页面可能已刷新）' }
  if (g.bytes === 0) return { ok: false, reason: '捕获数据为空' }
  await ensureTransferHost()
  const [frameId, rawId] = splitCompositeId(groupId)
  const requestId = genTaskId()
  const file = `pv_${requestId}`
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        msePulls.delete(requestId)
        reject(new Error('预览数据拉取超时'))
      }, 20_000)
      msePulls.set(requestId, {
        file,
        received: 0,
        maxBytes: MSE_PREVIEW_MAX_BYTES,
        finish: (err) => {
          clearTimeout(timer)
          msePulls.delete(requestId)
          err ? reject(err) : resolve()
        },
      })
      try {
        const sent = chrome.tabs.sendMessage(
          tabId,
          { type: 'v2d/mse-pull', requestId, groupId: rawId, limitBytes: MSE_PREVIEW_MAX_BYTES },
          { frameId },
        )
        if (sent instanceof Promise) {
          sent.catch(() => msePulls.get(requestId)?.finish(new Error('无法连接页面')))
        }
      } catch (e) {
        msePulls.get(requestId)?.finish(new Error(`无法连接页面: ${msg(e)}`))
      }
    })
    return { ok: true, file }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** 把一个捕获组从其所在框架分块拉回、写入 offscreen 暂存（stop-and-wait，bg 落盘后才 ack 下一块） */
async function pullMseGroup(
  tabId: number,
  frameId: number,
  groupId: string,
  file: string,
  expected: number,
  task: TransferTask,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const requestId = genTaskId()
    const timer = setTimeout(() => {
      msePulls.delete(requestId)
      reject(new Error('捕获数据拉取超时（10 分钟）'))
    }, 10 * 60_000)
    console.log('[V2D mse-pull] 注册会话', requestId, '→', file)
    msePulls.set(requestId, {
      file,
      taskId: task.id,
      received: 0,
      finish: (err) => {
        clearTimeout(timer)
        msePulls.delete(requestId)
        err ? reject(err) : resolve()
      },
    })
    void expected
    try {
      // 精准定向到捕获所在的框架：广播会让其他框架的钩子回 pull-missing 误杀会话
      const sent = chrome.tabs.sendMessage(
        tabId,
        { type: 'v2d/mse-pull', requestId, groupId },
        { frameId },
      )
      if (sent instanceof Promise) {
        sent.catch(() => {
          const s = msePulls.get(requestId)
          if (s) s.finish(new Error('无法连接页面（可能已关闭或正在刷新），请重新播放后再试'))
        })
      }
    } catch (e) {
      msePulls.get(requestId)?.finish(new Error(`无法连接页面: ${msg(e)}`))
    }
  })
}

/** 拉回流程：确认捕获组仍存在 → 逐组分块拉取写入暂存 → 记录 msePull 供 worker 合并 */
async function pullMseCapture(task: TransferTask): Promise<void> {
  const mse = task.mse
  if (!mse) throw new Error('任务缺少捕获信息')
  let groups = mseGroups.get(mse.tabId)
  let video = groups?.get(mse.videoGroupId)
  if (!video) {
    await requestMseReannounce(mse.tabId)
    groups = mseGroups.get(mse.tabId)
    video = groups?.get(mse.videoGroupId)
  }
  if (!video) throw new Error('页面已关闭或捕获数据已清空，请重新播放后再试')
  const audio = mse.audioGroupId ? groups!.get(mse.audioGroupId) : undefined
  if (mse.audioGroupId && !audio) throw new Error('捕获的音频轨已不存在，请重新播放后再试')

  await ensureTransferHost()
  task.msePull = {
    videoFile: `${task.id}_v`,
    ...(audio ? { audioFile: `${task.id}_a` } : {}),
    container: video.mime.includes('webm') ? 'webm' : 'mp4',
  }
  await persist(true)

  const [vFrame, vId] = splitCompositeId(mse.videoGroupId)
  await pullMseGroup(mse.tabId, vFrame, vId, task.msePull.videoFile, video.bytes, task)
  if (audio) {
    const [aFrame, aId] = splitCompositeId(mse.audioGroupId!)
    await pullMseGroup(mse.tabId, aFrame, aId, task.msePull.audioFile!, audio.bytes, task)
  }

  // 孤儿防护：拉取期间 storage.onChanged 可能使闭包里的 task 失效，重新挂回活缓存再写
  const fresh = (await loadTasks()).find((t) => t.id === task.id)
  if (fresh && fresh.state === 'downloading') {
    fresh.msePull = task.msePull
    await persist(true)
  }
}

/** 复合 id `${frameId}:${groupId}` → [frameId, groupId]；非复合（历史数据）回退顶层框架 */
function splitCompositeId(composite: string): [number, string] {
  const idx = composite.indexOf(':')
  if (idx <= 0) return [0, composite]
  const frameId = Number(composite.slice(0, idx))
  return [Number.isFinite(frameId) ? frameId : 0, composite.slice(idx + 1)]
}

/** 拉取数据块：写入 offscreen 暂存（页面桥在 ack 前会等待本调用完成） */
export async function handleMseChunk(requestId: string, data: Uint8Array): Promise<boolean> {
  const session = msePulls.get(requestId)
  if (!session) {
    console.warn('[V2D mse-chunk] 无会话', requestId, '已知:', [...msePulls.keys()])
    return false
  }
  if (session.taskId && cancelled.has(session.taskId)) {
    const task = (await loadTasks()).find((t) => t.id === session.taskId)
    if (task && task.state !== 'done') {
      task.state = 'cancelled'
      task.finishedAt = Date.now()
      await persist(true)
      broadcastTask(task.id)
    }
    session.finish(new Error('已取消'))
    return false
  }
  try {
    // 预览限量：超限部分截掉（钩子侧已同步截断，这里是兜底）
    let bytes = data
    if (session.maxBytes !== undefined && session.received + bytes.length > session.maxBytes) {
      bytes = bytes.subarray(0, Math.max(0, session.maxBytes - session.received))
    }
    if (bytes.length > 0) {
      const resp = (await chrome.runtime.sendMessage({
        type: 'v2d/mse-stage-write',
        file: session.file,
        chunk: bytes,
      })) as { ok?: boolean; error?: string } | undefined
      if (!resp?.ok) throw new Error(resp?.error ?? '暂存写入失败')
      session.received += bytes.length
    }
    const task = session.taskId ? (await loadTasks()).find((t) => t.id === session.taskId) : undefined
    if (task && task.state === 'downloading') {
      task.received = session.received
      await persist()
      broadcastTask(task.id)
    }
    return true
  } catch (e) {
    session.finish(e instanceof Error ? e : new Error(String(e)))
    return false
  }
}

export function handleMsePullDone(requestId: string): void {
  const session = msePulls.get(requestId)
  if (!session) return
  void (async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'v2d/mse-stage-close', file: session.file })
    } catch {
      /* ignore */
    }
    session.finish()
  })()
}

export function handleMsePullMissing(requestId: string): void {
  msePulls.get(requestId)?.finish(new Error('捕获数据不存在（页面可能已刷新），请重新播放后再试'))
}

export async function cancelTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return false
  // 排队中的任务管线尚未启动：直接标记取消。发 offscreen-cancel 是无的放矢
  //（worker 里没有这个任务），状态永不变更——之后泵还会照常拉起它（「取消无效」的根源）
  if (task.state === 'queued') {
    task.state = 'cancelled'
    task.error = '已取消'
    task.finishedAt = Date.now()
    await persist(true)
    broadcastTask(taskId)
    return true
  }
  cancelled.add(taskId)
  // mse 拉取阶段：没有 worker 可中断，直接落库取消态并终结该任务的所有拉取会话
  //（会话以「已取消」拒绝 → pullMseCapture 抛出 → pump 跳过已取消任务）
  if (task.kind === 'mse' && task.state === 'downloading') {
    task.state = 'cancelled'
    task.finishedAt = Date.now()
    await persist(true)
    broadcastTask(taskId)
    for (const [, s] of msePulls) if (s.taskId === taskId) s.finish(new Error('已取消'))
    return true
  }
  if (
    task.state === 'downloading' || task.state === 'hashing' || task.state === 'transmuxing' ||
    task.state === 'checking' || task.state === 'uploading' || task.state === 'paused'
  ) {
    if (task.state === 'paused') {
      // 暂停态无运行中的管线：直接标记取消
      task.state = 'cancelled'
      task.finishedAt = Date.now()
      await persist(true)
      broadcastTask(taskId)
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

/** 删除任务记录并清理暂存文件（终态；Safari 待保存任务在用户确认后调用） */
/** 清理任务的 OPFS 暂存产物。删除逻辑在 offscreen 宿主里——它可能在任务 staged 后
 *  就被泵排空关闭了（staged 不算活跃任务），此时必须重新拉起再删，否则暂存泄漏。
 *  ⚠️ 必须校验 resp.ok：消息会同时投递给其他扩展页（popup/manager 的监听器只收不回），
 *  无人应答时 sendMessage 以 null resolve 而非 reject——只看是否抛错会误判成功。 */
async function disposeStaging(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    let resp: { ok?: boolean } | undefined
    try {
      resp = (await chrome.runtime.sendMessage({ type: 'v2d/dispose-file', taskId })) as
        | { ok?: boolean }
        | undefined
    } catch {
      /* 无任何接收方 */
    }
    if (resp?.ok) return // offscreen 已删除完毕（删完才响应）
    if (!import.meta.env.CHROME) return // Safari 无 offscreen：后台标签页通常仍在
    try {
      await ensureTransferHost()
    } catch {
      /* ignore */
    }
    await sleep(300)
  }
}

export async function deleteTask(taskId: string): Promise<boolean> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return false
  const terminal =
    task.state === 'done' ||
    task.state === 'failed' ||
    task.state === 'cancelled' ||
    // Safari 待保存任务允许放弃（清理暂存产物）
    task.state === 'staged'
  if (!terminal) return false
  tasks = (await loadTasks()).filter((t) => t.id !== taskId)
  await persist(true)
  await disposeStaging(taskId)
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
      if (t.savingBlobUrl) {
        // 页面 <a download> 保存被浏览器重启打断：暂存产物仍在 OPFS，回待保存可重试
        t.state = 'staged'
        t.savingBlobUrl = undefined
        t.error = '浏览器重启中断了保存，请重新点击保存'
      } else {
        // blob URL 所在的交接流程随 SW 死亡丢失，无法自动续
        t.state = 'failed'
        t.error = '浏览器重启导致保存中断，请重试'
      }
      t.finishedAt = Date.now()
      changed = true
    } else if (t.state === 'paused' || t.state === 'staged') {
      // 暂停态保持（用户手动继续）；Safari 待保存态保持（产物仍在 OPFS，可重建 blob）
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
        } else if (next.kind === 'mse') {
          // Referer 规则已常驻（installRefererRules），任务直接进管线
          await pullMseCapture(next)
          await runUploadTask(next)
        } else {
          // Referer 规则已常驻（installRefererRules），任务直接进管线
          await runUploadTask(next)
        }
      } catch (e) {
        // 任何未预期异常都不能卡死串行队列：标记失败并继续。
        // 孤儿防护：迭代中途的 persist 可能让 next 失效——失败必须写进活缓存，
        // 否则失败状态静默丢失，任务永远停在「下载中」（mse 拉取曾因此卡死）
        const fresh = (await loadTasks()).find((t) => t.id === next.id) ?? next
        if (e instanceof Error && e.message === '已取消') {
          // 取消态已由取消方落库，这里不再覆盖
        } else {
          fresh.state = 'failed'
          fresh.error = `任务异常: ${e instanceof Error ? e.message : String(e)}`
          fresh.finishedAt = Date.now()
          await persist(true)
          broadcastTask(fresh.id)
        }
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
      await ensureTransferHost()
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
  await ensureTransferHost()
  // ⚠️ dedicated worker 没有 chrome.* API：token 必须随任务载荷注入
  const tokenData = (await chrome.storage.local.get(TOKEN_STORAGE_KEY))[TOKEN_STORAGE_KEY] as
    | { access_token?: string; refresh_token?: string }
    | undefined
  const started = await sendOffscreenStart({
    type: 'v2d/offscreen-start',
    task: {
      id: task.id,
      // kind 必须原样透传（dash → worker 的 runDashTask 双轨合并；mse → runMseTask 捕获合并）：
      // 曾被折叠成 'direct'，导致 DASH 只下视频轨、产物无声
      kind: task.kind === 'hls' ? 'hls' : task.kind === 'dash' ? 'dash' : task.kind === 'mse' ? 'mse' : 'direct',
      dest: task.dest,
      url: task.url,
      fileName: task.fileName,
      targetPath: task.targetPath,
      ...(task.variantUrl ? { variantUrl: task.variantUrl } : {}),
      ...(task.dashSpec ? { dashSpec: task.dashSpec } : {}),
      ...(task.msePull ? { msePull: task.msePull } : {}),
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
  // 看门狗：管线 120s 无「任何」事件 → 判定死亡，避免任务永远「下载中」。
  // 事件到达即续期——下载/合成大视频远超 120s 是正常的（曾误杀全部长视频任务）
  const startedAt = Date.now()
  lastTaskEventAt.set(task.id, startedAt)
  for (;;) {
    const outcome = await Promise.race([
      waiterDone.then(() => 'settled' as const),
      sleep(10_000).then(() => 'tick' as const),
    ])
    if (outcome === 'settled') break
    if (Date.now() - (lastTaskEventAt.get(task.id) ?? startedAt) <= 120_000) continue
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
    break
  }
  lastTaskEventAt.delete(task.id)
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
  note?: string
}): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === e.taskId)
  if (!task) {
    console.warn('[V2D] 收到未知任务事件', e.taskId, e.state)
    return
  }
  console.log('[V2D] 任务事件', e.taskId, e.state ?? '', e.error ?? '')
  // 任何事件都给看门狗续期（终态/暂停会随即释放 waiter，此处记录无副作用）
  lastTaskEventAt.set(e.taskId, Date.now())
  // staged/saving/done 后不再接受 worker 事件回退状态——
  // 迟到的下载/校验事件会把「待保存」覆盖回「校验中」，任务就此卡死
  if (task.state === 'staged' || task.state === 'saving' || task.state === 'done') return
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
  if (e.note !== undefined) task.note = e.note
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


// ── Safari/iOS 本地保存：合并产物就绪 → 用户在管理页点「保存到文件」 ──

// ── 本地保存交接：offscreen 建 blob URL（带 video/mp4 MIME），由 SW 发起原生下载 ──

// SW 发起的 blob: 下载 filename 会被 Chromium 忽略（落成 UUID 名）——
// 记录 blobUrl → 目标名，由 background 的 onDeterminingFilename 在文件名决议阶段覆写
const pendingBlobNames = new Map<string, string>()

/** 登记 blob 下载的目标文件名（onDeterminingFilename 覆写用） */
export function rememberBlobName(blobUrl: string, fileName: string): void {
  if (pendingBlobNames.size > 100) pendingBlobNames.clear()
  pendingBlobNames.set(blobUrl, fileName)
}

/** 查询 blob 下载的目标文件名；非本扩展的下载返回 undefined（走默认命名） */
export function lookupBlobName(blobUrl: string): string | undefined {
  return pendingBlobNames.get(blobUrl)
}

export async function handleTaskBlob(taskId: string, blobUrl: string, fileName: string): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return
  task.state = 'saving'
  task.fileName = fileName
  await persist(true)
  let downloadId: number
  try {
    rememberBlobName(blobUrl, fileName)
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `V2D/${fileName}`,
      saveAs: false,
    })
  } catch (e) {
    task.state = 'failed'
    task.error = e instanceof Error ? e.message : String(e)
    task.finishedAt = Date.now()
    await persist(true)
    void pump()
    return
  }
  // downloadId 持久化 + 收口：SW 休眠会打断快路径轮询，downloads.onChanged（启动注册）兜底。
  // ⚠️ await 期间 storage.onChanged 可能 invalidateTaskCache（task 成孤儿对象、persist 静默
  // 不写）——必须重新 find 挂回活缓存再改字段
  const fresh = (await loadTasks()).find((t) => t.id === taskId)
  if (fresh) {
    fresh.downloadId = downloadId
    await persist(true)
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await sleep(500)
    const [rec] = await chrome.downloads.search({ id: downloadId }).catch(() => [])
    if (!rec) continue
    if (rec.state === 'complete') return finishDownloadTask(downloadId, null)
    if (rec.state === 'interrupted') return finishDownloadTask(downloadId, rec.error ?? '下载中断')
  }
}

/** 保存收口（轮询快路径 / onChanged 唤醒共用；重复通知幂等） */
export async function finishDownloadTask(downloadId: number, err: string | null): Promise<void> {
  const [rec] = await chrome.downloads.search({ id: downloadId }).catch(() => [])
  const task = (await loadTasks()).find(
    (t) => t.downloadId === downloadId || (rec && t.savingBlobUrl && t.savingBlobUrl === rec.url),
  )
  if (!task || task.state !== 'saving') return
  if (err && task.savingBlobUrl) {
    // 页面 <a download> 保存失败：回到待保存（暂存产物仍在 OPFS，可直接再点保存）
    task.state = 'staged'
    task.error = `浏览器保存失败（${err}），可再次点击保存`
    task.savingBlobUrl = undefined
    await persist(true)
    broadcastTask(task.id)
    return
  }
  if (err) {
    task.state = 'failed'
    task.error = err
  } else {
    task.state = 'done'
  }
  task.savingBlobUrl = undefined
  task.finishedAt = Date.now()
  await persist(true)
  broadcastTask(task.id)
  await disposeStaging(task.id)
  void pump()
}

export async function applyStagedReady(taskId: string, fileName: string, size: number): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task) return
  task.state = 'staged'
  task.stagedFileName = fileName
  task.fileName = fileName
  task.size = size
  task.received = size
  task.finishedAt = Date.now()
  await persist(true)
  broadcastTask(taskId)
  // staged = 管线工作已结束（等用户点保存），必须释放串行队列槽位——
  // 否则泵阻塞到看门狗超时（120s），期间后续任务全部卡「排队中」
  releaseWaiter(taskId)
}

/** 用户点击保存（<a download> 已触发）后收口 */
export async function markTaskSaved(taskId: string): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task || task.state !== 'staged') return
  task.state = 'done'
  task.finishedAt = Date.now()
  await persist(true)
  broadcastTask(taskId)
  await disposeStaging(taskId)
}

// ── 传输宿主（平台抽象，§11）：Chrome=offscreen document；Safari=后台标签页 ──
export async function ensureTransferHost(): Promise<void> {
  if (import.meta.env.CHROME) {
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
    return
  }
  // Safari：无 offscreen API，用后台标签页承载同一宿主页面
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('offscreen.html') })
  if (tabs.length === 0) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('offscreen.html'), active: false })
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

// ── DNR：常驻 Referer 规则（CDN 防盗链要求 UA+Referer；浏览器 fetch/<video> 均无法自设 Referer） ──
const REFERER_RULE_ID_BASE = 2000

/**
 * 站点族 CDN 域 → 应携带的 Referer（新增适配器在此扩展）。
 * requestDomains 匹配注册域及其全部子域（含 mcdn.bilivideo.cn 这类 P2P CDN）。
 * 常驻而非任务期注入：传输拉流（xhr）与弹窗视频预览（media）都需要，且会话规则
 * 存活于浏览器进程、SW 休眠不丢。只影响已适配站点的 CDN 域，页面自身请求的
 * Referer 本就是同值（覆写为 no-op）。
 */
const REFERER_RULES: Array<{ domains: string[]; referer: string }> = [
  { domains: ['bilivideo.com', 'bilivideo.cn', 'bilibili.com'], referer: 'https://www.bilibili.com/' },
  { domains: ['douyin.com', 'douyinvod.com', 'zjcdn.com'], referer: 'https://www.douyin.com/' },
  { domains: ['kuaishou.com', 'gifshow.com', 'yximgs.com'], referer: 'https://www.kuaishou.com/' },
  { domains: ['xhscdn.com', 'xiaohongshu.com'], referer: 'https://www.xiaohongshu.com/' },
  { domains: ['vimeo.com', 'vimeocdn.com'], referer: 'https://vimeo.com/' },
  { domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'byteoversea.com'], referer: 'https://www.tiktok.com/' },
  { domains: ['reddit.com', 'redditmedia.com', 'redd.it'], referer: 'https://www.reddit.com/' },
  { domains: ['pornhub.com', 'phncdn.com'], referer: 'https://www.pornhub.com/' },
  { domains: ['xvideos.com', 'xvideos-cdn.com'], referer: 'https://www.xvideos.com/' },
  { domains: ['xhamster.com', 'xhcdn.com'], referer: 'https://xhamster.com/' },
  { domains: ['xnxx.com', 'xnxx-cdn.com'], referer: 'https://www.xnxx.com/' },
  { domains: ['youporn.com'], referer: 'https://www.youporn.com/' },
  { domains: ['spankbang.com'], referer: 'https://spankbang.com/' },
  { domains: ['eporner.com'], referer: 'https://www.eporner.com/' },
]

/** SW 启动时注入全部族规则（幂等；Safari DNR 不完整则跳过，对应请求会 403 并有明确提示） */
export function installRefererRules(): void {
  if (typeof chrome.declarativeNetRequest === 'undefined') return
  const rules = REFERER_RULES.map((r, i) => ({
    id: REFERER_RULE_ID_BASE + i,
    priority: 1,
    condition: {
      requestDomains: r.domains,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, chrome.declarativeNetRequest.ResourceType.MEDIA],
    },
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [{ header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: r.referer }],
    },
  }))
  void chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules })
    .catch(() => {})
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** SW 侧状态变更广播给 popup/manager（worker 事件之外的变更页面感知不到，需主动通知） */
function broadcastTask(taskId: string): void {
  chrome.runtime.sendMessage({ type: 'v2d/task-event', taskId }).catch(() => {})
}

// ── 页面 <a download> 保存的统一收口 ────────────────────────────────────
// 页面只负责触发下载（saveStagedProduct），删暂存/标终态一律等 Chrome 下载终态：
// 完成 → 标 done + 删暂存；失败 → 回到待保存（暂存产物还在，可直接再点保存）。
// 此前管理页在点击后立刻删暂存，Chrome 还没读完 blob 数据源就被删 → NETWORK_FAILED。
export async function watchPageSave(taskId: string, blobUrl: string): Promise<void> {
  const task = (await loadTasks()).find((t) => t.id === taskId)
  if (!task || task.state !== 'staged') return
  task.state = 'saving'
  task.error = undefined
  task.savingBlobUrl = blobUrl
  await persist(true)
  broadcastTask(taskId)

  // <a download> 拿不到下载 id：按 blob URL 等下载记录出现（通常 <1s）
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await sleep(500)
    const recs = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 }).catch(() => [])
    if (recs.some((r) => r.url === blobUrl)) return
  }
  // 浏览器迟迟未开始下载（被拦截/页面已销毁）：回退待保存，暂存保留可重试
  const fresh = (await loadTasks()).find((t) => t.id === taskId)
  if (fresh && fresh.state === 'saving') {
    fresh.state = 'staged'
    fresh.savingBlobUrl = undefined
    fresh.error = '浏览器未开始下载，可再次点击保存'
    await persist(true)
    broadcastTask(taskId)
  }
}
