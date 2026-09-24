/**
 * HLS playlist 解析（M1：master 展开清晰度 + media 统计分段/时长/直播/加密；
 * M3 的完整下载管线复用本模块做分段枚举）。
 */

import type { HlsVariant } from './types'

export interface HlsInfo {
  type: 'master' | 'media'
  /** master：清晰度列表（按带宽降序） */
  variants?: HlsVariant[]
  /** media：统计信息 */
  segments?: number
  durationSec?: number
  live?: boolean
  encrypted?: boolean
  /** media 的全部分段 URL（M3 管线用；M1 探测只统计不返回，省内存） */
  segmentUrls?: string[]
}

function resolveUrl(base: string, rel: string): string {
  try {
    return new URL(rel, base).toString()
  } catch {
    return rel
  }
}

export function parseM3U8(text: string, playlistUrl: string): HlsInfo {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))

  if (isMaster) {
    const variants: HlsVariant[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
      const attrs = lines[i].slice('#EXT-X-STREAM-INF'.length).replace(/^:/, '')
      const url = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : undefined
      if (!url) continue
      variants.push({
        url: resolveUrl(playlistUrl, url),
        bandwidth: numAttr(attrs, 'BANDWIDTH') ?? numAttr(attrs, 'AVERAGE-BANDWIDTH'),
        resolution: attrValue(attrs, 'RESOLUTION'),
        name: attrValue(attrs, 'NAME') ?? attrValue(attrs, 'VIDEO-RANGE'),
      })
    }
    variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
    return { type: 'master', variants }
  }

  let segments = 0
  let durationSec = 0
  let encrypted = false
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      segments += 1
      const d = Number(line.split(':')[1]?.split(',')[0] ?? 0)
      if (Number.isFinite(d)) durationSec += d
    } else if (line.startsWith('#EXT-X-KEY') && !/NONE/i.test(line)) {
      encrypted = true
    }
  }
  const live = !lines.some((l) => l.startsWith('#EXT-X-ENDLIST'))
  return { type: 'media', segments, durationSec, live, encrypted }
}

function attrValue(attrs: string, key: string): string | undefined {
  const m = new RegExp(`${key}=("[^"]*"|[^,]*)`).exec(attrs)
  if (!m) return undefined
  return m[1].replace(/^"|"$/g, '') || undefined
}

function numAttr(attrs: string, key: string): number | undefined {
  const v = attrValue(attrs, key)
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

// ── 下载管线用的详细解析（M3） ──────────────────────────────────────────

export interface HlsSegment {
  url: string
  /** EXT-X-BYTERANGE（对同一 URL 的区间请求） */
  byterange?: { length: number; offset: number }
  /** 本段生效的加密（null = 明文） */
  key?: HlsEncryption | null
  /** 时长秒（EXTINF） */
  duration?: number
}

export interface HlsEncryption {
  method: 'AES-128'
  uri: string
  /** 显式 IV（hex，可含 0x 前缀）；缺省时 IV = 段序号 64 位大端 */
  ivHex?: string
}

export interface MediaPlaylistDetails {
  segments: HlsSegment[]
  /** EXT-X-MAP（fMP4 HLS 的初始化段） */
  mapUrl?: string
  mediaSequence: number
  live: boolean
  totalDuration: number
  /** SAMPLE-AES 等不支持的加密方式（应拒绝下载） */
  unsupportedEncryption: boolean
}

/**
 * 详细解析 media playlist：分段列表（含 BYTERANGE/逐段密钥）、MAP、媒体序号、直播判定。
 * 仅支持 AES-128（HLS 点播事实标准）；SAMPLE-AES 标记为 unsupported（通常伴随 DRM）。
 */
export function parseMediaPlaylist(text: string, playlistUrl: string): MediaPlaylistDetails {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const segments: HlsSegment[] = []
  let mediaSequence = 0
  let live = true
  let totalDuration = 0
  let unsupportedEncryption = false
  let mapUrl: string | undefined
  let currentKey: HlsEncryption | null | undefined // undefined = 尚未出现 KEY 行（视为明文）
  let pendingDuration: number | undefined
  let pendingByterange: { length: number; offset: number } | undefined

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = Number(line.split(':')[1] ?? 0) || 0
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      live = false
    } else if (line.startsWith('#EXT-X-MAP')) {
      const uri = attrValue(line.slice('#EXT-X-MAP'.length), 'URI')
      if (uri) mapUrl = resolveUrl(playlistUrl, uri)
    } else if (line.startsWith('#EXT-X-KEY')) {
      const attrs = line.slice('#EXT-X-KEY'.length)
      const method = (attrValue(attrs, 'METHOD') ?? 'NONE').toUpperCase()
      if (method === 'NONE') {
        currentKey = null
      } else if (method === 'AES-128') {
        const uri = attrValue(attrs, 'URI')
        if (!uri) {
          unsupportedEncryption = true
        } else {
          currentKey = {
            method: 'AES-128',
            uri: resolveUrl(playlistUrl, uri),
            ivHex: attrValue(attrs, 'IV'),
          }
        }
      } else {
        // SAMPLE-AES 等：不支持的加密（通常伴随 DRM）
        unsupportedEncryption = true
        currentKey = null
      }
    } else if (line.startsWith('#EXTINF')) {
      const d = Number(line.split(':')[1]?.split(',')[0] ?? 0)
      pendingDuration = Number.isFinite(d) ? d : undefined
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      // <n>[@<o>]；o 缺省 = 上一段 offset+length
      const spec = (line.split(':')[1] ?? '').split('@')
      const length = Number(spec[0]) || 0
      const offset = spec[1] !== undefined ? Number(spec[1]) : undefined
      pendingByterange = { length, offset: Number.isFinite(offset as number) ? (offset as number) : -1 }
    } else if (!line.startsWith('#')) {
      const seg: HlsSegment = { url: resolveUrl(playlistUrl, line), duration: pendingDuration }
      if (currentKey) seg.key = currentKey
      if (pendingByterange) {
        const prev = segments[segments.length - 1]
        const offset =
          pendingByterange.offset >= 0
            ? pendingByterange.offset
            : prev?.byterange
              ? prev.byterange.offset + prev.byterange.length
              : 0
        seg.byterange = { length: pendingByterange.length, offset }
      }
      segments.push(seg)
      totalDuration += pendingDuration ?? 0
      pendingDuration = undefined
      pendingByterange = undefined
    }
  }
  return { segments, mapUrl, mediaSequence, live, totalDuration, unsupportedEncryption }
}

/** HLS AES-128 IV：显式 IV 优先，否则段序号（自 EXT-X-MEDIA-SEQUENCE 起）的 64 位大端 */
export function ivForSegment(key: HlsEncryption, sequence: number): Uint8Array {
  if (key.ivHex) {
    const hex = key.ivHex.replace(/^0x/i, '').padStart(32, '0').slice(-32)
    const iv = new Uint8Array(16)
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return iv
  }
  const iv = new Uint8Array(16)
  // 64 位大端：JS Number 精度内（序列号远小于 2^53）
  const hi = Math.floor(sequence / 2 ** 32)
  const lo = sequence >>> 0
  const view = new DataView(iv.buffer)
  view.setUint32(8, hi)
  view.setUint32(12, lo)
  return iv
}

/** AES-128-CBC（PKCS7）解密单个分段；keyBytes 为 16 字节密钥 */
export async function decryptAes128Segment(
  data: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as unknown as ArrayBuffer, { name: 'AES-CBC' }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as unknown as ArrayBuffer },
    key,
    data as unknown as ArrayBuffer,
  )
  return new Uint8Array(plain)
}
