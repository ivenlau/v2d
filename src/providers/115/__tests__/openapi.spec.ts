/**
 * Open115Client 行为测试。
 * - poll_qr_status 语义移植自 tg115bot tests/test_oss_protocol.py::test_poll_qr_status_semantics
 * - token 失效自动刷新重试、upload/init 表单、offline/add_task_urls 流程为协议级回归
 */

import { describe, expect, it } from 'vitest'
import {
  AuthRequiredError,
  CODE_NEED_REAUTH,
  Open115Client,
} from '../openapi'
import { RateLimiter } from '../rate'
import { createMemoryStorage } from '../env'

function jsonResp(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fastClient(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
  return new Open115Client({ fetchFn, rateLimiter: new RateLimiter(0, 0) })
}

describe('poll_qr_status 语义', () => {
  it('data.status 直通（0/1/2/-1/-2）；state 误判回归；异常返回 null', async () => {
    const run = async (payload: unknown, netErr = false): Promise<number | null> => {
      const client = fastClient(async () => {
        if (netErr) throw new Error('network')
        return jsonResp(payload)
      })
      return client.pollQrStatus('u', 1, 's')
    }
    expect(await run({ state: true, data: { status: 0 } })).toBe(0)
    expect(await run({ state: true, data: { status: 1 } })).toBe(1)
    expect(await run({ state: true, data: { status: 2 } })).toBe(2)
    expect(await run({ state: true, data: { status: -1 } })).toBe(-1)
    expect(await run({ state: true, data: { status: -2 } })).toBe(-2)
    // 回归：顶层 state=0/false 不再被误判为二维码过期
    expect(await run({ state: 0, data: { status: 0 } })).toBe(0)
    // 网络异常/响应异常 -> null（调用方继续轮询）
    expect(await run({}, true)).toBeNull()
    expect(await run({ unexpected: 1 })).toBeNull()
    expect(await run({ data: 'notadict' })).toBeNull()
  })
})

describe('token 失效自动刷新并重试一次', () => {
  it('40140125 -> refreshToken -> 原请求重试成功，token 已持久化', async () => {
    let initCalls = 0
    const storage = createMemoryStorage()
    const client = new Open115Client({
      storage,
      rateLimiter: new RateLimiter(0, 0),
      fetchFn: async (url, init) => {
        if (url.includes('/open/upload/init')) {
          initCalls += 1
          if (initCalls === 1) {
            return jsonResp({ state: false, code: 40140125, error: 'token expired' })
          }
          return jsonResp({ code: 0, state: true, data: { status: 2 } })
        }
        if (url.includes('/open/refreshToken')) {
          expect(String(init?.body)).toContain('refresh_token=rt1')
          expect(String(init?.body)).not.toContain('Authorization')
          return jsonResp({ state: true, data: { access_token: 'at2', refresh_token: 'rt2' } })
        }
        throw new Error(`unexpected url: ${url}`)
      },
    })
    await client.importTokens({ access_token: 'at1', refresh_token: 'rt1' })

    const data = await client.uploadInit('a.mp4', 123, 'SHA1', 0)
    expect(data.status).toBe(2)
    expect(initCalls).toBe(2)
    const saved = (await storage.get('115.open_token')) as { access_token: string }
    expect(saved.access_token).toBe('at2')
    expect(client.accessToken).toBe('at2')
  })

  it(`授权解除 (${CODE_NEED_REAUTH.join('/')}) 不重试，直接要求重新扫码`, async () => {
    let calls = 0
    const client = fastClient(async () => {
      calls += 1
      return jsonResp({ state: false, code: CODE_NEED_REAUTH[0] })
    })
    await client.importTokens({ access_token: 'at', refresh_token: 'rt' })
    await expect(client.userSpace()).rejects.toBeInstanceOf(AuthRequiredError)
    expect(calls).toBe(1)
  })

  it('40140126 且 storage 已被其他上下文刷新 → 直接复用新 token 重试，不发 refresh', async () => {
    const storage = createMemoryStorage()
    await storage.set('115.open_token', { access_token: 'at1', refresh_token: 'rt1' })
    let userCalls = 0
    let refreshCalls = 0
    const authHeaders: string[] = []
    const client = new Open115Client({
      storage,
      rateLimiter: new RateLimiter(0, 0),
      fetchFn: async (url, init) => {
        if (url.includes('/open/user/info')) {
          userCalls += 1
          authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''))
          if (userCalls === 1) {
            // 模拟：响应返回的同时，另一上下文（options 页/worker）刚刷新了 token 并写入 storage
            await storage.set('115.open_token', { access_token: 'at2', refresh_token: 'rt2' })
            return jsonResp({ state: false, code: 40140126 })
          }
          return jsonResp({ code: 0, state: true, data: { used_size: 1, size_total: 2 } })
        }
        if (url.includes('/open/refreshToken')) {
          refreshCalls += 1
          throw new Error('should not refresh')
        }
        throw new Error(`unexpected url: ${url}`)
      },
    })
    await client.loadToken()

    const space = await client.userSpace()
    expect(space).toEqual({ used: 1, total: 2 })
    expect(userCalls).toBe(2)
    expect(refreshCalls).toBe(0)
    expect(authHeaders[1]).toBe('Bearer at2')
  })
})

describe('多上下文 token 水合', () => {
  it('worker 场景：未显式 loadToken，鉴权请求自动从 storage 水合（回归：40140123）', async () => {
    const storage = createMemoryStorage()
    await storage.set('115.open_token', { access_token: 'atX', refresh_token: 'rtX' })
    const authHeaders: string[] = []
    // 模拟 offscreen worker：client115() 构造后直接发业务请求，从不显式 loadToken
    const client = new Open115Client({
      storage,
      rateLimiter: new RateLimiter(0, 0),
      fetchFn: async (url, init) => {
        if (url.includes('/open/user/info')) {
          authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''))
          return jsonResp({ code: 0, state: true, data: { used_size: 1, size_total: 2 } })
        }
        throw new Error(`unexpected url: ${url}`)
      },
    })
    const space = await client.userSpace()
    expect(space).toEqual({ used: 1, total: 2 })
    expect(authHeaders[0]).toBe('Bearer atX')
    expect(client.hasToken()).toBe(true)
  })
})

describe('upload/init 表单协议', () => {
  it('file_name/file_size/target=U_1_{cid}/fileid + Bearer 头；sign_key/sign_val 可选', async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = []
    const client = fastClient(async (url, init) => {
      calls.push({
        url,
        body: String(init?.body ?? ''),
        auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
      })
      return jsonResp({ code: 0, state: true, data: { pick_code: 'pc' } })
    })
    await client.importTokens({ access_token: 'at', refresh_token: 'rt' })

    const data = await client.uploadInit('电影.mp4', 42, 'ABCDEF', 7)
    expect(data.pick_code).toBe('pc')
    const form = new URLSearchParams(calls[0].body)
    expect(form.get('file_name')).toBe('电影.mp4')
    expect(form.get('file_size')).toBe('42')
    expect(form.get('target')).toBe('U_1_7')
    expect(form.get('fileid')).toBe('ABCDEF')
    expect(form.has('sign_key')).toBe(false)
    expect(calls[0].auth).toBe('Bearer at')

    // 二次区间校验形态
    await client.uploadInit('电影.mp4', 42, 'ABCDEF', 7, 'key1', 'VAL')
    const form2 = new URLSearchParams(calls[1].body)
    expect(form2.get('sign_key')).toBe('key1')
    expect(form2.get('sign_val')).toBe('VAL')
  })
})

describe('offline/add_task_urls 流程', () => {
  it('递归建目录（20004 容错）后以单 URL 字符串提交，wp_path_id 为 cid', async () => {
    const bodies: string[] = []
    const urls: string[] = []
    const client = fastClient(async (url, init) => {
      const body = String(init?.body ?? '')
      if (url.includes('/open/folder/get_info')) {
        return jsonResp({ state: false, code: 201, error: 'not found' })
      }
      if (url.includes('/open/folder/add')) {
        bodies.push(body)
        return jsonResp({ state: false, code: 20004, error: 'exist' })
      }
      if (url.includes('/open/offline/add_task_urls')) {
        urls.push(body)
        return jsonResp({ code: 0, state: true, data: {} })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    await client.importTokens({ access_token: 'at', refresh_token: 'rt' })

    // getFileInfoRetry 首次就取到（模拟目录已在建目录延迟后可见）
    let getInfoCalls = 0
    const origFetch = client['fetchFn']
    ;(client as unknown as { fetchFn: typeof origFetch }).fetchFn = async (url, init) => {
      if (String(url).includes('/open/folder/get_info')) {
        getInfoCalls += 1
        if (getInfoCalls >= 2) {
          return jsonResp({ code: 0, state: true, data: { file_id: 123 } })
        }
        return jsonResp({ state: false })
      }
      return origFetch(url, init)
    }

    await client.offlineAdd('http://a.com/video.mp4', '/来自浏览器')
    expect(urls).toHaveLength(1)
    const form = new URLSearchParams(urls[0])
    // ⚠️ urls 字段是单个 URL 字符串（尽管名字是复数）
    expect(form.get('urls')).toBe('http://a.com/video.mp4')
    expect(form.get('wp_path_id')).toBe('123')
  })
})

describe('扫码授权', () => {
  it('startQrAuth 携带 PKCE challenge；exchangeQrToken 用 verifier 换 token', async () => {
    const client = fastClient(async (url, init) => {
      if (url.includes('/open/authDeviceCode')) {
        const form = new URLSearchParams(String(init?.body ?? ''))
        expect(form.get('client_id')).toBe(String(client.appId))
        expect(form.get('code_challenge_method')).toBe('sha256')
        expect((form.get('code_challenge') ?? '').length).toBe(43) // base64url(sha256) 固定 43 字符
        return jsonResp({
          code: 0,
          state: true,
          data: { uid: 'u1', time: '1737000000', sign: 'sig', qrcode: 'https://qr/xxx' },
        })
      }
      if (url.includes('/open/deviceCodeToToken')) {
        const form = new URLSearchParams(String(init?.body ?? ''))
        expect(form.get('uid')).toBe('u1')
        expect(form.get('code_verifier')).toBeTruthy()
        return jsonResp({
          code: 0,
          state: true,
          data: { access_token: 'at', refresh_token: 'rt' },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })

    const start = await client.startQrAuth()
    expect(start.qrcode).toBe('https://qr/xxx')
    await client.exchangeQrToken(start.uid, start.verifier)
    expect(client.hasToken()).toBe(true)
  })
})
