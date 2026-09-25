/**
 * MV3 Service Worker：轻量协调者（§3.1）。
 *  - 引擎 A：webRequest 观察式监听（唯一常驻开销，handler 内先廉价字符串判定）
 *  - 候选登记（storage.session）+ 每标签页角标
 *  - 消息路由：popup 的列表/探测/下载/DOM 扫描请求
 * 字节流一律不经过 SW —— 传输管线在 offscreen Worker（M2 起）。
 *
 * WXT 约定：所有 chrome.* 访问必须位于 defineBackground 回调内
 * （构建期会对本模块求值，顶层 API 调用会在 fake-browser 下失败）。
 */

import { defineBackground } from '#imports'
import { classifyRequest, hostInBlacklist, scoreCandidate, urlExt } from '@/core/sniffer/patterns'
import { fingerprint } from '@/core/sniffer/hash'
import {
  addCandidates,
  clearCandidates,
  getCandidate,
  listCandidates,
  updateCandidate,
} from '@/core/sniffer/store'
import { probeUrl } from '@/core/probe'
import { parseM3U8 } from '@/core/m3u8'
import { buildFileName } from '@/core/name'
import { loadSettings } from '@/core/settings'
import type { MediaCandidate, Settings } from '@/core/types'
import type { BgRequest } from '@/core/messages'
import { SITE_PROBES } from '@/background/siteProbes'
import {
  applyStagedReady,
  pollAppCommands,
  applyTaskEvent,
  cancelTask,
  clearFinishedTasks,
  deleteTask,
  enqueueOffline,
  enqueueTransfer,
  handleTaskBlob,
  invalidateTaskCache,
  listTasks,
  markTaskSaved,
  pauseTask,
  recoverStuckTasks,
  resumeTask,
  retryTask,
} from '@/background/transfer'

const BADGE_COLOR = '#4f46e5'

// ── 设置缓存（storage.onChanged 失效） ──────────────────────────────────
let settingsCache: Settings | null = null
async function getSettings(): Promise<Settings> {
  if (!settingsCache) settingsCache = await loadSettings()
  return settingsCache
}

// ── 每标签页内存态（SW 生命周期内的快速去重，storage 为持久真相） ────────
const seenIds = new Map<number, Set<string>>()
const tabHasPlaylist = new Map<number, boolean>()

function markSeen(tabId: number, id: string): boolean {
  let set = seenIds.get(tabId)
  if (!set) {
    set = new Set()
    seenIds.set(tabId, set)
  }
  if (set.has(id)) return false
  set.add(id)
  return true
}

async function updateBadge(tabId: number, count: number): Promise<void> {
  if (!(await getSettings()).badge) return
  // MV2（Safari 目标）下 action API 挂在 browserAction 命名空间
  const actionApi = chrome.action ?? (chrome as unknown as { browserAction: typeof chrome.action }).browserAction
  actionApi.setBadgeText({ tabId, text: count > 0 ? String(count) : '' })
}

async function resetTab(tabId: number): Promise<void> {
  seenIds.get(tabId)?.clear()
  tabHasPlaylist.delete(tabId)
  await clearCandidates(tabId)
  await updateBadge(tabId, 0)
}

async function sortCandidates(tabId: number): Promise<MediaCandidate[]> {
  const all = await listCandidates(tabId)
  return all.sort(
    (a, b) => scoreCandidate(b) - scoreCandidate(a) || a.discoveredAt - b.discoveredAt,
  )
}

// ── 探测（懒加载，§4.4） ───────────────────────────────────────────────
async function fetchText(url: string, timeoutMs = 10000): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 探测单个候选：file → 大小/可拉性；hls → playlist 解析（master 展开/media 统计） */
async function probeCandidate(cand: MediaCandidate): Promise<MediaCandidate> {
  try {
    if (cand.kind === 'hls' || cand.kind === 'dash') {
      const text = await fetchText(cand.url)
      const info = parseM3U8(text, cand.url)
      return (
        (await updateCandidate(cand.tabId, cand.id, {
          probed: true,
          probeError: undefined,
          variants: info.variants,
          segments: info.segments,
          durationSec: info.durationSec,
          live: info.live,
          encrypted: info.encrypted,
        })) ?? cand
      )
    }
    const p = await probeUrl(cand.url)
    return (
      (await updateCandidate(cand.tabId, cand.id, {
        probed: true,
        size: p.size ?? cand.size,
        mime: p.mime ?? cand.mime,
        probeError: p.ok ? undefined : p.error,
      })) ?? cand
    )
  } catch (e) {
    return (
      (await updateCandidate(cand.tabId, cand.id, {
        probed: true,
        probeError: e instanceof Error ? e.message : String(e),
      })) ?? cand
    )
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

// ── 引擎 B：DOM 扫描（按需注入，§4.2；函数体必须自包含） ────────────────
function domScanFunc(): {
  items: { src: string; type?: string | null }[]
  blobVideo: boolean
} {
  const items: { src: string; type?: string | null }[] = []
  document.querySelectorAll('video,audio,source').forEach((el) => {
    // video/audio 走 currentSrc；<source> 子元素只有 src 属性
    const media = el as HTMLMediaElement
    const src = media.currentSrc || media.src || el.getAttribute('src') || ''
    if (src) items.push({ src, type: el.getAttribute('type') })
  })
  const blobVideo = !!document.querySelector('video[src^="blob:"]')
  return { items, blobVideo }
}

async function scanDom(tabId: number): Promise<number> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: domScanFunc,
  })
  const { blacklist } = await getSettings()
  const tabUrl = (await chrome.tabs.get(tabId)).url
  const hostname = tabUrl ? new URL(tabUrl).hostname : ''
  if (hostInBlacklist(hostname, blacklist)) return 0

  const cands: MediaCandidate[] = []
  for (const item of result?.items ?? []) {
    const blob = item.src.startsWith('blob:')
    const cls = blob
      ? { kind: 'blob' as const, ext: 'bin' }
      : classifyRequest(item.src, item.type ?? undefined)
    if (!cls) continue
    const url = item.src
    const id = fingerprint(`${cls.kind}|${url}`)
    if (!markSeen(tabId, id)) continue
    cands.push({
      id,
      tabId,
      url,
      kind: cls.kind,
      origin: 'dom',
      mime: item.type ?? undefined,
      fileName: blob ? undefined : buildFileName({ url, ext: cls.ext }),
      discoveredAt: Date.now(),
    })
  }
  const all = await addCandidates(tabId, cands)
  await updateBadge(tabId, all.length)
  return all.length
}

// ── 下载 ───────────────────────────────────────────────────────────────
async function download(
  cand: MediaCandidate,
  variantUrl?: string,
  pageTitle?: string,
): Promise<{ ok: boolean; reason?: string; downloadId?: number }> {
  if (cand.kind === 'blob') {
    return { ok: false, reason: '页面内嵌流（blob:）暂不支持直接下载，深捕获开发中' }
  }
  if (cand.kind === 'hls' || cand.kind === 'dash') {
    // M1 里程碑边界：HLS/DASH 分段合并（remux）在 M3 交付
    return { ok: false, reason: 'HLS/DASH 分段合并下载将在后续版本支持' }
  }
  const rawUrl = variantUrl ?? cand.url
  const fileName = buildFileName({ title: pageTitle, url: rawUrl, ext: urlExt(rawUrl) || 'mp4' })
  try {
    const downloadId = await chrome.downloads.download({
      url: rawUrl,
      filename: `V2D/${fileName}`,
      saveAs: false,
    })
    return { ok: true, downloadId }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── 消息路由 ───────────────────────────────────────────────────────────
async function handle(req: BgRequest): Promise<unknown> {
  switch (req.type) {
    case 'list':
      return { candidates: await sortCandidates(req.tabId) }
    case 'clear':
      await resetTab(req.tabId)
      return { ok: true }
    case 'probe': {
      const cand = await getCandidate(req.tabId, req.id)
      if (!cand) return { error: 'candidate not found' }
      return { candidate: cand.probed ? cand : await probeCandidate(cand) }
    }
    case 'probeMany': {
      const all = await listCandidates(req.tabId)
      const targets = all.filter((c) => req.ids.includes(c.id) && !c.probed)
      await mapLimit(targets, 3, probeCandidate)
      return { candidates: await sortCandidates(req.tabId) }
    }
    case 'download': {
      const cand = await getCandidate(req.tabId, req.id)
      if (!cand) return { error: 'candidate not found' }
      // HLS/DASH 走合并队列；Safari/iOS 无 chrome.downloads，直链本地保存也走队列
      //（worker 下载→OPFS→待保存→用户手势保存）
      if (cand.kind === 'hls' || cand.kind === 'dash' || !import.meta.env.CHROME) {
        if (cand.kind === 'blob') {
          return { ok: false, reason: '页面内嵌流（blob:）暂不支持' }
        }
        const settings = await loadSettings()
        const task = await enqueueTransfer(cand, settings.v115, req.pageTitle, {
          dest: 'local',
          variantUrl: req.variantUrl,
        })
        return { ok: true, queued: true, taskId: task.id }
      }
      return download(cand, req.variantUrl, req.pageTitle)
    }
    case 'hlsInfo': {
      const cand = await getCandidate(req.tabId, req.id)
      if (!cand) return { error: 'candidate not found' }
      return { candidate: cand.probed ? cand : await probeCandidate(cand) }
    }
    case 'scanDom': {
      try {
        return { count: await scanDom(req.tabId) }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'siteProbe': {
      // 站点适配层入口（M5）：注册表分发；失败静默（popup 不受影响）
      try {
        const tab = await chrome.tabs.get(req.tabId)
        const host = tab.url ? new URL(tab.url).hostname : ''
        const { blacklist } = await getSettings()
        if (!host || hostInBlacklist(host, blacklist)) return { ok: false }
        const probe = SITE_PROBES.find((p) => p.hostPattern.test(host))
        if (!probe) return { ok: false }
        const cands = await probe.run(req.tabId)
        let added = false
        const newCands: MediaCandidate[] = []
        for (const c of cands) {
          if (!markSeen(req.tabId, c.id)) {
            await updateCandidate(req.tabId, c.id, {
              variants: c.variants,
              dashAudioUrl: c.dashAudioUrl,
            })
            continue
          }
          added = true
          newCands.push(c)
        }
        if (newCands.length) {
          const all = await addCandidates(req.tabId, newCands)
          await updateBadge(req.tabId, all.length)
        }
        return { ok: true, count: cands.length, added }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'transfer115': {
      const cand = await getCandidate(req.tabId, req.id)
      if (!cand) return { error: 'candidate not found' }
      if (cand.kind === 'blob') {
        return { ok: false, reason: '页面内嵌流（blob:）暂不支持转存' }
      }
      const settings = await loadSettings()
      if (!settings.v115.enabled) {
        return { ok: false, reason: '115 转存未启用（设置页开启并认证）' }
      }
      const task = await enqueueTransfer(cand, settings.v115, req.pageTitle, {
        dest: 'cloud',
        variantUrl: req.variantUrl,
      })
      return {
        ok: true,
        taskId: task.id,
        channel: task.kind === 'hls' ? 'hls-merge' : task.kind === 'dash' ? 'dash-merge' : 'upload',
      }
    }
    case 'transferList':
      return { tasks: await listTasks() }
    case 'transferCancel':
      return { ok: await cancelTask(req.taskId) }
    case 'transferPause':
      return { ok: await pauseTask(req.taskId) }
    case 'transferResume':
      return { ok: await resumeTask(req.taskId) }
    case 'transferRetry':
      return { ok: await retryTask(req.taskId) }
    case 'transferDelete':
      return { ok: await deleteTask(req.taskId) }
    case 'transferClearFinished':
      return { ok: true, count: await clearFinishedTasks() }
    case 'offlineSubmit': {
      const settings = await loadSettings()
      if (!settings.v115.enabled) {
        return { ok: false, reason: '115 转存未启用（设置页开启并认证）' }
      }
      try {
        const task = await enqueueOffline(req.url, settings.v115)
        return { ok: true, taskId: task.id }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    }
  }
}

export default defineBackground(() => {
  // MV2（Safari 目标）下 action API 挂在 browserAction 命名空间
  const actionApi = chrome.action ?? (chrome as unknown as { browserAction: typeof chrome.action }).browserAction

  actionApi.setBadgeBackgroundColor({ color: BADGE_COLOR })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      settingsCache = null
      if (changes['transfer.tasks']) invalidateTaskCache()
    }
  })

  // 引擎 A：观察式监听（MV3 允许观察，不允许阻断）
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      // 硬导航即重置该标签页（软导航/SPA 不触发 main_frame，候选保留）
      if (details.type === 'main_frame' && details.tabId >= 0) {
        void resetTab(details.tabId)
      }
      return undefined // 观察式，永不阻断
    },
    { urls: ['<all_urls>'] },
  )

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return
      const headers = details.responseHeaders ?? []
      const mime = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
      const lenHeader = headers.find((h) => h.name.toLowerCase() === 'content-length')?.value
      const contentLength = lenHeader ? Number(lenHeader) || undefined : undefined

      // 廉价预判：分类不命中直接返回（绝大多数请求在这里被丢弃）
      const cls = classifyRequest(details.url, mime, contentLength)
      if (!cls) return

      void (async () => {
        const { blacklist } = await getSettings()
        let hostname = ''
        try {
          hostname = new URL(details.url).hostname
        } catch {
          return
        }
        if (hostInBlacklist(hostname, blacklist)) return

        // 分段去噪：ts/m4s 与 playlist 共存时不重复登记
        const isSegment = cls.ext === 'ts' || cls.ext === 'm4s'
        if (isSegment && tabHasPlaylist.get(details.tabId)) return

        const id = fingerprint(`${cls.kind}|${details.url}`)
        if (!markSeen(details.tabId, id)) return

        const cand: MediaCandidate = {
          id,
          tabId: details.tabId,
          url: details.url,
          kind: cls.kind,
          origin: 'network',
          mime,
          size: cls.kind === 'file' ? contentLength : undefined,
          fileName: buildFileName({ url: details.url, ext: cls.ext }),
          discoveredAt: Date.now(),
        }
        if (cls.kind === 'hls' || cls.kind === 'dash') {
          tabHasPlaylist.set(details.tabId, true)
        }

        const all = await addCandidates(details.tabId, [cand])
        await updateBadge(details.tabId, all.length)
      })()
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  )

  chrome.runtime.onMessage.addListener(
    (req: BgRequest, _sender, sendResponse: (resp: unknown) => void) => {
      handle(req)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ error: e instanceof Error ? e.message : String(e) }),
        )
      return true // 异步响应
    },
  )

  // offscreen worker 事件流（进度/终态）——同时也是 SW 保活信号
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'v2d/task-event') {
      void applyTaskEvent(msg)
    } else if (msg?.type === 'v2d/task-blob') {
      // HLS 本地保存：offscreen 已建好 blob URL，由 SW 发起原生下载并在完成后清理
      void handleTaskBlob(msg.taskId, msg.blobUrl, msg.fileName)
    } else if (msg?.type === 'v2d/task-staged-ready') {
      // Safari：合并完成进入待保存态（用户在管理页/弹窗点「保存到文件」）
      void applyStagedReady(msg.taskId, msg.fileName ?? '', msg.size ?? 0)
    } else if (msg?.type === 'v2d/task-saved') {
      void markTaskSaved(msg.taskId)
    } else if (msg?.type === 'v2d/token-updated') {
      // worker 内上传途中轮换的新 token 回传持久化（其余上下文靠三段式恢复自愈）
      void chrome.storage.local.set({
        '115.open_token': { ...msg.pair, saved_at: Date.now() },
      })
    }
    return false
  })

  // SW 冷启动：恢复被杀期间卡住的任务并继续泵
  void recoverStuckTasks().catch((e) => console.warn('[V2D] 任务恢复失败', e))

  // 悬浮球（默认关闭，仅桌面 Chrome；iOS 注入会破坏页面布局）：按设置注入（脚本自防重复注入）
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== 'complete' || !tab.url) return
    try {
      if (!import.meta.env.CHROME) return
      if (!/^(https?|file):/.test(tab.url)) return
      const { floatingBall, blacklist } = await getSettings()
      if (!floatingBall) return
      const host = new URL(tab.url).hostname
      if (hostInBlacklist(host, blacklist)) return
      await chrome.scripting.executeScript({ target: { tabId }, files: ['floating-ball.js'] }).catch(() => {})
    } catch {
      /* 受限页面（chrome:// 等）忽略 */
    }
  })

  // Safari/iOS：轮询壳 App 内嵌任务页写入的操作命令（真 App 内嵌桥）
  if (!import.meta.env.CHROME) {
    setInterval(() => void pollAppCommands().catch(() => {}), 10_000)
  }

  console.log('[V2D] background ready')
})
