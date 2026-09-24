/**
 * 阿里云 OSS 直传纯函数（对照 tg115bot cloud115/oss_upload.py 移植，
 * 黄金样例来自 tests/test_oss_protocol.py —— 签名/分片/complete XML 逐字节一致）。
 *
 * 协议要点：
 *   - V1 签名：StringToSign = METHOD\nContent-MD5\nContent-Type\nDate\n<sorted x-oss-*>\n/bucket<path>?<query>
 *     Authorization: "OSS {AccessKeyId}:{base64(hmac_sha1(AccessKeySecret, StringToSign))}"
 *   - x-oss-security-token 也按字典序参与签名
 *   - 分片 >=10MB，翻倍直到片数 <= 10000（sequential=1 模式要求严格按序提交）
 */

export interface OssToken {
  AccessKeyId: string
  AccessKeySecret: string
  SecurityToken: string
}

export interface OssCallback {
  callback?: string
  callback_var?: string
}

export const OSS_DEFAULT_REGION_HOST = 'oss-cn-shenzhen.aliyuncs.com'
export const OSS_MIN_PART_SIZE = 1024 * 1024 * 10 // OSS/115 要求 >=10MB
export const OSS_MAX_PART_COUNT = 10 ** 4

/** 分片大小：>=10MB，翻倍直到片数 <= 10000 */
export function determinePartsize(size: number): number {
  if (size <= OSS_MIN_PART_SIZE) return OSS_MIN_PART_SIZE
  const n = Math.ceil(size / OSS_MAX_PART_COUNT)
  let partsize = OSS_MIN_PART_SIZE
  while (partsize < n) partsize *= 2
  return partsize
}

/** Python quote(s, safe='/') 等价：encodeURIComponent 后还原 '/'、补编码 !'()* */
function quoteOSS(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, '/')
}

/** 对象访问 URL：{scheme}://{bucket}.{endpoint_host}/{object} */
export function objectUrl(endpoint: string, bucket: string, obj: string): string {
  let ep = (endpoint || '').trim() || `http://${OSS_DEFAULT_REGION_HOST}`
  if (!ep.includes('://')) ep = 'http://' + ep
  const idx = ep.indexOf('://')
  const scheme = ep.slice(0, idx)
  const host = ep.slice(idx + 3).replace(/\/+$/, '')
  return `${scheme}://${bucket}.${host}/${quoteOSS(obj)}`
}

/** 由（已含 date/x-oss-* 的）头构造 StringToSign；Date 行有 x-oss-date 时取其值（官方规则） */
export function ossV1StringToSign(
  method: string,
  url: string,
  headers: Record<string, string>,
): string {
  const u = new URL(url)
  const bucket = u.hostname.split('.')[0]
  const pathQs = u.pathname + u.search
  const xoss = Object.entries(headers)
    .filter(([k]) => k.startsWith('x-oss-'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return [
    method.toUpperCase(),
    headers['content-md5'] ?? '',
    headers['content-type'] ?? '',
    headers['date'] ?? headers['x-oss-date'] ?? '',
    xoss.map(([k, v]) => `${k}:${v}`).join('\n'),
    `/${bucket}${pathQs}`,
  ].join('\n')
}

async function hmacSha1Base64(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  let bin = ''
  new Uint8Array(sig).forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

/** GMT 字符串 / Date → OSS x-oss-date 的 ISO8601 基本格式（20260924T064452Z） */
function toOssIsoDate(existing?: string): string {
  const toIso = (d: Date): string => {
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
    return (
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    )
  }
  if (existing) {
    if (/^\d{8}T\d{6}Z$/.test(existing)) return existing
    const d = new Date(existing)
    if (!Number.isNaN(d.getTime())) return toIso(d)
  }
  return toIso(new Date())
}

/**
 * OSS V1 签名，返回带 Authorization 的完整请求头。
 * ⚠️ 浏览器 fetch 的 Date 是 forbidden header 会被剥除 → OSS 收不到 Date →
 * 403 "requires a valid Date"。因此改发 x-oss-date（ISO8601），签名 StringToSign
 * 的 Date 行按官方规则取 x-oss-date 的值（x-oss-date 同时进入排序的 x-oss-* 块）。
 * date 参数可注入固定值便于测试。
 */
export async function ossV1Sign(
  method: string,
  url: string,
  token: OssToken,
  extraHeaders: Record<string, string> = {},
  date = '',
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v
  headers['x-oss-security-token'] = token.SecurityToken
  headers['x-oss-date'] = toOssIsoDate(
    date || headers['x-oss-date'] || headers['date'],
  )
  delete headers['date']

  const stringToSign = ossV1StringToSign(method, url, headers)
  const signature = await hmacSha1Base64(token.AccessKeySecret, stringToSign)
  headers['authorization'] = `OSS ${token.AccessKeyId}:${signature}`
  return headers
}

export interface CompletedPart {
  number: number
  etag: string
}

/** complete 的 XML body（PartNumber 升序 + ETag 原样含引号） */
export function completeBody(parts: CompletedPart[]): Uint8Array {
  const sorted = [...parts].sort((a, b) => a.number - b.number)
  let body = '<CompleteMultipartUpload>'
  for (const p of sorted) {
    body += `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag}</ETag></Part>`
  }
  body += '</CompleteMultipartUpload>'
  return new TextEncoder().encode(body)
}

function b64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** upload/init 返回的 callback -> 两个 base64 头（缺省为 "{}"，缺头 115 不入库） */
export function callbackHeaders(
  callback?: OssCallback | null,
): Record<string, string> {
  const cb = callback ?? {}
  return {
    'x-oss-callback': b64Utf8(cb.callback || '{}'),
    'x-oss-callback-var': b64Utf8(cb.callback_var || '{}'),
  }
}

const STS_ERROR_CODES = new Set([
  'InvalidAccessKeyId',
  'SecurityTokenExpired',
  'InvalidSecurityToken',
])

/** HTTP 403 + STS 凭证类 Code 才可触发 token 刷新续传；
 *  SignatureDoesNotMatch/RequestTimeTooSkewed 是签名/时钟问题，重试无效。 */
export function isStsError(status: number, text: string): boolean {
  if (status !== 403) return false
  const m = /<Code>([^<]*)<\/Code>/.exec(text)
  return !!m && STS_ERROR_CODES.has(m[1])
}

const OSS_ERR_FIELDS = [
  'Code',
  'Message',
  'StringToSign',
  'RequestId',
  'RequestTime',
  'ServerTime',
  'AccessKeyId',
] as const

/** 解析 OSS 错误 XML，给出可定位原因的一行摘要 */
export function ossErrorSummary(status: number, text: string): string {
  const info: Record<string, string> = {}
  for (const f of OSS_ERR_FIELDS) {
    const m = new RegExp(`<${f}>([^<]*)</${f}>`).exec(text)
    if (m) info[f] = m[1]
  }
  const code = info.Code ?? '?'
  let hint = ''
  if (code === 'RequestTimeTooSkewed') hint = ' —— 本机时钟偏移，校时后重试'
  else if (code === 'SignatureDoesNotMatch') hint = ' —— V1 签名构造有误'
  else if (STS_ERROR_CODES.has(code)) hint = ' —— STS 凭证问题（过期/字段不符）'
  const parts = [`HTTP ${status}`, code]
  if (info.Message) parts.push(info.Message)
  if (info.ServerTime && info.RequestTime) {
    parts.push(`server=${info.ServerTime} local=${info.RequestTime}`)
  }
  return parts.join(' | ') + hint
}

/** 解析 init 响应 XML 中的 UploadId */
export function parseUploadIdXml(text: string): string | null {
  const m = /<UploadId>([^<]+)<\/UploadId>/.exec(text)
  return m ? m[1] : null
}

/** 解析 ListPartsResult XML（>1000 分片翻页场景当前不涉及，IsTruncated 忽略） */
export function parseListPartsXml(text: string): CompletedPart[] {
  const parts: CompletedPart[] = []
  const re = /<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]*)<\/ETag>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    parts.push({ number: Number(m[1]), etag: m[2] })
  }
  return parts.sort((a, b) => a.number - b.number)
}
