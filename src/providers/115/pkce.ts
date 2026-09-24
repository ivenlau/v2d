/**
 * PKCE(S256) 工具（对照 tg115bot cloud115/openapi.py make_pkce_pair）。
 * RFC 7636：verifier 为 64 字符非保留字符集；challenge = base64url(sha256(verifier))。
 */

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function makePkcePair(): Promise<{
  verifier: string
  challenge: string
}> {
  const raw = new Uint8Array(64)
  crypto.getRandomValues(raw)
  // 与 Python 版一致：base64 后过滤非 url-safe 集合再截 64 字符
  const verifier = base64url(raw)
    .replace(/[^A-Za-z0-9\-._~]/g, '')
    .slice(0, 64)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  const challenge = base64url(new Uint8Array(digest))
  return { verifier, challenge }
}
