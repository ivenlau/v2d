/**
 * OSS 直传执行器（对照 tg115bot cloud115/oss_upload.py 上传编排逐语义移植）。
 *
 * 协议要点：
 *   - 小文件(<=10MB)   单次 PUT（必须带 callback 头，否则 115 不入库）
 *   - 大文件           init(sequential=1) -> 分片 PUT（⚠️ 严格串行，并发会 PartNotSequential）
 *                      -> complete(XML body + callback 头)
 *   - STS 续传         403+STS Code -> tokenRefresher 刷新 -> ListParts 跳过已传分片继续；
 *                      SignatureDoesNotMatch/RequestTimeTooSkewed 不重试
 *   - 会话死亡         OSS multipart 只对创建它的那份 STS 可见，115 的 get_token 每次发放
 *                      全新凭证 → 刷新即 NoSuchUpload。重启一次仍死 → OssSessionLostError
 *                      （文件 > 上行带宽 × STS 有效期，直传无法完成，永久失败）。
 *
 * 与 Python 版差异：字节来源从本地文件路径抽象为 ByteSource（扩展内由 OPFS 暂存文件实现）。
 */

import type { FetchLike } from './env'
import { asBody, sleep } from './env'
import { withBackoff } from './rate'
import type { OssCallback, OssToken } from './ossSign'
import {
  OSS_MIN_PART_SIZE,
  callbackHeaders,
  completeBody,
  determinePartsize,
  isStsError,
  objectUrl,
  ossErrorSummary,
  ossV1Sign,
  ossV1StringToSign,
  parseListPartsXml,
  parseUploadIdXml,
} from './ossSign'
import { AuthRequiredError } from './openapi'

/** 可 seek 读的字节源（OPFS 同步句柄 / Blob / 内存缓冲均可实现） */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export class OssSessionLostError extends Error {
  constructor(size: number, totalParts: number) {
    super(
      `OSS 分片会话重启后再次失效。根因: 115 STS 凭证按次发放，阿里云 OSS 分片会话只对` +
        `创建它的凭证可见，刷新 token 即作废已传分片。本文件 ${totalParts} 片 ≈ ` +
        `${(size / 1024 ** 3).toFixed(1)}GB，超出单份凭证有效期内可传量，直传无法完成。` +
        `建议: 改用 115 离线下载(直链/磁力)，或提升上行带宽后重试。`,
    )
    this.name = 'OssSessionLostError'
  }
}

export class TaskCancelledError extends Error {
  constructor() {
    super('任务已取消')
    this.name = 'TaskCancelledError'
  }
}

class StsExpiredError extends Error {
  constructor(
    public status: number,
    public text: string,
  ) {
    super(ossErrorSummary(status, text))
    this.name = 'StsExpiredError'
  }
}

class SessionDeadError extends Error {}

export interface UploadToOssOptions {
  endpoint: string
  bucket: string
  /** 对象 key（115 upload/init 返回的 object 字段） */
  obj: string
  token: OssToken
  /** upload/init 返回的 callback（缺省时 115 不入库） */
  callback?: OssCallback | null
  onProgress?: (done: number, total: number) => void | Promise<void>
  /** 取消信号：触发时 abort 分片并清理 OSS 会话 */
  signal?: AbortSignal
  /** STS 刷新闭包（启用续传必传；不传则 STS 过期直接失败） */
  tokenRefresher?: () => Promise<OssToken>
  fetchFn?: FetchLike
  maxRetriesPerPart?: number
}

const MAX_REFRESH_FAILS = 3
const MAX_SESSION_RESTARTS = 1
const READ_CHUNK = 1024 * 1024

/** 把文件字节直传 115 的 OSS。成功返回；失败抛异常（语义见模块头注释）。 */
export async function uploadToOss(
  source: ByteSource,
  opts: UploadToOssOptions,
): Promise<void> {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
  const base = objectUrl(opts.endpoint, opts.bucket, opts.obj)
  const cbHeaders = callbackHeaders(opts.callback)
  let token = opts.token
  const checkCancel = () => {
    if (opts.signal?.aborted) throw new TaskCancelledError()
  }

  const bodyOf = async (offset: number, length: number): Promise<Uint8Array> => {
    // 分片级流式读：内部再按 1MB 切片拼接，避免一次性超大 buffer 分配压力
    if (length <= READ_CHUNK) return source.read(offset, length)
    const out = new Uint8Array(length)
    let read = 0
    while (read < length) {
      const n = Math.min(READ_CHUNK, length - read)
      const chunk = await source.read(offset + read, n)
      out.set(chunk, read)
      read += chunk.length
    }
    return out
  }

  if (source.size <= OSS_MIN_PART_SIZE) {
    // ── 小文件：单次 PUT + callback 头 ──
    checkCancel()
    const headers = await ossV1Sign('PUT', base, token, {
      ...cbHeaders,
      'content-type': 'application/octet-stream',
    })
    await opts.onProgress?.(0, source.size)
    const r = await fetchFn(base, {
      method: 'PUT',
      headers,
      body: asBody(await bodyOf(0, source.size)),
      signal: opts.signal,
    })
    if (r.status >= 400) {
      throw new Error(
        `OSS 单片 PUT 失败: ${ossErrorSummary(r.status, await r.text())}`,
      )
    }
    await opts.onProgress?.(source.size, source.size)
    return
  }

  // ── 大文件：multipart 严格串行 ──
  const partsize = determinePartsize(source.size)
  const totalParts = Math.ceil(source.size / partsize)
  let uploadId = await multipartInit(fetchFn, base, token, opts.signal)

  try {
    // state：token/uploadId 可能被续传分支改写；complete 必须用最终值
    const parts = new Map<number, string>()
    let doneBytes = 0
    let start = 1
    let restarts = 0
    let refreshFails = 0

    while (true) {
      try {
        for (let number = start; number <= totalParts; number++) {
          checkCancel()
          const offset = (number - 1) * partsize
          const length = Math.min(partsize, source.size - offset)
          if (parts.has(number)) {
            doneBytes += length
            await opts.onProgress?.(doneBytes, source.size)
            continue
          }
          let url = `${base}?partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`
          // ── 单 part 内循环：PUT → STS 错误 → refresh + ListParts + 重试 ──
          let etag: string | undefined
          while (etag === undefined) {
            try {
              etag = await withBackoff(
                async () => {
                  checkCancel()
                  // 每次尝试重建签名（date 会变）与 body（流不可复用）
                  const headers = await ossV1Sign(
                    'PUT',
                    url,
                    token,
                    { 'content-type': 'application/octet-stream' },
                  )
                  const r = await fetchFn(url, {
                    method: 'PUT',
                    headers,
                    body: asBody(await bodyOf(offset, length)),
                    signal: opts.signal,
                  })
                  if (r.status >= 400) {
                    const text = await r.text()
                    if (opts.tokenRefresher && isStsError(r.status, text)) {
                      throw new StsExpiredError(r.status, text)
                    }
                    throw new Error(
                      `OSS 分片#${number} PUT 失败: ${ossErrorSummary(r.status, text)}`,
                    )
                  }
                  return r.headers.get('ETag') ?? ''
                },
                {
                  baseMs: 2000,
                  maxRetries: opts.maxRetriesPerPart ?? 3,
                  noRetry: (e) => e instanceof StsExpiredError || e instanceof TaskCancelledError,
                },
              )
            } catch (e) {
              if (!(e instanceof StsExpiredError)) throw e
              // ── 续传触发点 ──
              if (!opts.tokenRefresher) {
                throw new Error('STS 过期但未提供 tokenRefresher')
              }
              try {
                token = await opts.tokenRefresher()
                refreshFails = 0
              } catch (refE) {
                refreshFails += 1
                if (refreshFails >= MAX_REFRESH_FAILS) {
                  throw new AuthRequiredError(
                    `连续 ${MAX_REFRESH_FAILS} 次 STS refresh 失败: ${String(refE)}`,
                  )
                }
                continue // 刷新失败先重试当前 part（期待恢复）
              }
              const existing = await listParts(fetchFn, base, uploadId, token)
              for (const p of existing) parts.set(p.number, p.etag)
              if (parts.has(number)) {
                etag = parts.get(number)! // 服务端已记录（网络抖动期间完成）
                break
              }
              url = `${base}?partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`
            }
          }
          parts.set(number, etag)
          doneBytes += length
          await opts.onProgress?.(doneBytes, source.size)
        }
        await multipartComplete(
          fetchFn,
          base,
          uploadId,
          [...parts].map(([number, etag]) => ({ number, etag })),
          token,
          cbHeaders,
          opts.signal,
        )
        return
      } catch (e) {
        if (e instanceof SessionDeadError) {
          restarts += 1
          if (restarts > MAX_SESSION_RESTARTS) {
            throw new OssSessionLostError(source.size, totalParts)
          }
          // 会话已死：重新 init + 全传（仅一次机会）
          uploadId = await multipartInit(fetchFn, base, token, opts.signal)
          parts.clear()
          start = 1
          doneBytes = 0
          continue
        }
        throw e
      }
    }
  } catch (e) {
    // 用户取消：best-effort 释放 OSS 残留（abort 失败吞掉）；其他错误不 abort，
    // 让外层决策重试（旧 uploadId 由 OSS 7 天 GC）
    if (e instanceof TaskCancelledError) {
      await multipartAbort(fetchFn, base, uploadId, token).catch(() => {})
    }
    throw e
  }
}

async function multipartInit(
  fetchFn: FetchLike,
  base: string,
  token: OssToken,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${base}?sequential=1&uploads=1`
  const headers = await ossV1Sign('POST', url, token, {
    'content-type': 'application/octet-stream',
  })
  const r = await fetchFn(url, { method: 'POST', headers, signal })
  const text = await r.text()
  if (r.status >= 400) {
    const mine = ossV1StringToSign('POST', url, headers)
    throw new Error(
      `OSS init 失败: ${ossErrorSummary(r.status, text)}\n      └─ 我方 StringToSign:\n${mine}`,
    )
  }
  const uploadId = parseUploadIdXml(text)
  if (!uploadId) throw new Error(`OSS init 未返回 UploadId: ${text.slice(0, 200)}`)
  return uploadId
}

/** GET ?uploadId=ID：已成功分片列表。404/NoSuchUpload → SessionDeadError。 */
async function listParts(
  fetchFn: FetchLike,
  base: string,
  uploadId: string,
  token: OssToken,
): Promise<{ number: number; etag: string }[]> {
  const url = `${base}?uploadId=${encodeURIComponent(uploadId)}`
  const headers = await ossV1Sign('GET', url, token)
  const r = await fetchFn(url, { method: 'GET', headers })
  const text = await r.text()
  if (r.status === 404 || text.includes('NoSuchUpload')) throw new SessionDeadError()
  if (r.status >= 400) {
    throw new Error(`OSS ListParts 失败: ${ossErrorSummary(r.status, text)}`)
  }
  return parseListPartsXml(text)
}

async function multipartComplete(
  fetchFn: FetchLike,
  base: string,
  uploadId: string,
  parts: { number: number; etag: string }[],
  token: OssToken,
  cbHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${base}?uploadId=${encodeURIComponent(uploadId)}`
  const headers = await ossV1Sign('POST', url, token, {
    ...cbHeaders,
    'content-type': 'text/xml',
  })
  const r = await fetchFn(url, {
    method: 'POST',
    headers,
    body: asBody(completeBody(parts)),
    signal,
  })
  if (r.status >= 400) {
    throw new Error(
      `OSS complete 失败: ${ossErrorSummary(r.status, await r.text())}`,
    )
  }
}

/** DELETE ?uploadId=ID。仅用于取消路径；任何错误吞掉，不阻塞取消语义。 */
async function multipartAbort(
  fetchFn: FetchLike,
  base: string,
  uploadId: string,
  token: OssToken,
): Promise<void> {
  const url = `${base}?uploadId=${encodeURIComponent(uploadId)}`
  try {
    const headers = await ossV1Sign('DELETE', url, token)
    const r = await fetchFn(url, { method: 'DELETE', headers })
    if (r.status >= 400) {
      console.warn(`OSS abort 失败 status=${r.status}（忽略）`)
    }
  } catch (e) {
    console.warn('OSS abort 异常（忽略）:', e)
  }
}

/** 便利导出：给传输层做「小睡重试」等场景（保持与 rate.ts 解耦的入口） */
export { sleep }
