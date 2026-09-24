/** parseMediaPlaylist 详细解析 / IV 规则 / AES-128 解密（M3 管线的协议正确性） */

import { describe, expect, it } from 'vitest'
import {
  decryptAes128Segment,
  ivForSegment,
  parseMediaPlaylist,
  parseM3U8,
} from '../m3u8'

const BASE = 'https://cdn.example.com/v1/playlist.m3u8'

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:5',
  '#EXT-X-KEY:METHOD=AES-128,URI="key1.key",IV=0x9c7db8778570d05c3177c349fd9236aa',
  '#EXTINF:9.5,',
  'seg0.ts',
  '#EXT-X-BYTERANGE:1000@2000',
  '#EXTINF:10.0,',
  'seg1.ts',
  '#EXT-X-BYTERANGE:800',
  '#EXTINF:8.0,',
  'seg2.ts',
  '#EXT-X-KEY:METHOD=NONE',
  '#EXTINF:7.0,',
  'https://other.example.com/abs.ts',
  '#EXT-X-ENDLIST',
].join('\n')

describe('parseMediaPlaylist', () => {
  it('分段/相对 URL/BYTERANGE 累计/逐段密钥/直播/总时长', () => {
    const p = parseMediaPlaylist(MEDIA_PLAYLIST, BASE)
    expect(p.segments).toHaveLength(4)
    expect(p.mediaSequence).toBe(5)
    expect(p.live).toBe(false)
    expect(p.totalDuration).toBeCloseTo(9.5 + 10 + 8 + 7)

    // 相对 URL 解析
    expect(p.segments[0].url).toBe('https://cdn.example.com/v1/seg0.ts')
    // 绝对 URL 原样
    expect(p.segments[3].url).toBe('https://other.example.com/abs.ts')
    // BYTERANGE：显式 offset；缺省 offset = 上一段 offset+length
    expect(p.segments[1].byterange).toEqual({ length: 1000, offset: 2000 })
    expect(p.segments[2].byterange).toEqual({ length: 800, offset: 3000 })
    // 逐段密钥：前段 AES-128，METHOD=NONE 之后明文
    expect(p.segments[0].key?.method).toBe('AES-128')
    expect(p.segments[0].key?.uri).toBe('https://cdn.example.com/v1/key1.key')
    expect(p.segments[3].key ?? null).toBeNull()
  })

  it('无 ENDLIST 判定直播；SAMPLE-AES 标记不支持；EXT-X-MAP 捕获', () => {
    const live = parseMediaPlaylist(
      ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0', '#EXTINF:5,', 'a.ts'].join('\n'),
      BASE,
    )
    expect(live.live).toBe(true)

    const sampleAes = parseMediaPlaylist(
      ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"', '#EXTINF:5,', 'a.ts', '#EXT-X-ENDLIST'].join('\n'),
      BASE,
    )
    expect(sampleAes.unsupportedEncryption).toBe(true)

    const fmp4 = parseMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:5,',
        's0.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      BASE,
    )
    expect(fmp4.mapUrl).toBe('https://cdn.example.com/v1/init.mp4')
    expect(fmp4.segments).toHaveLength(1)
  })

  it('master 解析回归：variants 按带宽降序', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4128000,RESOLUTION=1920x1080',
      'high.m3u8',
    ].join('\n')
    const info = parseM3U8(master, BASE)
    expect(info.type).toBe('master')
    expect(info.variants?.[0].url).toBe('https://cdn.example.com/v1/high.m3u8')
    expect(info.variants?.[0].resolution).toBe('1920x1080')
  })
})

describe('AES-128（HLS）', () => {
  it('IV 规则：显式 hex 优先；缺省为段序号 64 位大端', () => {
    const key = { method: 'AES-128' as const, uri: 'k', ivHex: '0x000000000000000000000000000000ff' }
    expect([...ivForSegment(key, 5)]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff,
    ])
    const noIv = { method: 'AES-128' as const, uri: 'k' }
    expect([...ivForSegment(noIv, 5).subarray(12)]).toEqual([0, 0, 0, 5])
    // 大序号走高 32 位
    expect([...ivForSegment(noIv, 2 ** 32 + 1).subarray(8)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('AES-128-CBC 解密往返（PKCS7）', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const plain = new TextEncoder().encode('v2d-hls-segment-payload-'.repeat(50)) // 非 16 倍数
    const key = await crypto.subtle.importKey('raw', keyBytes as unknown as ArrayBuffer, { name: 'AES-CBC' }, false, ['encrypt'])
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv as unknown as ArrayBuffer }, key, plain as unknown as ArrayBuffer),
    )
    const roundTrip = await decryptAes128Segment(cipher, keyBytes, iv)
    expect([...roundTrip]).toEqual([...plain])
  })
})
