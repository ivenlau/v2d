import { describe, expect, it } from 'vitest'
import { makePkcePair } from '../pkce'

describe('make_pkce_pair (RFC 7636 S256)', () => {
  it('verifier 字符集/长度；challenge = base64url(sha256(verifier))', async () => {
    const { verifier, challenge } = await makePkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(40)
    expect(verifier.length).toBeLessThanOrEqual(64)
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    let bin = ''
    new Uint8Array(digest).forEach((b) => (bin += String.fromCharCode(b)))
    const expectChallenge = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(expectChallenge)
  })
})
