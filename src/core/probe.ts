/**
 * 懒探测（§4.4）：列表展示时不发探测请求；需要展示大小/校验可拉性时才发。
 * HEAD 优先，405/不支持时回退 Range: bytes=0-0 读 Content-Range 总长。
 */

export interface ProbeResult {
  ok: boolean
  size?: number
  mime?: string
  /** 服务器不支持 Range（HLS/部分 CDN） */
  acceptRanges?: boolean
  error?: string
}

async function timedFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function probeUrl(url: string): Promise<ProbeResult> {
  try {
    // 1) HEAD
    try {
      const r = await timedFetch(url, { method: 'HEAD' })
      if (r.ok) {
        const size = Number(r.headers.get('content-length') ?? 0) || undefined
        return {
          ok: true,
          size,
          mime: r.headers.get('content-type') ?? undefined,
          acceptRanges: /bytes/i.test(r.headers.get('accept-ranges') ?? ''),
        }
      }
      if (r.status !== 405 && r.status !== 501) {
        return { ok: false, error: `HTTP ${r.status}` }
      }
    } catch {
      // HEAD 网络层失败继续走 Range GET
    }

    // 2) Range GET bytes=0-0
    const r2 = await timedFetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    })
    if (r2.status === 200 || r2.status === 206) {
      const cr = r2.headers.get('content-range') // bytes 0-0/123456
      const m = /\/(\d+)\s*$/.exec(cr ?? '')
      return {
        ok: true,
        size: m ? Number(m[1]) : Number(r2.headers.get('content-length') ?? 0) || undefined,
        mime: r2.headers.get('content-type') ?? undefined,
        acceptRanges: r2.status === 206,
      }
    }
    return { ok: false, error: `HTTP ${r2.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
