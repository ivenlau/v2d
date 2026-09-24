/** 候选 id 指纹（djb2，非加密用途，仅去重） */
export function fingerprint(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
