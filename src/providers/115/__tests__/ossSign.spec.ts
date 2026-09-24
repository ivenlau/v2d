/**
 * OSS 协议黄金样例测试（移植自 tg115bot tests/test_oss_protocol.py，逐字节断言）。
 * HMAC 用 WebCrypto 原语本身作可信基线，测试价值在 StringToSign 构造与头组装 —— 与
 * Python 测试用 hashlib/hmac 做基线同理。
 */

import { describe, expect, it } from 'vitest'
import {
  OSS_MIN_PART_SIZE,
  callbackHeaders,
  completeBody,
  determinePartsize,
  isStsError,
  objectUrl,
  ossV1Sign,
  ossV1StringToSign,
  parseListPartsXml,
  parseUploadIdXml,
} from '../ossSign'

const TOKEN = {
  AccessKeyId: 'AKIDtest',
  AccessKeySecret: 'SECRETtest',
  SecurityToken: 'STS_TOKEN',
}

async function hmacSha1Base64(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
  let bin = ''
  new Uint8Array(sig).forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

describe('determine_partsize', () => {
  it('基础与倍增语义', () => {
    expect(determinePartsize(0)).toBe(OSS_MIN_PART_SIZE)
    expect(determinePartsize(OSS_MIN_PART_SIZE)).toBe(OSS_MIN_PART_SIZE)
    expect(determinePartsize(OSS_MIN_PART_SIZE + 1)).toBe(OSS_MIN_PART_SIZE)
    // 100MB -> 10 片 <= 10000，仍 10MB
    expect(determinePartsize(100 * 1024 * 1024)).toBe(OSS_MIN_PART_SIZE)
    // 10TB 强制倍增到片数<=10000，且是 10MB 整数倍的最小满足者
    const huge = 10 * 1024 ** 4
    const ps = determinePartsize(huge)
    expect(ps).toBeGreaterThanOrEqual(huge / 10000)
    expect(ps / 2).toBeLessThan(huge / 10000)
    expect(ps % (10 * 1024 * 1024)).toBe(0)
  })
})

describe('object_url', () => {
  it('编码/缺 scheme/缺 endpoint', () => {
    expect(objectUrl('http://oss-cn-shenzhen.aliyuncs.com', 'fhnfile', 'a/b c.mp4')).toBe(
      'http://fhnfile.oss-cn-shenzhen.aliyuncs.com/a/b%20c.mp4',
    )
    expect(objectUrl('oss-cn-shenzhen.aliyuncs.com', 'bk', 'x').startsWith('http://bk.')).toBe(true)
    expect(objectUrl('', 'bk', 'x').includes('oss-cn-shenzhen')).toBe(true)
  })
})

describe('oss_v1_sign', () => {
  it('签名结构：浏览器模式用 x-oss-date（GMT 参数自动转 ISO8601），Date 行取其值', async () => {
    const gmt = 'Mon, 01 Jan 2026 00:00:00 GMT'
    const iso = '20260101T000000Z'
    const url = 'http://fhnfile.oss-cn-shenzhen.aliyuncs.com/obj?partNumber=2&uploadId=ABC'
    const extra = { 'x-oss-callback': 'Y2I=', 'x-oss-callback-var': 'dmFy' }
    const h = await ossV1Sign('PUT', url, TOKEN, extra, gmt)
    expect(h['x-oss-security-token']).toBe('STS_TOKEN')
    // 浏览器 fetch 会剥除 Date 头：不得出现在发出的头里
    expect(h['date']).toBeUndefined()
    expect(h['x-oss-date']).toBe(iso)
    expect(h['authorization'].startsWith('OSS AKIDtest:')).toBe(true)
    // 手工复算：Date 行取 x-oss-date 的值；x-oss-date 也按字典序进入 x-oss-* 块
    const sts = [
      'PUT',
      '',
      '',
      iso,
      'x-oss-callback:Y2I=\nx-oss-callback-var:dmFy\nx-oss-date:20260101T000000Z\nx-oss-security-token:STS_TOKEN',
      '/fhnfile/obj?partNumber=2&uploadId=ABC',
    ].join('\n')
    expect(ossV1StringToSign('PUT', url, h)).toBe(sts)
    const sig = await hmacSha1Base64('SECRETtest', sts)
    expect(h['authorization']).toBe(`OSS AKIDtest:${sig}`)
  })

  it('x-oss-* 头须按字典序参与签名（换序不影响签名）', async () => {
    const url = 'http://bk.h/o'
    const h1 = await ossV1Sign('PUT', url, TOKEN, { 'x-oss-b': '1', 'x-oss-a': '2' }, '20260101T000000Z')
    const h2 = await ossV1Sign('PUT', url, TOKEN, { 'x-oss-a': '2', 'x-oss-b': '1' }, '20260101T000000Z')
    expect(h1['authorization']).toBe(h2['authorization'])
  })
})

describe('complete_body / callback_headers', () => {
  it('XML 按 PartNumber 升序、ETag 原样', () => {
    const dec = new TextDecoder()
    const body = dec.decode(completeBody([{ number: 2, etag: '"etag2"' }, { number: 1, etag: '"etag1"' }]))
    expect(body.startsWith('<CompleteMultipartUpload>')).toBe(true)
    expect(body.endsWith('</CompleteMultipartUpload>')).toBe(true)
    expect(body.indexOf('<PartNumber>1')).toBeLessThan(body.indexOf('<PartNumber>2'))
    expect(body.includes('<ETag>"etag1"</ETag>')).toBe(true)
  })

  it('callback base64；空回调 -> "{}"', () => {
    const h = callbackHeaders({ callback: '{"callbackUrl":"x"}', callback_var: '{"k":"v"}' })
    expect(atob(h['x-oss-callback'])).toBe('{"callbackUrl":"x"}')
    expect(atob(h['x-oss-callback-var'])).toBe('{"k":"v"}')
    const h2 = callbackHeaders(null)
    expect(atob(h2['x-oss-callback'])).toBe('{}')
  })
})

describe('错误识别与 XML 解析', () => {
  it('is_sts_error：只认 403 + 三种 STS Code', () => {
    const xml = (code: string) => `<?xml?><Error><Code>${code}</Code><Message>m</Message></Error>`
    expect(isStsError(403, xml('InvalidAccessKeyId'))).toBe(true)
    expect(isStsError(403, xml('SecurityTokenExpired'))).toBe(true)
    expect(isStsError(403, xml('InvalidSecurityToken'))).toBe(true)
    expect(isStsError(403, xml('SignatureDoesNotMatch'))).toBe(false)
    expect(isStsError(404, xml('NoSuchUpload'))).toBe(false)
  })

  it('UploadId / ListParts XML 解析', () => {
    expect(parseUploadIdXml('<InitiateMultipartUploadResult><UploadId>abc-123</UploadId></InitiateMultipartUploadResult>')).toBe('abc-123')
    const listXml =
      '<ListPartsResult><Part><PartNumber>2</PartNumber><ETag>"e2"</ETag></Part>' +
      '<Part><PartNumber>1</PartNumber><ETag>"e1"</ETag></Part></ListPartsResult>'
    expect(parseListPartsXml(listXml)).toEqual([
      { number: 1, etag: '"e1"' },
      { number: 2, etag: '"e2"' },
    ])
  })
})
