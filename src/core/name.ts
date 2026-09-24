/** 文件名推断与清洗（下载/上传共用） */

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

export function sanitizeFileName(name: string): string {
  return name.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim().slice(0, 180)
}

/** 从 URL 推断基础文件名（去 query、解码、兜底 hostname） */
export function baseNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? ''
    const decoded = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, '')
    return decoded || u.hostname
  } catch {
    return 'video'
  }
}

/** 最终文件名：标题/URL 基名 + 扩展名（防重复后缀） */
export function buildFileName(opts: {
  title?: string
  url: string
  ext: string
}): string {
  const base = sanitizeFileName(opts.title?.trim() || baseNameFromUrl(opts.url)) || 'video'
  const ext = opts.ext.replace(/^\./, '')
  return base.toLowerCase().endsWith('.' + ext.toLowerCase()) ? base : `${base}.${ext}`
}
