/**
 * 限速与退避（对照 tg115bot utils/rate.py 逐语义移植）。
 *
 * 115 有接口风控：proapi 请求最小间隔 + 抖动串行化；失败按指数退避重试。
 */

import { sleep } from './env'

export class RateLimiter {
  private last = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private minIntervalMs = 300,
    private jitterMs = 200,
    private nowFn: () => number = () => Date.now(),
    private sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  /** 串行化（等价 asyncio.Lock）：保证相邻两次 acquire 间隔 >= minInterval + [0, jitter) */
  acquire(): Promise<void> {
    const task = this.chain.then(async () => {
      const wait = this.minIntervalMs - (this.nowFn() - this.last)
      if (wait > 0) await this.sleepFn(wait + Math.random() * this.jitterMs)
      this.last = this.nowFn()
    })
    this.chain = task.catch(() => {})
    return task
  }
}

export interface BackoffOptions {
  /** 首次重试基础延迟 ms（Python 版 base=2.0 秒） */
  baseMs?: number
  maxRetries?: number
  /** 不可重试错误判定（如取消/STS 过期——由调用方接管） */
  noRetry?: (e: unknown) => boolean
  onRetry?: (attempt: number, delayMs: number, e: unknown) => void
  sleepFn?: (ms: number) => Promise<void>
}

/** 指数退避重试：115 风控/网络错误都需要重试；达到上限抛最后一次错误。 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {},
): Promise<T> {
  const {
    baseMs = 2000,
    maxRetries = 5,
    noRetry,
    onRetry,
    sleepFn = sleep,
  } = opts
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (noRetry?.(e)) throw e
      if (attempt >= maxRetries) throw e
      const delay = baseMs * 2 ** attempt + Math.random() * 1000
      onRetry?.(attempt, delay, e)
      await sleepFn(delay)
    }
  }
}
