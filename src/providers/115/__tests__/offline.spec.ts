/** 移植自 tg115bot tests/test_oss_protocol.py::test_classify_link */

import { describe, expect, it } from 'vitest'
import { classifyLink, isMediaUrl } from '../offline'

describe('classify_link', () => {
  it('magnet/ed2k/直链/误报防护', () => {
    expect(classifyLink('magnet:?xt=urn:btih:ABCDEF1234567890&dn=t')).toBe('magnet')
    expect(classifyLink('ed2k://|file|name.mkv|12345|hash|/')).toBe('ed2k')
    expect(classifyLink('https://example.com/movie.torrent')).toBe('url')
    expect(classifyLink('http://a.com/video.mp4')).toBe('url')
    expect(classifyLink('https://pan.baidu.com/s/xyz')).toBe('url')
    expect(classifyLink('普通聊天文本')).toBeNull()
    expect(classifyLink('看看这个 https://a.com/x.mp4')).toBeNull()
    expect(classifyLink('magnet:?xt=urn:btih:短')).toBeNull()
    expect(classifyLink('')).toBeNull()
    expect(classifyLink('a'.repeat(3000))).toBeNull()
  })

  it('is_media_url：扩展名白名单严格判定', () => {
    expect(isMediaUrl('http://a.com/video.mp4?token=x')).toBe(true)
    expect(isMediaUrl('https://a.com/movie.MKV')).toBe(true)
    expect(isMediaUrl('https://a.com/page')).toBe(false)
    expect(isMediaUrl('magnet:?xt=urn:btih:ABCDEF1234567890')).toBe(false)
  })
})
