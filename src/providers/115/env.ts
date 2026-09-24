/**
 * 平台端口（Ports）：协议层不直接依赖 chrome.* / 全局环境，
 * 全部经由可注入端口，便于单元测试与跨端复用（桌面 Chrome / iOS Safari）。
 */

/** 异步 KV 存储（扩展内包装 chrome.storage.local；测试用内存实现） */
export interface JsonStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** DOM BodyInit 的 TS 泛型歧义规避（Uint8Array<ArrayBufferLike> 运行时完全合法） */
export const asBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit

export function createMemoryStorage(): JsonStorage {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
  }
}
