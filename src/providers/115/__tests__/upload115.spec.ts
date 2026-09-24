/** fastUpload115 编排测试：秒传 / 二次区间校验 / 完整 OSS 直传 */

import { describe, expect, it } from 'vitest'
import type { Open115Client } from '../openapi'
import type { ByteSource } from '../ossUpload'
import { fastUpload115 } from '../upload115'

function memSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length)
    },
  }
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const DATA = new TextEncoder().encode('v2d-test-payload-'.repeat(1000)) // ~17KB
const CID = 7

describe('fastUpload115', () => {
  it('秒传命中：不触发 STS 与 OSS', async () => {
    let getTokenCalls = 0
    const client = {
      uploadInit: async () => ({ status: '2', pick_code: 'pc1' }),
      getUploadToken: async () => {
        getTokenCalls += 1
        throw new Error('should not be called')
      },
    } as unknown as Open115Client

    const res = await fastUpload115(client, {
      fileName: 'a.mp4',
      size: DATA.length,
      cid: CID,
      sha1Hex: await sha1Hex(DATA),
      source: memSource(DATA),
    })
    expect(res.instant).toBe(true)
    expect(res.pickCode).toBe('pc1')
    expect(getTokenCalls).toBe(0)
  })

  it('二次区间校验：sign_val = 区间 SHA1 大写，随 sign_key 重调 init', async () => {
    const inits: Array<Record<string, string>> = []
    const client = {
      uploadInit: async (
        _n: string,
        _s: number,
        _sha: string,
        _cid: number,
        signKey = '',
        signVal = '',
      ) => {
        inits.push({ sign_key: signKey, sign_val: signVal })
        if (inits.length === 1) {
          return { status: '1', sign_key: 'key1', sign_check: '100-199' }
        }
        return { status: '2', pick_code: 'pc2' }
      },
    } as unknown as Open115Client

    const res = await fastUpload115(client, {
      fileName: 'a.mp4',
      size: DATA.length,
      cid: CID,
      sha1Hex: await sha1Hex(DATA),
      source: memSource(DATA),
    })
    expect(res.instant).toBe(true)
    expect(inits).toHaveLength(2)
    expect(inits[0].sign_key).toBe('')
    expect(inits[1].sign_key).toBe('key1')
    // 闭区间 [100, 199] 的 SHA1 大写
    const expected = (await sha1Hex(DATA.subarray(100, 200))).toUpperCase()
    expect(inits[1].sign_val).toBe(expected)
  })

  it('完整直传：init → STS → 小文件单 PUT（带 callback 头）', async () => {
    const client = {
      uploadInit: async () => ({
        status: '0',
        bucket: 'bk',
        object: 'o',
        callback: { callback: '{"cb":1}', callback_var: '{"v":2}' },
        pick_code: 'pc3',
      }),
      getUploadToken: async () => ({
        AccessKeyId: 'AK',
        AccessKeySecret: 'SK',
        SecurityToken: 'ST',
        endpoint: 'oss-cn-shenzhen.aliyuncs.com',
      }),
    } as unknown as Open115Client

    const puts: Array<{ url: string; headers: Record<string, string> }> = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      puts.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response('', { status: 200 })
    }) as typeof fetch

    try {
      const res = await fastUpload115(client, {
        fileName: 'a.mp4',
        size: DATA.length,
        cid: CID,
        sha1Hex: await sha1Hex(DATA),
        source: memSource(DATA),
      })
      expect(res.instant).toBe(false)
      expect(res.pickCode).toBe('pc3')
    } finally {
      globalThis.fetch = origFetch
    }

    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe('http://bk.oss-cn-shenzhen.aliyuncs.com/o')
    expect(puts[0].headers['x-oss-callback']).toBe(btoa('{"cb":1}'))
    expect(puts[0].headers['x-oss-callback-var']).toBe(btoa('{"v":2}'))
    expect(puts[0].headers['x-oss-security-token']).toBe('ST')
    expect(puts[0].headers['authorization']).toMatch(/^OSS AK:/)
  })
})
