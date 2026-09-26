/**
 * Popup（§9.1）：本页候选列表 + 一键存本地。
 * 懒探测：首屏前 3 个未探测项自动探测，其余点开时再探测。
 */

import '@/entrypoints/popup/popup.css'
import { send } from '@/core/messages'
import { hostInBlacklist, scoreCandidate } from '@/core/sniffer/patterns'
import { humanizeError } from '@/core/humanize'
import type { MediaCandidate } from '@/core/types'
import { loadSettings, saveSettings } from '@/core/settings'

const KIND_LABEL: Record<string, string> = {
  hls: 'HLS',
  dash: 'DASH',
  file: '直链',
  blob: '内嵌流',
}

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

let tabId = 0
let tabUrl = ''
let tabTitle = ''
/** 115 转存是否已启用（§9.5：未启用时转存入口完全不可见，只留设置引导条） */
let v115Enabled = false

function fmtSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

function fmtDuration(sec?: number): string {
  if (!sec) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}分${s}秒` : `${s}秒`
}

function toast(msg: string): void {
  let el = document.querySelector('.toast') as HTMLElement | null
  if (!el) {
    el = document.createElement('div')
    el.className = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2200)
}

function metaLine(c: MediaCandidate): string {
  const parts: string[] = []
  if (c.kind === 'hls' || c.kind === 'dash') {
    if (c.variants?.length) parts.push(`${c.variants.length} 种清晰度`)
    if (c.segments) parts.push(`${c.segments} 分段`)
    if (c.durationSec) parts.push(fmtDuration(c.durationSec))
    if (c.live) parts.push('直播流')
    if (c.encrypted) parts.push('AES 加密')
  } else {
    parts.push(c.size ? fmtSize(c.size) : '大小未知')
  }
  if (c.probeError) parts.push(`探测失败(${c.probeError})`)
  return parts.join(' · ')
}

function render(list: MediaCandidate[]): void {
  const container = $('#list')
  container.querySelectorAll('.item').forEach((el) => el.remove())
  $('#count').textContent = list.length ? `共 ${list.length} 个候选` : ''

  for (const c of list) {
    const item = document.createElement('div')
    item.className = 'item'
    item.dataset.id = c.id

    const head = document.createElement('div')
    head.className = 'item-head'
    const badge = document.createElement('span')
    badge.className = `badge ${c.kind}`
    badge.textContent = KIND_LABEL[c.kind] ?? c.kind
    const name = document.createElement('span')
    name.className = 'name'
    name.title = c.url
    name.textContent = c.fileName ?? c.url.slice(0, 80)
    head.append(badge, name)

    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.innerHTML = metaLine(c).replace(/探测失败\((.*?)\)/, '<span class="err">探测失败($1)</span>')

    const actions = document.createElement('div')
    actions.className = 'item-actions'
    appendActions(actions, c, item)

    item.append(head, meta, actions)
    container.appendChild(item)
  }

  $('#empty').style.display = list.length ? 'none' : ''
}

function appendActions(actions: HTMLElement, c: MediaCandidate, item: HTMLElement): void {
  if (c.kind === 'blob') {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = '页面 MSE 内嵌流：暂不支持，深捕获开发中'
    actions.appendChild(note)
    return
  }
  if (c.kind === 'hls' || c.kind === 'dash') {
    // 默认用最高码率；展开可逐清晰度选择（dash 的 variants 由站点探针预填）
    const best = c.variants?.[0]?.url
    const dl = document.createElement('button')
    dl.className = 'btn primary'
    dl.textContent = '⬇ 存本地'
    dl.disabled = !!c.probeError || !!c.live
    dl.addEventListener('click', () => void transferHls(c, 'local', best, dl))
    actions.appendChild(dl)
    if (v115Enabled) {
      const up = document.createElement('button')
      up.className = 'btn'
      up.textContent = '☁ 转存115'
      up.disabled = !!c.probeError || !!c.live
      up.addEventListener('click', () => void transferHls(c, 'cloud', best, up))
      actions.appendChild(up)
    }
    if (c.live) {
      const note = document.createElement('span')
      note.className = 'note'
      note.textContent = '直播流不支持'
      actions.appendChild(note)
    }
    const expand = document.createElement('button')
    expand.className = 'btn'
    expand.textContent = c.variants?.length ? '清晰度' : '解析'
    expand.addEventListener('click', () => void expandHls(c, item))
    actions.appendChild(expand)
    return
  }
  const dl = document.createElement('button')
  dl.className = 'btn primary'
  dl.textContent = '⬇ 存本地'
  dl.disabled = !!c.probeError
  dl.addEventListener('click', async () => {
    dl.disabled = true
    const r = await send<{ ok: boolean; reason?: string; error?: string }>({
      type: 'download',
      tabId,
      id: c.id,
      pageTitle: tabTitle,
    })
    if (r?.ok) toast('已开始下载')
    else toast(r?.reason ?? r?.error ?? '下载失败')
    dl.disabled = false
  })
  actions.appendChild(dl)

  if (v115Enabled) {
    const up = document.createElement('button')
    up.className = 'btn'
    up.textContent = '☁ 转存115'
    up.disabled = !!c.probeError
    up.addEventListener('click', async () => {
      up.disabled = true
      const r = await send<{ ok: boolean; channel?: string; reason?: string; error?: string }>({
        type: 'transfer115',
        tabId,
        id: c.id,
        pageTitle: tabTitle,
      })
      if (r?.ok) toast(r.channel === 'hls-merge' ? '已加入合并转存队列' : '已加入转存队列')
      else toast(r?.reason ?? r?.error ?? '提交失败')
      up.disabled = false
    })
    actions.appendChild(up)
  }
}

/** HLS 任务提交（存本地 / 转存 115 共用） */
async function transferHls(
  c: MediaCandidate,
  dest: 'local' | 'cloud',
  variantUrl: string | undefined,
  btn: HTMLButtonElement,
): Promise<void> {
  btn.disabled = true
  const req =
    dest === 'local'
      ? { type: 'download' as const, tabId, id: c.id, variantUrl, pageTitle: tabTitle }
      : { type: 'transfer115' as const, tabId, id: c.id, variantUrl, pageTitle: tabTitle }
  const r = await send<{ ok: boolean; channel?: string; reason?: string; error?: string }>(req)
  if (r?.ok) {
    toast(dest === 'local' ? '已加入合并下载队列' : '已加入转存队列')
    void renderTasks()
  } else {
    toast(r?.reason ?? r?.error ?? '提交失败')
  }
  btn.disabled = false
}

function variantRow(
  cand: MediaCandidate,
  v: { url: string; quality?: string; resolution?: string; name?: string; bandwidth?: number },
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'variant'
  const label = v.quality ?? v.resolution ?? v.name ?? (v.bandwidth ? `${Math.round(v.bandwidth / 1000)}kbps` : '未知清晰度')
  row.innerHTML = `<span class="badge file" style="background:var(--accent-soft);color:var(--accent)">${label}</span><span class="name">${v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : ''}</span>`
  const dl = document.createElement('button')
  dl.className = 'btn'
  dl.textContent = '⬇'
  dl.title = '合并下载为 MP4'
  dl.addEventListener('click', () => void transferHls(cand, 'local', v.url, dl))
  row.appendChild(dl)
  if (v115Enabled) {
    const up = document.createElement('button')
    up.className = 'btn'
    up.textContent = '☁'
    up.title = '合并转存到 115'
    up.addEventListener('click', () => void transferHls(cand, 'cloud', v.url, up))
    row.appendChild(up)
  }
  return row
}

async function expandHls(c: MediaCandidate, item: HTMLElement): Promise<void> {
  let box = item.querySelector('.variants') as HTMLElement | null
  if (box) {
    box.remove()
    return
  }
  box = document.createElement('div')
  box.className = 'variants'
  box.innerHTML = '<div class="note">解析中…</div>'
  item.appendChild(box)

  // DASH：清晰度数据由站点探针预填，无需联网解析
  if (c.kind === 'dash') {
    box.innerHTML = ''
    if (!c.variants?.length) {
      box.innerHTML = '<div class="note">无清晰度数据，请播放视频后重试</div>'
      return
    }
    for (const v of c.variants) box.appendChild(variantRow(c, v))
    return
  }

  const r = await send<{ candidate: MediaCandidate; error?: string }>({
    type: 'hlsInfo',
    tabId,
    id: c.id,
  })
  const cand = r?.candidate
  if (!cand || r?.error) {
    box.innerHTML = `<div class="note">解析失败：${r?.error ?? '未知错误'}</div>`
    return
  }
  box.innerHTML = ''
  if (cand.variants?.length) {
    for (const v of cand.variants) box.appendChild(variantRow(cand, v))
  } else {
    const bits: string[] = []
    if (cand.segments) bits.push(`${cand.segments} 个分段`)
    if (cand.durationSec) bits.push(`时长约 ${fmtDuration(cand.durationSec)}`)
    if (cand.live) bits.push('直播流（不支持）')
    if (cand.encrypted) bits.push('AES-128 加密（下载时自动解密）')
    box.innerHTML = `<div class="note">${bits.join(' · ') || '媒体播放列表'}</div>`
  }
}

async function refresh(): Promise<void> {
  const r = await send<{ candidates: MediaCandidate[] }>({ type: 'list', tabId })
  render(r?.candidates ?? [])
}

async function init(): Promise<void> {
  // 嵌入模式（悬浮球 iframe 面板）：隐藏外框差异、支持面板关闭
  const embedded = new URLSearchParams(location.search).get('embedded') === '1'
  if (embedded) {
    document.body.classList.add('embedded')
    const close = document.createElement('button')
    close.className = 'icon-btn'
    close.title = '收起面板'
    close.textContent = '✕'
    close.addEventListener('click', () => window.parent.postMessage('v2d-close-panel', '*'))
    document.querySelector('.topbar')?.appendChild(close)
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  tabId = tab.id ?? 0
  tabUrl = tab.url ?? ''
  tabTitle = tab.title ?? ''
  try {
    $('#tab-host').textContent = tabUrl ? new URL(tabUrl).hostname : ''
  } catch {
    $('#tab-host').textContent = ''
  }

  // ⚠️ 设置必须先于首次渲染读取：v115Enabled 决定候选卡片上 ☁ 按钮的显隐
  //（历史 bug：settings 在渲染后才赋值，首次打开永远不显示转存按钮）
  const settings = await loadSettings()
  v115Enabled = settings.v115.enabled

  // 首次打开做一次 DOM 扫描（引擎 B，§4.2）+ 站点探针（M5 适配层）
  await send({ type: 'scanDom', tabId })
  await send({ type: 'siteProbe', tabId }).catch(() => {})
  await refresh()

  // 懒探测前 3 个未探测项
  const r = await send<{ candidates: MediaCandidate[] }>({ type: 'list', tabId })
  const unprobed = (r?.candidates ?? [])
    .filter((c) => !c.probed && c.kind !== 'blob')
    .slice(0, 3)
    .map((c) => c.id)
  if (unprobed.length) {
    const r2 = await send<{ candidates: MediaCandidate[] }>({ type: 'probeMany', tabId, ids: unprobed })
    render(r2?.candidates ?? [])
  }

  // 黑名单提示横幅
  const host = tabUrl ? new URL(tabUrl).hostname : ''
  if (host && hostInBlacklist(host, settings.blacklist)) {
    const banner = $('#banner')
    banner.classList.remove('hidden')
    banner.textContent = '此站点已关闭嗅探'
    const btn = document.createElement('button')
    btn.className = 'btn'
    btn.textContent = '在此站点启用'
    btn.addEventListener('click', async () => {
      await saveSettings({ blacklist: settings.blacklist.filter((e) => !hostInBlacklist(host, [e])) })
      banner.classList.add('hidden')
      toast('已启用，播放视频后即可嗅探')
    })
    banner.appendChild(btn)
  }

  await renderTasks()
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'v2d/task-event') void renderTasks()
    return false
  })

  // 设置变更（如在设置页关闭 115 开关）→ popup 实时同步按钮显隐
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['settings']) return
    void (async () => {
      const s = await loadSettings()
      if (s.v115.enabled !== v115Enabled) {
        v115Enabled = s.v115.enabled
        await refresh()
      }
    })()
  })
}

$('#btn-rescan').addEventListener('click', async () => {
  await send({ type: 'scanDom', tabId })
  await refresh()
  toast('已重新扫描')
})
$('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage())
$('#open-manager').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') })
  window.close()
})

// ── 115 转存任务进度（popup 内轻展示，管理页在 M4 交付） ────────────────
interface TaskView {
  id: string
  kind: 'offline' | 'upload' | 'hls'
  dest: 'cloud' | 'local'
  state: string
  fileName: string
  stagedFileName?: string
  size?: number
  received?: number
  uploaded?: number
  speedBps?: number
  segmentsDone?: number
  segmentsTotal?: number
  error?: string
  instant?: boolean
}

/** Safari：直接读 OPFS 产物生成下载（不经宿主页面——iOS 会丢弃后台标签页导致链路断裂） */
async function saveStaged(t: TaskView, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('staging')
    const fh = await dir.getFileHandle(`${t.id}.part`)
    const file = await fh.getFile()
    if (file.size === 0) throw new Error('暂存文件为空')
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = t.stagedFileName ?? t.fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    await new Promise((res) => setTimeout(res, 800))
    await chrome.runtime.sendMessage({ type: 'v2d/task-saved', taskId: t.id })
    await renderTasks()
  } catch (e) {
    toast(`保存失败: ${e instanceof Error ? e.message : String(e)}`)
    btn.disabled = false
  }
}

const TASK_STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  'offline-adding': '提交离线任务',
  'offline-polling': '115 转存中',
  downloading: '下载中',
  hashing: '校验中',
  checking: '秒传检测中',
  uploading: '上传中',
  saving: '保存本地',
  staged: '待保存',
}

function fmtSpeed(bps?: number): string {
  return bps ? (bps / 1024 ** 2).toFixed(1) + 'MB/s' : ''
}

function taskPercent(t: TaskView): number | null {
  if (t.state === 'uploading' && t.size) return Math.min(100, Math.round(((t.uploaded ?? 0) / t.size) * 100))
  if (t.state === 'downloading' && t.size) return Math.min(100, Math.round(((t.received ?? 0) / t.size) * 100))
  if (t.state === 'offline-polling') return Math.min(100, t.uploaded ?? 0)
  if (t.state === 'saving' || t.state === 'staged') return 100
  return null
}

async function renderTasks(): Promise<void> {
  const r = await send<{ tasks: TaskView[] }>({ type: 'transferList' })
  const active = (r?.tasks ?? []).filter(
    (t) => t.state !== 'done' && t.state !== 'failed' && t.state !== 'cancelled',
  )
  const box = $('#tasks')
  box.innerHTML = ''
  for (const t of active.slice(0, 3)) {
    const row = document.createElement('div')
    row.className = 'task'
    const label = TASK_STATE_LABEL[t.state] ?? t.state
    const pct = taskPercent(t)
    const segs =
      t.segmentsTotal && t.segmentsDone !== undefined
        ? ` 分段 ${t.segmentsDone}/${t.segmentsTotal}`
        : ''
    const meta = `${pct !== null ? pct + '%' : ''}${t.speedBps ? ' · ' + fmtSpeed(t.speedBps) : ''}${segs}`.trim()
    row.innerHTML = `
      <div class="task-top">
        <span class="task-state">${label}</span>
        <span class="task-name" title="${t.fileName}">${t.fileName}</span>
        <button class="icon-btn task-cancel" title="取消">×</button>
      </div>
      ${pct !== null ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` : ''}
      ${meta ? `<div class="task-meta">${meta}</div>` : ''}
      ${t.error ? `<div class="error">${humanizeError(t.error)}</div>` : ''}
    `
    const actions = document.createElement('div')
    actions.className = 'task-actions'
    const mini = (label: string, type: 'transferPause' | 'transferResume' | 'transferRetry', title: string): void => {
      const b = document.createElement('button')
      b.className = 'mini-btn'
      b.textContent = label
      b.title = title
      b.addEventListener('click', () => void send({ type, taskId: t.id }).then(renderTasks))
      actions.appendChild(b)
    }
    if (t.state === 'downloading' && t.kind === 'upload') mini('⏸ 暂停', 'transferPause', '保留断点，稍后继续')
    if (t.state === 'paused') mini('▶ 继续', 'transferResume', '从断点继续')
    if (t.state === 'failed' || t.state === 'cancelled') mini('↻ 重试', 'transferRetry', '重试（保留断点）')
    if (t.state === 'staged') {
      // iOS：popup 内 blob 下载不可靠 → 跳转传输管理页自动保存
      const save = document.createElement('button')
      save.className = 'mini-btn'
      save.textContent = '⬇ 保存到文件'
      save.title = '在传输管理页保存到「文件」App'
      save.addEventListener('click', () => {
        void chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?save=${t.id}`) })
      })
      actions.appendChild(save)
    }
    if (actions.children.length) row.appendChild(actions)
    row.querySelector('.task-cancel')?.addEventListener('click', async () => {
      await send({ type: 'transferCancel', taskId: t.id })
      await renderTasks()
    })
    box.appendChild(row)
  }
  if (active.length > 3) {
    const more = document.createElement('div')
    more.className = 'task-meta'
    more.textContent = `还有 ${active.length - 3} 个任务在队列…`
    box.appendChild(more)
  }
}

// iOS：弹窗被打开即证明扩展在运行——经后台把「已启动」标记写进 App Group
void chrome.runtime.sendMessage({ type: 'v2d/app-ping' }).catch(() => {})

void init().catch((e) => {
  console.error(e)
  $('#empty').querySelector('p')!.textContent = `初始化失败：${String(e)}`
})

// 保持 scoreCandidate 被引用（供未来本地重排序；当前排序在 SW 侧完成）
void scoreCandidate
