/**
 * 站点探针注册表（M5 站点适配层）：按域名按需注入 MAIN-world 自包含读取函数，
 * 从页面 SSR 全局量提取媒体数据并构造候选。零常驻开销——只在 popup 打开时执行一次。
 *
 * 通用原则：探针函数体必须自包含（不能引用外部闭包）；取不到数据静默返回 null/[]。
 */

import type { MediaCandidate } from '@/core/types'
import { buildFileName } from '@/core/name'
import { fingerprint } from '@/core/sniffer/hash'

export interface SiteProbe {
  name: string
  hostPattern: RegExp
  run(tabId: number): Promise<MediaCandidate[]>
}

// ── B站：DASH 双轨（__playinfo__） ──────────────────────────────────────
async function runBilibili(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const w = window as unknown as {
        __playinfo__?: {
          data?: { dash?: { video?: any[]; audio?: any[] } }
          dash?: { video?: any[]; audio?: any[] }
        }
        __INITIAL_STATE__?: { videoData?: { title?: string; bvid?: string } }
      }
      const dash = w.__playinfo__?.data?.dash ?? w.__playinfo__?.dash
      if (!dash?.video?.length) return null
      // mcdn 系 P2P CDN 需改写 Host，无法直连 → 选第一个非 mcdn 地址
      const pick = (v: { baseUrl?: string; backupUrl?: string[] }): string => {
        const urls = [v.baseUrl, ...(v.backupUrl ?? [])].filter(Boolean) as string[]
        return urls.find((u) => !u.includes('mcdn')) ?? urls[0]
      }
      const QN: Record<number, string> = {
        127: '8K', 126: '杜比', 125: 'HDR', 120: '4K', 116: '1080P60', 112: '1080P+',
        80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P',
      }
      const state = w.__INITIAL_STATE__?.videoData
      return {
        title: state?.title || document.title.replace(/_哔哩哔哩_bilibili.*$/, '').trim(),
        bvid: state?.bvid || '',
        videos: dash.video.map((v: { id: number; baseUrl: string; backupUrl?: string[]; bandwidth?: number }) => ({
          url: pick(v),
          quality: QN[v.id] ?? String(v.id),
          bandwidth: v.bandwidth,
        })),
        audio: dash.audio?.[0] ? pick(dash.audio[0]) : undefined,
      }
    },
  })
  if (!result?.videos?.length) return []
  const topUrl = result.videos[0].url
  return [
    {
      id: fingerprint('dash|' + (result.bvid || result.title || topUrl)),
      tabId,
      url: topUrl,
      kind: 'dash',
      origin: 'dom',
      dashAudioUrl: result.audio,
      variants: result.videos.map((v: { url: string; quality: string; bandwidth?: number }) => ({
        url: v.url,
        quality: v.quality,
        bandwidth: v.bandwidth,
      })),
      fileName: buildFileName({ title: result.title, url: topUrl, ext: 'mp4' }),
      pageTitle: result.title,
      probed: true,
      discoveredAt: Date.now(),
    },
  ]
}

// ── 抖音：SSR 路由数据里的无水印播放地址 ────────────────────────────────
async function runDouyin(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const r = (window as unknown as { _ROUTER_DATA?: { loaderData?: Record<string, { videoInfoRes?: { item_list?: any[] } }> } })._ROUTER_DATA
      const loader = r?.loaderData
      if (!loader) return null
      for (const page of Object.values(loader)) {
        const item = page?.videoInfoRes?.item_list?.[0]
        const uri = item?.video?.play_addr?.uri
        if (item && uri) {
          return {
            // ratio=1080p → 无水印源画质（抖音 Web 端经典取法）
            url: `https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`,
            title: String(item.desc ?? '').trim(),
          }
        }
      }
      return null
    },
  })
  if (!result?.url) return []
  const url = result.url as string
  return [
    {
      id: fingerprint('file|' + url),
      tabId,
      url,
      kind: 'file',
      origin: 'dom',
      fileName: buildFileName({ title: result.title as string, url, ext: 'mp4' }),
      pageTitle: result.title as string,
      probed: true,
      discoveredAt: Date.now(),
    },
  ]
}

// ── 快手：Apollo SSR 缓存里的 mainMvUrls（深度查找，容忍结构变化） ──────
async function runKuaishou(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const found: { url: string | null; desc: string | null } = { url: null, desc: null }
      const seen: unknown[] = []
      const walk = (o: unknown): void => {
        if (!o || typeof o !== 'object' || seen.includes(o) || found.url) return
        seen.push(o)
        if (Array.isArray(o)) {
          o.forEach(walk)
          return
        }
        const m = (o as { mainMvUrls?: { urls?: { url?: string }[] }; caption?: string }).mainMvUrls
        if (m?.urls?.length && m.urls[0]?.url) {
          found.url = m.urls[0].url
          found.desc = (o as { caption?: string }).caption ?? null
          return
        }
        Object.values(o).forEach(walk)
      }
      walk((window as unknown as { __APOLLO_STATE__?: unknown }).__APOLLO_STATE__)
      if (!found.url) return null
      return { url: found.url, title: (found.desc ?? document.title.replace(/ - 快手.*$/, '')).trim() }
    },
  })
  if (!result?.url) return []
  const url = result.url as string
  return [
    {
      id: fingerprint('file|' + url),
      tabId,
      url,
      kind: 'file',
      origin: 'dom',
      fileName: buildFileName({ title: result.title as string, url, ext: 'mp4' }),
      pageTitle: result.title as string,
      probed: true,
      discoveredAt: Date.now(),
    },
  ]
}

// ── 小红书：INITIAL_STATE 的 noteDetailMap，取最高画质流 ─────────────────
async function runXiaohongshu(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const s = (window as unknown as {
        __INITIAL_STATE__?: {
          note?: { noteDetailMap?: Record<string, { note?: { video?: { media?: { videoStream?: { masterUrl?: string; height?: number }[] } }; title?: string } }> }
        }
      }).__INITIAL_STATE__
      const map = s?.note?.noteDetailMap
      if (!map) return null
      for (const entry of Object.values(map)) {
        const streams = entry?.note?.video?.media?.videoStream
        if (Array.isArray(streams) && streams.length) {
          const best = [...streams].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
          if (!best?.masterUrl) continue
          const title = entry?.note?.title || document.title.replace(/ - 小红书$/, '')
          return { url: best.masterUrl, title }
        }
      }
      return null
    },
  })
  if (!result?.url) return []
  const url = result.url as string
  return [
    {
      id: fingerprint('file|' + url),
      tabId,
      url,
      kind: 'file',
      origin: 'dom',
      fileName: buildFileName({ title: result.title as string, url, ext: 'mp4' }),
      pageTitle: result.title as string,
      probed: true,
      discoveredAt: Date.now(),
    },
  ]
}

import { SITE_PROBES_OVERSEAS } from './siteProbesOverseas'

export const SITE_PROBES: SiteProbe[] = [
  { name: 'bilibili', hostPattern: /(^|\.)bilibili\.com$/, run: runBilibili },
  { name: 'douyin', hostPattern: /(^|\.)douyin\.com$/, run: runDouyin },
  { name: 'kuaishou', hostPattern: /(^|\.)kuaishou\.com$/, run: runKuaishou },
  { name: 'xiaohongshu', hostPattern: /(^|\.)xiaohongshu\.com$/, run: runXiaohongshu },
  ...SITE_PROBES_OVERSEAS,
]
