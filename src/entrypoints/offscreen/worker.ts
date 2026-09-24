/**
 * 传输 Worker（§6 管线实体）：
 *   direct：下载 → OPFS 暂存 + 增量 SHA1 → fastUpload115（秒传/直传）→ 清理
 *           断点续传（M4）：复用暂存文件偏移 + hash-wasm save()/load() 状态，
 *           服务器支持 Range 且状态校验一致才续传，否则 reset 从头
 *           暂停（M4）：abort 但保留暂存 + hash 状态，交回 SW 持久化
 *   hls   ：playlist 解析 → 分段并发+AES-128+remux（§5.1）→ 暂存+SHA1
 *           → cloud：fastUpload115 ｜ local：staged 事件 → offscreen 桥经 blob URL 交给 downloads
 * 内存模型（§6.3）：流式写入 + 分片 seek 回读，常驻内存与文件大小无关。
 */

import { createSHA1 } from 'hash-wasm'
import { Open115Client } from '@/providers/115/openapi'
import type { TokenPair } from '@/providers/115/openapi'
import { createMemoryStorage } from '@/providers/115/env'
import { fastUpload115 } from '@/providers/115/upload115'
import { OpfsStage } from '@/providers/115/staging'
import { runHlsToStage } from '@/offscreen/hlsPipeline'

interface WorkerCtx {
  addEventListener(type: 'message', cb: (e: MessageEvent) => void): void
  postMessage(msg: unknown): void
}
const ctx = self as unknown as WorkerCtx

export interface WorkerTask {
  id: string
  /** direct = 直链单文件；hls = m3u8 分段合并 */
  kind: 'direct' | 'hls'
  /** cloud = 转存 115；local = 保存本地（仅 hls 走队列） */
  dest: 'cloud' | 'local'
  url: string
  fileName: string
  targetPath: string
  /** hls：用户选择的清晰度（media playlist URL）；空 = 自动选最高 */
  variantUrl?: string
  /** 断点续传元数据（SW 持久化后随任务下发） */
  hashStateB64?: string
  received?: number
  /** ⚠️ dedicated worker 没有 chrome.* API：token 由 SW 随任务注入 */
  token?: TokenPair
}

const running = new Map<string, AbortController>()
const pausedIds = new Set<string>()

// worker 内的 115 client：内存存储（无 chrome API），token 由每个任务的载荷刷新；
// 上传途中轮换出的新 token 经 v2d/token-updated 回传 SW 持久化
let workerClient: Open115Client | null = null
function getClientFor(task: WorkerTask): Open115Client {
  if (!workerClient) {
    workerClient = new Open115Client({
      storage: createMemoryStorage(),
      onTokenSaved: (pair) => ctx.postMessage({ type: 'v2d/token-updated', pair }),
    })
  }
  if (task.token?.access_token || task.token?.refresh_token) {
    void workerClient.importTokens(task.token)
  }
  return workerClient
}

ctx.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as { type: string; task?: WorkerTask; taskId?: string }
  if (msg.type === 'start' && msg.task) void runTask(msg.task)
  if (msg.type === 'cancel' && msg.taskId) {
    pausedIds.delete(msg.taskId)
    running.get(msg.taskId)?.abort()
  }
  if (msg.type === 'pause' && msg.taskId) {
    pausedIds.add(msg.taskId)
    running.get(msg.taskId)?.abort()
  }
})

function withExt(name: string, ext: string): string {
  return /\.[a-z0-9]{2,5}$/i.test(name)
    ? name.replace(/\.[a-z0-9]{2,5}$/i, '.' + ext)
    : `${name}.${ext}`
}

// ── base64（hash 状态持久化用） ────────────────────────────────────────
function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

async function runTask(task: WorkerTask): Promise<void> {
  const ctrl = new AbortController()
  running.set(task.id, ctrl)
  const emit = (patch: Record<string, unknown>): void => {
    if (patch.state) console.log(`[V2D worker] ${task.id} → ${String(patch.state)}`)
    ctx.postMessage({ type: 'v2d/task-event', taskId: task.id, ...patch })
  }
  console.log(`[V2D worker] 任务启动: ${task.id} kind=${task.kind} dest=${task.dest}`)
  try {
    if (task.kind === 'hls') await runHlsTask(task, ctrl, emit)
    else await runDirectTask(task, ctrl, emit)
  } catch (e) {
    // runTask 内部各自 catch；到这里说明框架层异常
    console.error('[V2D worker] 框架层异常', e)
    emit({ state: 'failed', error: `内部异常: ${String(e)}` })
  } finally {
    running.delete(task.id)
    pausedIds.delete(task.id)
  }
}

// ── 直链（断点续传 + 暂停） ────────────────────────────────────────────
async function runDirectTask(
  task: WorkerTask,
  ctrl: AbortController,
  emit: (patch: Record<string, unknown>) => void,
): Promise<void> {
  let stage: OpfsStage | null = null
  const hasher = await createSHA1()
  hasher.init()
  let hashSavedB64 = ''
  let downloadDone = false // 离开下载阶段后暂停视为取消

  try {
    const client = getClientFor(task)
    emit({ state: 'downloading' })
    const cid = await client.createDirRecursive(task.targetPath)

    stage = await OpfsStage.open(task.id)
    let offset = stage.size
    // 断点可信校验：hash 状态存在、记录字节与文件长度一致
    const canResume = offset > 0 && !!task.hashStateB64 && task.received === offset
    if (offset > 0 && !canResume) {
      stage.reset()
      offset = 0
    }
    if (canResume) {
      try {
        hasher.load(b64ToBytes(task.hashStateB64!))
        hashSavedB64 = task.hashStateB64!
      } catch {
        stage.reset()
        offset = 0
        hasher.init()
      }
    }

    let resp = await fetch(task.url, {
      signal: ctrl.signal,
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
    })
    if (offset > 0 && resp.status !== 206) {
      // 服务器不支持 Range：从头来
      stage.reset()
      offset = 0
      hasher.init()
      hashSavedB64 = ''
      resp = await fetch(task.url, { signal: ctrl.signal })
    }
    if (!resp.ok) {
      const hint = resp.status === 403 ? '（可能为防盗链，请先播放该视频后重试）' : ''
      throw new Error(`HTTP ${resp.status}${hint}`)
    }
    if (!resp.body) throw new Error('响应无内容')
    if (offset > 0) {
      emit({ state: 'downloading', received: offset, resuming: true })
    }

    const totalHint = offset + (Number(resp.headers.get('content-length')) || 0)
    const reader = resp.body.getReader()
    let received = offset
    let lastEmit = 0
    let lastHashSave = 0
    let windowBytes = 0
    let windowStart = Date.now()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stage.write(value)
      hasher.update(value)
      received += value.length
      windowBytes += value.length
      const now = Date.now()
      if (now - lastEmit >= 500) {
        const elapsed = (now - windowStart) / 1000
        const patch: Record<string, unknown> = {
          state: 'downloading',
          received,
          size: totalHint || undefined,
          speedBps: elapsed > 0.2 ? windowBytes / elapsed : 0,
        }
        // hash 状态随进度低频持久化（断点续传 / SW 被杀恢复用）
        if (now - lastHashSave >= 10_000) {
          hashSavedB64 = bytesToB64(hasher.save())
          patch.hashStateB64 = hashSavedB64
          lastHashSave = now
        }
        emit(patch)
        if (elapsed > 2) {
          windowBytes = 0
          windowStart = now
        }
        lastEmit = now
      }
    }
    if (received === 0) throw new Error('下载内容为空')
    const sha1 = hasher.digest('hex')
    downloadDone = true
    emit({ state: 'hashing', received, size: received })

    // 秒传优先：upload/init 命中即零上传完成，未命中才走 OSS 直传
    emit({ state: 'checking', size: received })
    emit({ state: 'uploading', uploaded: 0, size: received })
    let lastUp = 0
    const res = await fastUpload115(client, {
      fileName: task.fileName,
      size: received,
      cid,
      sha1Hex: sha1,
      source: stage.byteSource(),
      signal: ctrl.signal,
      onUploaded: (uploaded, total) => {
        const now = Date.now()
        if (now - lastUp >= 500 || uploaded >= total) {
          emit({ state: 'uploading', uploaded, size: total, speedBps: undefined })
          lastUp = now
        }
      },
    })

    await stage.dispose()
    stage = null
    emit({ state: 'done', size: received, pickCode: res.pickCode, instant: res.instant })
  } catch (err) {
    // ── 暂停：保留暂存 + hash 状态，交回 SW 持久化 ──
    if (pausedIds.has(task.id) && !downloadDone && stage) {
      const received = stage.size
      if (!hashSavedB64 || received === 0) {
        // 无有效断点：当取消处理
        await stage.dispose()
        emit({ state: 'cancelled', error: '已取消' })
        return
      }
      try {
        hashSavedB64 = bytesToB64(hasher.save())
      } catch {
        /* 用上次保存的状态 */
      }
      await stage.close()
      emit({ state: 'paused', received, hashStateB64: hashSavedB64 })
      return
    }
    // ── 取消：删暂存 ──
    if (ctrl.signal.aborted) {
      await stage?.dispose()
      emit({ state: 'cancelled', error: '已取消' })
      return
    }
    // ── 失败：保留暂存供重试断点续传 ──
    let hashStateB64: string | undefined
    if (!downloadDone && stage && stage.size > 0) {
      try {
        hashStateB64 = bytesToB64(hasher.save())
      } catch {
        /* ignore */
      }
    }
    await stage?.close()
    emit({
      state: 'failed',
      hashStateB64,
      received: stage?.size,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── HLS（cloud/local 双出口；无断点——失败即清理重来） ────────────────
async function runHlsTask(
  task: WorkerTask,
  ctrl: AbortController,
  emit: (patch: Record<string, unknown>) => void,
): Promise<void> {
  let stage: OpfsStage | null = null
  try {
    const client = getClientFor(task)
    emit({ state: 'downloading' })
    const cid = task.dest === 'cloud' ? await client.createDirRecursive(task.targetPath) : 0

    stage = await OpfsStage.open(task.id)
    if (stage.size > 0) stage.reset() // HLS 无断点语义，清理残留
    const result = await runHlsToStage(task.variantUrl || task.url, {
      stage,
      emit,
      signal: ctrl.signal,
      wantHash: task.dest === 'cloud',
    })
    const fileName = withExt(task.fileName, result.ext)

    if (task.dest === 'local') {
      // 关句柄留文件；offscreen 桥把它经 blob URL 交给 chrome.downloads
      emit({ state: 'hashing', received: result.size, size: result.size, segmentsDone: result.segmentsTotal, segmentsTotal: result.segmentsTotal })
      await stage.close()
      stage = null
      ctx.postMessage({ type: 'v2d/task-staged', taskId: task.id, fileName, size: result.size })
      return
    }

    // 秒传优先：命中即零上传完成（HLS 合并产物同样适用）
    emit({ state: 'checking', size: result.size })
    emit({ state: 'uploading', uploaded: 0, size: result.size })
    let lastUp = 0
    const res = await fastUpload115(client, {
      fileName,
      size: result.size,
      cid,
      sha1Hex: result.sha1,
      source: stage.byteSource(),
      signal: ctrl.signal,
      onUploaded: (uploaded, total) => {
        const now = Date.now()
        if (now - lastUp >= 500 || uploaded >= total) {
          emit({ state: 'uploading', uploaded, size: total, speedBps: undefined })
          lastUp = now
        }
      },
    })

    await stage.dispose()
    stage = null
    emit({ state: 'done', size: result.size, pickCode: res.pickCode, instant: res.instant })
  } catch (err) {
    await stage?.dispose()
    emit({
      state: ctrl.signal.aborted ? 'cancelled' : 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
