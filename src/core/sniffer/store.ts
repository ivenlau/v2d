/**
 * 候选登记存储：chrome.storage.session（SW 重启不丢、浏览器关闭自动清）。
 * key 按标签页隔离；同 id（kind+url 指纹）去重，字段合并升级。
 */

import type { MediaCandidate } from '../types'

const KEY = (tabId: number) => `cand:${tabId}`
/** 单标签页候选上限（超出丢弃后到的 file 类，playlist 不受限） */
const MAX_PER_TAB = 60

function store(): chrome.storage.StorageArea {
  return chrome.storage.session
}

export async function listCandidates(tabId: number): Promise<MediaCandidate[]> {
  const obj = await store().get(KEY(tabId))
  return (obj[KEY(tabId)] as MediaCandidate[] | undefined) ?? []
}

/** 合并写入：按 id 去重；已存在则字段升级（补 size/mime 等），时间取更早 */
export async function addCandidates(
  tabId: number,
  incoming: MediaCandidate[],
): Promise<MediaCandidate[]> {
  const existing = await listCandidates(tabId)
  const byId = new Map(existing.map((c) => [c.id, c]))
  for (const c of incoming) {
    const prev = byId.get(c.id)
    if (!prev) {
      byId.set(c.id, c)
    } else {
      byId.set(c.id, {
        ...prev,
        ...c,
        // 已探测信息不被无头字段覆盖
        probed: prev.probed || c.probed,
        size: c.size ?? prev.size,
        mime: c.mime ?? prev.mime,
        discoveredAt: Math.min(prev.discoveredAt, c.discoveredAt),
      })
    }
  }
  let all = [...byId.values()]
  if (all.length > MAX_PER_TAB) {
    const playlists = all.filter((c) => c.kind === 'hls' || c.kind === 'dash')
    const files = all
      .filter((c) => c.kind === 'file' || c.kind === 'blob')
      .sort((a, b) => b.discoveredAt - a.discoveredAt)
    all = [...playlists, ...files].slice(0, MAX_PER_TAB)
  }
  await store().set({ [KEY(tabId)]: all })
  return all
}

export async function updateCandidate(
  tabId: number,
  id: string,
  patch: Partial<MediaCandidate>,
): Promise<MediaCandidate | null> {
  const all = await listCandidates(tabId)
  const idx = all.findIndex((c) => c.id === id)
  if (idx < 0) return null
  all[idx] = { ...all[idx], ...patch }
  await store().set({ [KEY(tabId)]: all })
  return all[idx]
}

export async function getCandidate(
  tabId: number,
  id: string,
): Promise<MediaCandidate | null> {
  const all = await listCandidates(tabId)
  return all.find((c) => c.id === id) ?? null
}

export async function clearCandidates(tabId: number): Promise<void> {
  await store().remove(KEY(tabId))
}
