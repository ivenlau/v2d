import { describe, expect, it } from 'vitest'
import { RateLimiter, withBackoff } from '../rate'

describe('withBackoff', () => {
  it('失败后重试直至成功', async () => {
    let calls = 0
    const result = await withBackoff(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('flaky')
        return 'ok'
      },
      { baseMs: 1, maxRetries: 5, sleepFn: async () => {} },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('noRetry 错误立即抛出', async () => {
    class Fatal extends Error {}
    let calls = 0
    await expect(
      withBackoff(
        async () => {
          calls += 1
          throw new Fatal('no')
        },
        { baseMs: 1, maxRetries: 5, noRetry: (e) => e instanceof Fatal, sleepFn: async () => {} },
      ),
    ).rejects.toThrow('no')
    expect(calls).toBe(1)
  })

  it('达到上限抛最后一次错误', async () => {
    let calls = 0
    await expect(
      withBackoff(
        async () => {
          calls += 1
          throw new Error(`boom ${calls}`)
        },
        { baseMs: 1, maxRetries: 2, sleepFn: async () => {} },
      ),
    ).rejects.toThrow('boom 3')
    expect(calls).toBe(3)
  })
})

describe('RateLimiter', () => {
  it('间隔为 0 时不等待、串行放行', async () => {
    const rl = new RateLimiter(0, 0, () => Date.now(), async () => {})
    const order: number[] = []
    await Promise.all([
      rl.acquire().then(() => order.push(1)),
      rl.acquire().then(() => order.push(2)),
      rl.acquire().then(() => order.push(3)),
    ])
    expect(order).toEqual([1, 2, 3])
  })
})
