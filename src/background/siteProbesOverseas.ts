/**
 * 海外站点探针（M5.2 + P1.5）。与国内探针同构：MAIN world / DOM 按需读取，零常驻开销。
 * 站点改版频繁，全部为 best-effort：取不到静默返回（通用嗅探兜底），失败信息进任务错误。
 * P1.5 成年向站点用代称标注（P/XV/XN/仓鼠/Y/SB/E 站），域名以 hostPattern 与 REFERER_RULES 为准。
 */

import type { MediaCandidate } from '@/core/types'
import { buildFileName } from '@/core/name'
import { fingerprint } from '@/core/sniffer/hash'
import type { SiteProbe } from './siteProbes'

function fileCand(
  tabId: number,
  url: string,
  title: string,
  opts?: { quality?: string },
): MediaCandidate {
  return {
    id: fingerprint('file|' + url),
    tabId,
    url,
    kind: 'file',
    origin: 'dom',
    fileName: buildFileName({ title, url, ext: 'mp4' }),
    pageTitle: title,
    probed: true,
    discoveredAt: Date.now(),
  }
}

// ── Reddit：公开 JSON API → DASH 双轨（音轨按惯例命名，存在与否由管线探测） ──
async function runReddit(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i)
      if (!m) return null
      const r = await fetch(`${location.origin}/comments/${m[1]}.json?limit=1`, {
        credentials: 'include',
      })
      if (!r.ok) return null
      const j = await r.json()
      const d = j?.[0]?.data?.children?.[0]?.data
      const rv = d?.secure_media?.reddit_video ?? d?.media?.reddit_video
      if (!rv?.fallback_url) return null
      const qm = /DASH_(\d+)\.mp4/.exec(rv.fallback_url)
      return {
        video: rv.fallback_url,
        // 音轨按 Reddit 惯例命名；是否存在由传输管线的 audioOptional 探测降级
        audio: rv.fallback_url.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4'),
        title: String(d?.title ?? '').trim(),
        quality: qm ? qm[1] + 'P' : '',
      }
    },
  })
  if (!result?.video) return []
  return [
    {
      id: fingerprint('dash|' + result.title + result.video.slice(-24)),
      tabId,
      url: result.video,
      kind: 'dash',
      origin: 'dom',
      variants: [{ url: result.video, name: result.quality || '视频' }],
      dashAudioUrl: result.audio,
      dashAudioOptional: true,
      fileName: buildFileName({ title: result.title, url: result.video, ext: 'mp4' }),
      pageTitle: result.title,
      probed: true,
      discoveredAt: Date.now(),
    },
  ]
}

// ── TikTok：SSR 再水合数据里的 playAddr（与抖音同源方案） ───────────────
async function runTikTok(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      let item: any = null
      const ud: any = w.__UNIVERSAL_DATA_FOR_REHYDRATION__
      if (ud) {
        for (const v of Object.values(ud) as any[]) {
          item = v?.loaderData?.['video_(id)/page']?.itemInfo?.itemStruct ?? item
        }
      }
      if (!item) {
        const im = w.SIGI_STATE?.ItemModule
        if (im) item = Object.values(im)[0]
      }
      if (!item?.video?.playAddr) return null
      return { url: item.video.playAddr, title: String(item.desc ?? '').trim() }
    },
  })
  if (!result?.url) return []
  return [fileCand(tabId, result.url as string, result.title as string)]
}

// ── Vimeo：player iframe 的 progressive 配置（多码率取最高） ────────────
async function runVimeo(tabId: number): Promise<MediaCandidate[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => {
      const cfg = (window as any).playerConfig
      const files = cfg?.request?.files?.progressive
      if (!Array.isArray(files) || !files.length) return null
      return {
        title: String(cfg?.video?.title ?? document.title.replace(/\s*on Vimeo\s*$/i, '').trim()),
        files: files
          .map((f: { url?: string; quality?: string }) => ({
            url: f.url ?? '',
            quality: String(f.quality ?? ''),
          }))
          .filter((f) => f.url),
      }
    },
  })
  const frames = results.map((r) => r.result).filter(Boolean) as {
    title: string
    files: { url: string; quality: string }[]
  }[]
  const hit = frames.find((f) => f.files.length)
  if (!hit) return []
  const best = [...hit.files].sort(
    (a, b) => parseInt(b.quality) - parseInt(a.quality) || b.url.length - a.url.length,
  )[0]
  return [fileCand(tabId, best.url, hit.title || 'Vimeo video')]
}

// ── P1.5 成人站点（18+）：内联脚本 / 窗口全局扫描，best-effort ──────────
/** 通用：汇总内联脚本文本 */
function scriptText(): string {
  return [...document.querySelectorAll('script')]
    .map((s) => s.textContent ?? '')
    .join('\n')
}
/** 通用：从 JS 文本提取去转义 URL */
function extractUrls(text: string, ext: 'm3u8' | 'mp4'): string[] {
  const re = new RegExp(`https:(?:\\\\/\\\\/|//)[^"'\\s]+\\.${ext}[^"'\\s]*`, 'g')
  return [...new Set((text.match(re) ?? []).map((u) => u.replace(/\\\//g, '/')))]
}

function hlsCand(tabId: number, url: string, title: string): MediaCandidate {
  return {
    id: fingerprint('hls|' + url),
    tabId,
    url,
    kind: 'hls',
    origin: 'dom',
    fileName: buildFileName({ title, url, ext: 'mp4' }),
    pageTitle: title,
    probed: false,
    discoveredAt: Date.now(),
  }
}

// P 站：mediaDefinitions（含多清晰度 m3u8）
async function runPZhan(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = [...document.querySelectorAll('script')]
        .map((s) => s.textContent ?? '')
        .join('\n')
      const title = document.title.replace(/[-|]\s*[A-Za-z]+\.com\s*$/, '').trim()
      // mediaDefinitions 条目形如 {format:'hls', videoUrl:'https:...'}（URL 可能带 \/ 转义）
      const pairs = [...text.matchAll(/"format"\s*:\s*'hls'[\s\S]{0,200}?"videoUrl"\s*:\s*'([^']+)'/g)]
      let urls = pairs.map((p) => p[1].replace(/\\\//g, '/')).filter((u) => u.startsWith('http'))
      if (!urls.length) {
        urls = [...new Set(
          (text.match(/https:(?:\\\/\\\/|\/\/)[^"'\s]+\.m3u8[^"'\s]*/g) ?? []).map((u) => u.replace(/\\\//g, '/')),
        )]
      }
      if (!urls.length) return null
      return { title, urls }
    },
  })
  if (!result?.urls?.length) return []
  const urls = result.urls as string[]
  if (urls.length === 1) return [hlsCand(tabId, urls[0], result.title)]
  return [
    {
      id: fingerprint('hls|' + urls[0]),
      tabId,
      url: urls[0],
      kind: 'hls',
      origin: 'dom',
      variants: urls.map((url, i) => ({ url, quality: `信号 ${i + 1}` })),
      fileName: buildFileName({ title: result.title, url: urls[0], ext: 'mp4' }),
      pageTitle: result.title,
      probed: true,
      discoveredAt: Date.now(),
    },
  ]
}

// XV 站 / XN 站（同系）：内联 setVideoUrlHigh/Low
async function runXvZhan(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = [...document.querySelectorAll('script')]
        .map((s) => s.textContent ?? '')
        .join('\n')
      const high = /setVideoUrlHigh\('([^']+)'\)/.exec(text)?.[1]
      const low = /setVideoUrlLow\('([^']+)'\)/.exec(text)?.[1]
      const url = high ?? low
      if (!url) return null
      const title = document.title.replace(/\s*[-|]\s*[A-Za-z0-9.]+\s*COM\s*$/i, '').trim()
      return { url: url.replace(/\\\//g, '/'), title }
    },
  })
  if (!result?.url) return []
  return [fileCand(tabId, result.url as string, result.title as string)]
}

// 仓鼠站：MAIN world 的 initials__ 深度收集 m3u8/mp4
async function runHamsterZhan(tabId: number): Promise<MediaCandidate[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const found = new Set<string>()
      const seen: unknown[] = []
      const walk = (o: unknown): void => {
        if (!o || typeof o !== 'object' || seen.includes(o)) return
        seen.push(o)
        if (Array.isArray(o)) {
          o.forEach(walk)
          return
        }
        for (const v of Object.values(o)) {
          if (typeof v === 'string' && /^https:\/\//.test(v) && /\.(m3u8|mp4)(\?|$)/.test(v)) {
            found.add(v)
          } else if (v && typeof v === 'object') {
            walk(v)
          }
        }
      }
      walk((window as unknown as { initials__?: unknown }).initials__)
      if (!found.size) return null
      const urls = [...found]
      const m3u8 = urls.filter((u) => u.endsWith('.m3u8'))
      return { urls: m3u8.length ? m3u8 : urls, title: document.title.replace(/\s*[-|]\s*\w+\s*(\.\w+)?\s*$/i, '').trim() }
    },
  })
  if (!result?.urls?.length) return []
  const urls = result.urls as string[]
  const title = result.title as string
  const m3u8s = urls.filter((u) => u.endsWith('.m3u8'))
  if (m3u8s.length) return [hlsCand(tabId, m3u8s[0], title)]
  return [fileCand(tabId, urls[0], title)]
}

// Y / SB / E 站：内联脚本通用 URL 抓取（m3u8 优先，其次 mp4 取最长）
function makeScriptScrapeProbe(
  name: string,
  hostPattern: RegExp,
  titleStrip: RegExp,
): SiteProbe {
  return {
    name,
    hostPattern,
    run: async (tabId) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (strip: string) => {
          const text = [...document.querySelectorAll('script')]
            .map((s) => s.textContent ?? '')
            .join('\n')
          const m3u8 = [...new Set(
            (text.match(/https:(?:\\\/\\\/|\/\/)[^"'\s]+\.m3u8[^"'\s]*/g) ?? []).map((u) => u.replace(/\\\//g, '/')),
          )]
          const mp4s = [...new Set(
            (text.match(/https:(?:\\\/\\\/|\/\/)[^"'\s]+\.mp4[^"'\s]*/g) ?? []).map((u) => u.replace(/\\\//g, '/')),
          )]
          const title = document.title.replace(new RegExp(strip), '').trim()
          if (m3u8.length) return { kind: 'hls' as const, url: m3u8[0], title }
          if (mp4s.length) {
            const best = [...mp4s].sort((a, b) => b.length - a.length)[0]
            return { kind: 'file' as const, url: best, title }
          }
          return null
        },
        args: [titleStrip.source],
      })
      if (!result) return []
      if (result.kind === 'hls') return [hlsCand(tabId, result.url, result.title)]
      return [fileCand(tabId, result.url, result.title)]
    },
  }
}

export const SITE_PROBES_OVERSEAS: SiteProbe[] = [
  { name: 'reddit', hostPattern: /(^|\.)reddit\.com$/, run: runReddit },
  { name: 'tiktok', hostPattern: /(^|\.)tiktok\.com$/, run: runTikTok },
  { name: 'vimeo', hostPattern: /(^|\.)vimeo\.com$/, run: runVimeo },
  { name: 'site-p', hostPattern: /(^|\.)pornhub\.com$/, run: runPZhan },
  { name: 'site-xv', hostPattern: /(^|\.)xvideos\.com$/, run: (tabId) => runXvZhan(tabId) },
  { name: 'site-xn', hostPattern: /(^|\.)xnxx\./, run: (tabId) => runXvZhan(tabId) },
  { name: 'site-hamster', hostPattern: /(^|\.)xhamster\d*\.com$/, run: runHamsterZhan },
  makeScriptScrapeProbe('site-y', /(^|\.)youporn\.com$/, /\s*[-|]\s*[A-Za-z]+\s*$/i),
  makeScriptScrapeProbe('site-sb', /(^|\.)spankbang\.com$/, /\s*[-|]\s*[A-Za-z]+.*$/i),
  makeScriptScrapeProbe('site-e', /(^|\.)eporner\.com$/, /\s*[-|]\s*[A-Za-z]+.*$/i),
]
