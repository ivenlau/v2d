import { describe, expect, it } from 'vitest'
import { humanizeError } from '../humanize'

describe('humanizeError', () => {
  it('空值原样返回空', () => {
    expect(humanizeError(undefined)).toBe('')
    expect(humanizeError('')).toBe('')
  })

  it('STS 会话丢失 → 可操作建议', () => {
    const out = humanizeError('OSS 分片会话重启 1 次后再次失效...')
    expect(out).toContain('上行带宽')
    expect(out).toContain('离线')
  })

  it('403/404 附提示', () => {
    expect(humanizeError('HTTP 403')).toContain('防盗链')
    expect(humanizeError('HTTP 404')).toContain('失效')
  })

  it('已达日限额 → 0 点恢复提示', () => {
    expect(humanizeError('115 日请求已达安全阈值(9500)')).toContain('0 点')
  })

  it('未知错误原样透传', () => {
    expect(humanizeError('播放列表没有分段')).toBe('播放列表没有分段')
  })
})
