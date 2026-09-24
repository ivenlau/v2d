/**
 * 115 离线下载辅助（对照 tg115bot core/offline.py 移植）。
 * 识别 magnet / ed2k / http(s) 直链；媒体直链有扩展名白名单。
 */

const MAGNET_RE = /^magnet:\?xt=urn:btih:[0-9a-zA-Z]+/
const ED2K_RE = /^ed2k:\/\/\|file\|/
const MEDIA_URL_RE =
  /^https?:\/\/\S+\.(torrent|mp4|mkv|avi|mov|wmv|flv|ts|iso|rar|zip|7z)(\?\S*)?$/i

export type LinkKind = 'magnet' | 'ed2k' | 'url'

/** 严格判定：是否为可直接下载的媒体/种子直链（含扩展名）。 */
export function isMediaUrl(text: string): boolean {
  return MEDIA_URL_RE.test((text || '').trim())
}

/** 识别文本是否为可离线的链接；返回 'magnet' | 'ed2k' | 'url' | null。 */
export function classifyLink(text: string): LinkKind | null {
  const t = (text || '').trim()
  if (!t || t.includes('\n') || t.length > 2048) return null
  if (MAGNET_RE.test(t)) return 'magnet'
  if (ED2K_RE.test(t)) return 'ed2k'
  if (MEDIA_URL_RE.test(t)) return 'url'
  try {
    const u = new URL(t)
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) {
      return 'url' // 泛 http 链接也允许（由调用方决定是否提示）
    }
  } catch {
    // 非 URL 文本
  }
  return null
}
