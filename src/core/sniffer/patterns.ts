/**
 * 嗅探判定与打分（方案 §4）。
 * 性能红线：本模块在 webRequest 回调里逐请求执行——全部为廉价的字符串/正则操作，
 * 任何未命中请求应在微秒级返回。
 */

import type { MediaKind } from '../types'

const PLAYLIST_EXTS = new Set(['m3u8', 'm3u', 'mpd'])
/** 分段特征扩展（HLS/DASH 分段，与 playlist 共存时不重复登记） */
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'mp4'])
const MEDIA_EXTS = new Set([
  'mp4', 'webm', 'flv', 'mov', 'mkv', 'm4a', 'aac', 'mp3', 'ts', 'm4s',
])
const PLAYLIST_MIME_RE = /mpegurl|dash\+xml/i

/** 明显噪音路径特征（缩略图/雪碧图等） */
const NOISE_RE = /(favicon|sprite|thumbnail|thumb_|avatar|preview\.|logo|watermark|\/blank\.)/i

export interface RequestClass {
  kind: MediaKind
  ext: string
}

/** 从 URL 提取扩展名（忽略 query） */
export function urlExt(url: string): string {
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 请求分类：非媒体返回 null。
 * @param contentLength 分段去噪用（file 类 <100KB 视为封面/片段噪声）
 */
export function classifyRequest(
  rawUrl: string,
  mime?: string,
  contentLength?: number,
): RequestClass | null {
  if (!rawUrl || rawUrl.startsWith('data:')) return null
  if (NOISE_RE.test(rawUrl)) return null

  const ext = urlExt(rawUrl)
  if (PLAYLIST_EXTS.has(ext)) return { kind: ext === 'mpd' ? 'dash' : 'hls', ext }
  if (ext === 'mpd') return { kind: 'dash', ext }

  const isPlaylistMime = mime ? PLAYLIST_MIME_RE.test(mime) : false
  if (isPlaylistMime) return { kind: ext === 'mpd' ? 'dash' : 'hls', ext: ext || 'm3u8' }

  if (MEDIA_EXTS.has(ext)) {
    if (SEGMENT_EXTS.has(ext) && (contentLength === undefined || contentLength < 100 * 1024)) {
      // 无长度信息时保守登记（可能是整片 ts）；有长度且很小则为噪声
      if (contentLength !== undefined) return null
    } else if (contentLength !== undefined && contentLength < 100 * 1024) {
      return null
    }
    return { kind: 'file', ext }
  }

  const isMediaMime = mime ? /^(video|audio)\//i.test(mime) : false
  if (isMediaMime && (contentLength === undefined || contentLength >= 100 * 1024)) {
    return { kind: 'file', ext: ext || extFromMime(mime!) || 'bin' }
  }
  return null
}

function extFromMime(mime: string): string {
  const table: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-flv': 'flv',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/mp2t': 'ts',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
  }
  const base = mime.split(';')[0].trim().toLowerCase()
  return table[base] ?? ''
}

/** 候选展示打分（高分在前）：playlist > 视频 mime/常见扩展 > 大文件 */
export function scoreCandidate(c: {
  kind: MediaKind
  mime?: string
  size?: number
}): number {
  let s = 0
  if (c.kind === 'hls') s += 40
  else if (c.kind === 'dash') s += 38
  else if (c.kind === 'file') s += 20
  if (c.mime && /^video\//i.test(c.mime)) s += 30
  else if (c.mime && /^audio\//i.test(c.mime)) s += 10
  if (c.size) s += Math.min(25, Math.log2(c.size / 1024 + 1)) // 1KB→0, 1GB→20
  return s
}

/** hostname 是否命中黑名单（精确或子域后缀） */
export function hostInBlacklist(hostname: string, blacklist: string[]): boolean {
  return blacklist.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^www\./, '')
    if (!e) return false
    const h = hostname.toLowerCase()
    return h === e || h.endsWith('.' + e)
  })
}
