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
import { buildFileName, sanitizeFileName } from '@/core/name'
import { loadSettings } from '@/core/settings'
import type { MediaCandidate, Settings } from '@/core/types'
import type { BgRequest } from '@/core/messages'
import { SITE_PROBES } from '@/background/siteProbes'
import {
  applyStagedReady,
  pollAppCommands,
  applyTaskEvent,
  applyMseGroups,
  cancelTask,
  clearFinishedTasks,
  deleteTask,
  enqueueMseTransfer,
  enqueueOffline,
  enqueueTransfer,
  finishDownloadTask,
  handleTaskBlob,
  handleMseChunk,
  handleMsePullDone,
  handleMsePullMissing,
  installRefererRules,
  invalidateTaskCache,
  lookupBlobName,
  listTasks,
  markTaskSaved,
  pauseTask,
  recoverStuckTasks,
  resumeTask,
  retryTask,
  startMsePreview,
  watchPageSave,
} from '@/background/transfer'
import type { MseGroupInfo } from '@/background/transfer'

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
    // blob: 引用不再登记候选——MSE 播放由深捕获钩子出正式的 MSE 卡（可下载）；
    // 旧式 blob 卡是无下载入口的死卡，还会和 MSE 卡重复占位
    if (item.src.startsWith('blob:')) continue
    const cls = classifyRequest(item.src, item.type ?? undefined)
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
      fileName: buildFileName({ url, ext: cls.ext }),
      discoveredAt: Date.now(),
    })
  }
  const all = await addCandidates(tabId, cands)
  await updateBadge(tabId, all.length)
  return all.length
}

// ── 站点探针（M5）：弹窗打开时手动触发；DASH 分轨出现时后台自动触发（实时角标） ──
const autoProbeAt = new Map<number, number>() // tabId → 上次自动探测时间（10s 限频）

/** 站点探针：黑名单/注册表校验 → 探测 → 去重入库 → 角标 */
async function runSiteProbe(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId)
    const host = tab.url ? new URL(tab.url).hostname : ''
    const { blacklist } = await getSettings()
    if (!host || hostInBlacklist(host, blacklist)) return false
    const probe = SITE_PROBES.find((p) => p.hostPattern.test(host))
    if (!probe) return false
    const cands = await probe.run(tabId)
    const newCands: MediaCandidate[] = []
    for (const c of cands) {
      if (!markSeen(tabId, c.id)) {
        await updateCandidate(tabId, c.id, {
          variants: c.variants,
          dashAudioUrl: c.dashAudioUrl,
        })
        continue
      }
      newCands.push(c)
    }
    if (newCands.length) {
      const all = await addCandidates(tabId, newCands)
      await updateBadge(tabId, all.length)
    }
    return cands.length > 0
  } catch {
    return false
  }
}

/** DASH 分轨/清单请求出现 → 自动触发站点探针（每标签页 10s 限频） */
async function maybeAutoProbe(tabId: number): Promise<void> {
  if (typeof chrome.scripting === 'undefined') return // 无 scripting（部分 Safari）跳过
  const now = Date.now()
  if (now - (autoProbeAt.get(tabId) ?? 0) < 10_000) return
  autoProbeAt.set(tabId, now)
  await runSiteProbe(tabId)
}

/** 用户重命名清洗：去非法字符；未带扩展名时补上（大小写不敏感防重复后缀） */
function applyCustomName(raw: string | undefined, ext: string): string | undefined {
  const name = sanitizeFileName(raw ?? '')
  if (!name) return undefined
  const e = ext.replace(/^\./, '')
  return name.toLowerCase().endsWith('.' + e.toLowerCase()) ? name : `${name}.${e}`
}

// ── 下载 ───────────────────────────────────────────────────────────────
async function download(
  cand: MediaCandidate,
  variantUrl?: string,
  pageTitle?: string,
  customName?: string,
): Promise<{ ok: boolean; reason?: string; downloadId?: number }> {
  if (cand.kind === 'blob') {
    return { ok: false, reason: '页面内嵌流（blob:）暂不支持直接下载，深捕获开发中' }
  }
  if (cand.kind === 'hls' || cand.kind === 'dash') {
    // M1 里程碑边界：HLS/DASH 分段合并（remux）在 M3 交付
    return { ok: false, reason: 'HLS/DASH 分段合并下载将在后续版本支持' }
  }
  const rawUrl = variantUrl ?? cand.url
  // 防呆：存量候选里可能有 .m4s 直链——分轨单文件不可播放（无音轨），引导走 DASH 候选
  if (urlExt(rawUrl) === 'm4s') {
    return { ok: false, reason: 'DASH 分轨（m4s）不能单独下载，请使用带清晰度下拉的 DASH 候选（自动合并音视频）' }
  }
  const fileName =
    applyCustomName(customName, urlExt(rawUrl) || 'mp4') ??
    buildFileName({ title: pageTitle, url: rawUrl, ext: urlExt(rawUrl) || 'mp4' })
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
          // 合并产物容器固定 mp4：不能沿用清单/分段的 .m3u8/.m4s 扩展名
          fileName: applyCustomName(req.fileName, 'mp4'),
        })
        return { ok: true, queued: true, taskId: task.id }
      }
      return download(cand, req.variantUrl, req.pageTitle, req.fileName)
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
      // 站点适配层入口（M5）：失败静默（popup 不受影响）
      try {
        const ok = await runSiteProbe(req.tabId)
        return { ok }
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
        fileName: applyCustomName(req.fileName, 'mp4'),
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
    case 'mseDownload': {
      const settings = await loadSettings()
      try {
        const task = await enqueueMseTransfer(req, settings.v115)
        return { ok: true, taskId: task.id }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'msePreview':
      return startMsePreview(req.tabId, req.groupId)
  }
}

export default defineBackground(() => {
  // MV2（Safari 目标）下 action API 挂在 browserAction 命名空间
  const actionApi = chrome.action ?? (chrome as unknown as { browserAction: typeof chrome.action }).browserAction

  // 数字角标：红底（ember）白字，发现视频时显示候选数
  actionApi.setBadgeBackgroundColor({ color: '#e7000b' })
  try {
    ;(actionApi as typeof chrome.action).setBadgeTextColor?.({ color: '#ffffff' })
  } catch {
    /* 旧内核 / Safari MV2 无此 API——对比度由浏览器自动选择 */
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      settingsCache = null
      if (changes['transfer.tasks']) invalidateTaskCache()
    }
  })

  // 常驻 Referer 会话规则：传输拉流 + 弹窗视频预览的 CDN 防盗链都靠它（会话存活，幂等）
  installRefererRules()

  // 引擎 A：观察式监听（MV3 允许观察，不允许阻断）
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      // 硬导航即重置该标签页（软导航/SPA 不触发 main_frame，候选保留）
      if (details.type === 'main_frame' && details.tabId >= 0) {
        autoProbeAt.delete(details.tabId)
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

      // DASH 分轨/清单请求：不注册直链候选，但作为「该站有视频」信号自动触发站点探针
      // （实时角标 + 弹窗打开时 DASH 候选即已就绪）
      const reqExt = urlExt(details.url)
      if (reqExt === 'm4s' || reqExt === 'mpd') {
        void maybeAutoProbe(details.tabId)
      }

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
      // 内部事件（v2d/*）由下面的第二个监听器处理并应答——这里若抢答（哪怕 undefined）
      // 会立即关闭消息端口，第二个监听器的异步应答全部失效（mse-chunk 背压曾被破坏）
      if (typeof req?.type === 'string' && req.type.startsWith('v2d/')) return false
      handle(req)
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ error: e instanceof Error ? e.message : String(e) }),
        )
      return true // 异步响应
    },
  )

  // offscreen worker 事件流（进度/终态）——同时也是 SW 保活信号
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'v2d/task-event') {
      void applyTaskEvent(msg)
    } else if (msg?.type === 'v2d/task-staged-ready') {
      // Safari：合并完成进入待保存态（用户在管理页/弹窗点「保存到文件」）
      void applyStagedReady(msg.taskId, msg.fileName ?? '', msg.size ?? 0)
    } else if (msg?.type === 'v2d/task-saved') {
      void markTaskSaved(msg.taskId)
    } else if (msg?.type === 'v2d/task-saving') {
      // 页面 <a download> 保存：SW 等浏览器下载终态再收口（完成删暂存 / 失败回待保存）
      void watchPageSave(msg.taskId, msg.blobUrl)
    } else if (msg?.type === 'v2d/token-updated') {
      // worker 内上传途中轮换的新 token 回传持久化（其余上下文靠三段式恢复自愈）
      void chrome.storage.local.set({
        '115.open_token': { ...msg.pair, saved_at: Date.now() },
      })
    } else if (msg?.type === 'v2d/app-ping') {
      // 弹窗/设置页/悬浮球上报「我在运行」：顺手拉一次原生桥（App 侧写已启动标记 + 消费命令）
      void pollAppCommands().catch(() => {})
    } else if (msg?.type === 'v2d/mse-groups') {
      // MSE 捕获钩子上报摘要：登记分组（带 frameId，拉取时精准定向）+ upsert 候选
      const tabId = sender.tab?.id
      if (typeof tabId === 'number' && Array.isArray(msg.groups)) {
        const frameId = sender.frameId ?? 0
        void applyMseGroups(tabId, frameId, msg.groups as MseGroupInfo[])
          .then(async () => updateBadge(tabId, (await listCandidates(tabId)).length))
          .catch(() => {})
      }
    } else if (msg?.type === 'v2d/mse-chunk') {
      // 数据块落盘（桥在 ack 前等待本响应——背压）
      void handleMseChunk(msg.requestId, msg.data).then((ok) => sendResponse({ ok }))
      return true
    } else if (msg?.type === 'v2d/mse-pull-done') {
      handleMsePullDone(msg.requestId)
    } else if (msg?.type === 'v2d/mse-pull-missing') {
      handleMsePullMissing(msg.requestId)
    }
    return false
  })

  // SW 冷启动：恢复被杀期间卡住的任务并继续泵
  void recoverStuckTasks().catch((e) => console.warn('[V2D] 任务恢复失败', e))

  // blob 下载文件名覆写：SW 发起的 blob: 下载 filename 会被 Chromium 忽略（UUID 名），
  // 在文件名决议阶段用任务名覆写；缺失此 API 的环境由 MIME 兜底（.mp4）
  try {
    chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
      const name = lookupBlobName(item.url)
      if (name) suggest({ filename: `V2D/${name}`, conflictAction: 'uniquify' })
      else suggest()
    })
  } catch {
    /* 旧内核/Safari 无此 API */
  }

  // 保存收口兜底：handleTaskBlob 的轮询快路径被 SW 休眠打断时，
  // onChanged 事件会唤醒 SW，凭任务上持久化的 downloadId 幂等收口
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current === 'complete') void finishDownloadTask(delta.id, null)
    else if (delta.state?.current === 'interrupted')
      void finishDownloadTask(delta.id, delta.error?.current ?? '下载中断')
  })

  // blob 下载文件名覆写：SW 发起的 blob: 下载会忽略 downloads.download 的 filename
  // （落成随机 UUID 名），在文件名决议阶段用任务名覆写；缺失此 API 的环境由 MIME 兜底 .mp4

  // 存量候选清洗：旧版本曾把 .m4s 分轨 / .mpd 清单注册为「直链」候选——
  // storage.session 跨扩展重载存活，不清除会一直误导下载（下到无音轨的单轨文件）
  void (async () => {
    try {
      const all = await chrome.storage.session.get(null)
      for (const [key, val] of Object.entries(all)) {
        if (!key.startsWith('cand:')) continue
        const list = val as MediaCandidate[]
        const kept = list.filter((c) => {
          const ext = urlExt(c.url)
          return ext !== 'm4s' && ext !== 'mpd'
        })
        if (kept.length !== list.length) await chrome.storage.session.set({ [key]: kept })
      }
    } catch {
      /* storage.session 不可用（部分 Safari 版本）——跳过 */
    }
  })()

  // Safari/iOS：轮询壳 App 内嵌任务页写入的操作命令（真 App 内嵌桥）
  if (!import.meta.env.CHROME) {
    void pollAppCommands().catch(() => {}) // 后台页被拉起即 ping 一次：写「已启动」标记，不等轮询
    setInterval(() => void pollAppCommands().catch(() => {}), 10_000)
  }

  console.log('[V2D] background ready')
})
