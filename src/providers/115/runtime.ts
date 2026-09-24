/**
 * 扩展运行时装配：把 chrome.storage.local 适配成协议层的 JsonStorage，
 * 提供各上下文（SW / options / offscreen worker）共享语义的 client 实例。
 * token 的持久真相在 storage；client 内存态仅作缓存，失效时靠三段式恢复自愈。
 */

import type { JsonStorage } from './env'
import { Open115Client } from './openapi'

const TOKEN_KEY = '115.open_token'

const chromeStorageAdapter: JsonStorage = {
  async get(key) {
    const obj = await chrome.storage.local.get(key)
    return obj[key]
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value })
  },
  async remove(key) {
    await chrome.storage.local.remove(key)
  },
}

let shared: Open115Client | null = null

export function client115(appId?: number): Open115Client {
  if (!shared) {
    shared = new Open115Client({
      storage: chromeStorageAdapter,
      storageKey: TOKEN_KEY,
      ...(appId !== undefined ? { appId } : {}),
    })
  }
  return shared
}

export const TOKEN_STORAGE_KEY = TOKEN_KEY
