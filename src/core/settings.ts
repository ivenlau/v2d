/** 设置读写（chrome.storage.local，键 'settings'） */

import type { Settings } from './types'
import { DEFAULT_SETTINGS } from './types'

const KEY = 'settings'

export async function loadSettings(): Promise<Settings> {
  const obj = await chrome.storage.local.get(KEY)
  return { ...DEFAULT_SETTINGS, ...((obj[KEY] as Partial<Settings>) ?? {}) }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await chrome.storage.local.set({ [KEY]: next })
  return next
}
