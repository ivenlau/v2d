/**
 * 115 上传编排（对照 tg115bot cloud115/oss.py fast_upload 逐语义移植）：
 *   init(整文件 SHA1 大写) → status==2 秒传命中 → 完成
 *   → 响应含 sign_key+sign_check：对闭区间 [start,end] 算 SHA1（大写）带 sign_key/sign_val 重调
 *   → 仍需上传：get_token(STS) → OSS 直传（uploadToOss，严格串行 + STS 续传语义）
 *
 * ⚠️ 115 STS 每次发放全新凭证、与 OSS multipart 会话绑定：上传途中刷新 STS 即作废已传
 * 分片（NoSuchUpload → 重启一次 → OssSessionLostError）。tokenRefresher 照抄 tg115bot
 * 传入——真实语义由协议决定：能续则续，不能续则快速失败并给出可操作建议。
 */

import { createSHA1 } from 'hash-wasm'
import type { Open115Client } from './openapi'
import type { ByteSource } from './ossUpload'
import { uploadToOss } from './ossUpload'

export interface FastUploadParams {
  fileName: string
  /** 实际字节数（OPFS 暂存后的真实大小） */
  size: number
  /** 目标目录 cid（字符串透传防大整数精度丢失；SW/调用方先用 createDirRecursive 换取） */
  cid: string | number
  /** 整文件 SHA1 小写 hex */
  sha1Hex: string
  source: ByteSource
  signal?: AbortSignal
  /** 上传字节进度（秒传/二验阶段不触发） */
  onUploaded?: (uploaded: number, total: number) => void
}

export interface FastUploadResult {
  /** true = 秒传命中（零上传流量） */
  instant: boolean
  pickCode?: string
}

export async function fastUpload115(
  client: Open115Client,
  params: FastUploadParams,
): Promise<FastUploadResult> {
  const sha1Upper = params.sha1Hex.toUpperCase()

  let data = await client.uploadInit(params.fileName, params.size, sha1Upper, params.cid)
  if (String(data.status) === '2') {
    return { instant: true, pickCode: data.pick_code }
  }

  // 二次区间校验：sign_check 形如 "1234567-2345678"（闭区间字节）
  if (data.sign_key && data.sign_check) {
    const [s, e] = data.sign_check.split('-').map((n) => Number(n.trim()))
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
      throw new Error(`upload/init 返回非法 sign_check: ${data.sign_check}`)
    }
    const len = e - s + 1
    const buf = await params.source.read(s, len)
    const hasher = await createSHA1()
    hasher.init()
    hasher.update(buf)
    const signVal = hasher.digest('hex').toUpperCase()
    data = await client.uploadInit(
      params.fileName,
      params.size,
      sha1Upper,
      params.cid,
      data.sign_key,
      signVal,
    )
    if (String(data.status) === '2') {
      return { instant: true, pickCode: data.pick_code }
    }
  }

  if (!data.bucket || !data.object) {
    throw new Error('upload/init 未返回 OSS 直传参数（bucket/object）')
  }

  const sts = await client.getUploadToken()
  await uploadToOss(
    { size: params.size, read: (o, l) => params.source.read(o, l) },
    {
      endpoint: sts.endpoint ?? '',
      bucket: data.bucket,
      obj: data.object,
      token: sts,
      callback: data.callback,
      signal: params.signal,
      tokenRefresher: () => client.getUploadToken(),
      onProgress: params.onUploaded,
    },
  )
  return { instant: false, pickCode: data.pick_code }
}
