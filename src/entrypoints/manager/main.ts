/**
 * 传输管理页（§9.2，M4）：进行中/历史两区，逐项进度/速度/分段/错误人话化，
 * 操作：暂停·继续·取消·重试·删除·清除已完成。
 */

import '@/entrypoints/manager/manager.css'
import { humanizeError } from '@/core/humanize'
import { send } from '@/core/messages'
import { loadSettings } from '@/core/settings'

interface TaskView {
  id: string
  kind: 'offline' | 'upload' | 'hls'
  dest: 'cloud' | 'local'
  state: string
  fileName: string
  stagedFileName?: string
  targetPath: string
  size?: number
  received?: number
  uploaded?: number
  speedBps?: number
  segmentsDone?: number
  segmentsTotal?: number
  error?: string
  instant?: boolean
  createdAt: number
}

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

const STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  'offline-adding': '提交离线',
  'offline-polling': '115 转存中',
  downloading: '下载中',
  hashing: '校验中',
  checking: '秒传检测中',
  uploading: '上传中',
  saving: '保存本地',
  staged: '待保存',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

function fmtBytes(n?: number): string {
  if (!n) return ''
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

function fmtSpeed(bps?: number): string {
  return bps ? (bps / 1024 ** 2).toFixed(1) + 'MB/s' : ''
}

function taskMeta(t: TaskView): string {
  const bits: string[] = []
  if (t.state === 'uploading' && t.size) {
    bits.push(`${fmtBytes(t.uploaded)} / ${fmtBytes(t.size)}`)
  } else if (t.state === 'downloading') {
    if (t.size) bits.push(`${fmtBytes(t.received)} / ${fmtBytes(t.size)}`)
    else if (t.received) bits.push(fmtBytes(t.received))
  } else if (t.state === 'offline-polling') {
    bits.push(`${t.uploaded ?? 0}%`)
  } else if (t.size) {
    bits.push(fmtBytes(t.size))
  }
  if (t.speedBps) bits.push(fmtSpeed(t.speedBps))
  if (t.segmentsTotal && t.segmentsDone !== undefined) {
    bits.push(`分段 ${t.segmentsDone}/${t.segmentsTotal}`)
  }
  if (t.instant) bits.push('秒传命中')
  return bits.join(' · ')
}

function taskPercent(t: TaskView): number | null {
  if (t.state === 'uploading' && t.size) return Math.min(100, Math.round(((t.uploaded ?? 0) / t.size) * 100))
  if (t.state === 'downloading' && t.size) return Math.min(100, Math.round(((t.received ?? 0) / t.size) * 100))
  if (t.state === 'offline-polling') return Math.min(100, t.uploaded ?? 0)
  if (t.state === 'saving' || t.state === 'staged' || t.state === 'done') return 100
  return null
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = primary ? 'btn primary' : 'btn'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

function renderTask(t: TaskView): HTMLElement {
  const el = document.createElement('div')
  el.className = 'task'
  el.dataset.taskId = t.id
  const cls = TERMINAL.has(t.state)
    ? t.state === 'done'
      ? 'done'
      : t.state
      : t.state === 'paused'
      ? 'paused'
      : 'run'
  const label = STATE_LABEL[t.state] ?? t.state
  const pct = taskPercent(t)
  const target = t.dest === 'cloud' ? `→ 115 ${t.targetPath}` : '→ 本地下载'

  el.innerHTML = `
    <div class="task-top">
      <span class="chip ${cls}">${label}</span>
      <span class="name" title="${t.fileName}">${t.fileName}</span>
    </div>
    <div class="target">${target}</div>
    ${pct !== null ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` : ''}
    <div class="meta">${taskMeta(t)}</div>
    ${t.error ? `<div class="error">${humanizeError(t.error)}</div>` : ''}
  `

  const actions = document.createElement('div')
  actions.className = 'actions'
  const act = (type: 'transferPause' | 'transferResume' | 'transferCancel' | 'transferRetry' | 'transferDelete', id: string) =>
    () => void send({ type, taskId: id }).then(refresh)

  if (t.state === 'downloading' && t.kind === 'upload') {
    actions.appendChild(button('⏸ 暂停', act('transferPause', t.id)))
  }
  if (t.state === 'paused') {
    actions.appendChild(button('▶ 继续', act('transferResume', t.id), true))
  }
  if (t.state === 'failed' || t.state === 'cancelled') {
    actions.appendChild(button('↻ 重试', act('transferRetry', t.id), true))
  }
  if (t.state === 'staged') {
    const save = document.createElement('button')
    save.className = 'btn primary'
    save.textContent = '⬇ 保存到文件'
    save.addEventListener('click', () =>
      saveStagedById(t.id).catch((e: unknown) =>
        alert(`保存失败：${e instanceof Error ? e.message : String(e)}`),
      ),
    )
    actions.appendChild(save)
  }
  if (!TERMINAL.has(t.state) && t.state !== 'saving' && t.state !== 'staged') {
    actions.appendChild(button('取消', act('transferCancel', t.id)))
  }
  if (t.state === 'staged') {
    actions.appendChild(button('放弃', act('transferDelete', t.id)))
  }
  if (TERMINAL.has(t.state)) {
    actions.appendChild(button('删除', act('transferDelete', t.id)))
  }
  if (actions.children.length) el.appendChild(actions)
  return el
}

/** iOS UA：<a download> 触发 blob 下载在 iOS Safari 必失败（WebKitBlobResource 错误 1），需走 Web Share */
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent)

/** 以目标文件名/类型重建 File：OPFS 文件名是 {taskId}.part，直接分享会存成 .part */
function shareableFile(file: File, name: string): File {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const type =
    ext === 'mp4'
      ? 'video/mp4'
      : ext === 'webm'
        ? 'video/webm'
        : ext === 'ts'
          ? 'video/mp2t'
          : 'application/octet-stream'
  return new File([file], name, { type })
}

/** Safari：读 OPFS 待保存产物并触发保存（必须由用户点击手势调用）。
 *  iOS：Web Share API 调起系统分享面板，用户选「存储到文件」；
 *  其余平台：保持 <a download> 下载。用户取消分享不算失败，任务保持待保存可重试。 */
async function saveStagedById(taskId: string): Promise<void> {
  const t = lastTasks.find((x) => x.id === taskId)
  const name = t?.stagedFileName ?? t?.fileName ?? 'video.mp4'
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('staging')
  const fh = await dir.getFileHandle(`${taskId}.part`)
  const file = await fh.getFile()
  if (file.size === 0) throw new Error('暂存文件为空')

  if (IS_IOS && typeof navigator.canShare === 'function') {
    const share = shareableFile(file, name)
    if (!navigator.canShare({ files: [share] })) throw new Error('系统不支持分享保存该文件')
    try {
      await navigator.share({ files: [share], title: name })
    } catch (e) {
      // AbortError=用户取消分享面板；NotAllowedError=手势失效。任务保持待保存，可再点
      if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return
      throw e
    }
  } else {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  try {
    await dir.removeEntry(`${taskId}.part`)
  } catch {
    /* ignore */
  }
  await chrome.runtime.sendMessage({ type: 'v2d/task-saved', taskId })
  await refresh()
}

let lastTasks: TaskView[] = []

async function refresh(): Promise<void> {
  const r = await send<{ tasks: TaskView[] }>({ type: 'transferList' })
  lastTasks = [...(r?.tasks ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  const tasks = lastTasks
  const active = tasks.filter((t) => !TERMINAL.has(t.state))
  const history = tasks.filter((t) => TERMINAL.has(t.state))

  const activeList = $('#active-list')
  activeList.innerHTML = ''
  if (!active.length) activeList.innerHTML = '<div class="empty">暂无进行中的任务</div>'
  for (const t of active) activeList.appendChild(renderTask(t))
  $('#active-count').textContent = active.length ? `（${active.length}）` : ''

  const historyList = $('#history-list')
  historyList.innerHTML = ''
  if (!history.length) historyList.innerHTML = '<div class="empty">暂无历史记录</div>'
  for (const t of history.slice(0, 50)) historyList.appendChild(renderTask(t))
  $('#history-count').textContent = history.length ? `（${history.length}）` : ''
}

$('#clear-finished').addEventListener('click', async () => {
  await send({ type: 'transferClearFinished' })
  await refresh()
})

// ── 🥚 115 离线彩蛋（手动提交直链/磁力/ed2k） ──────────────────────────
async function initOfflineBox(): Promise<void> {
  const settings = await loadSettings()
  $('#offline-box').classList.toggle('hidden', !settings.v115.enabled)
}

$('#offline-submit').addEventListener('click', async () => {
  const inputEl = $('input#offline-url') as HTMLInputElement
  const msgEl = $('#offline-msg')
  const url = inputEl.value.trim()
  msgEl.textContent = ''
  if (!url) return
  const btn = $('#offline-submit') as HTMLButtonElement
  btn.disabled = true
  try {
    const r = await send<{ ok: boolean; reason?: string; error?: string }>({
      type: 'offlineSubmit',
      url,
    })
    if (r?.ok) {
      inputEl.value = ''
      msgEl.style.color = 'var(--ok)'
      msgEl.textContent = '已提交，任务已加入下方队列'
      await refresh()
    } else {
      msgEl.style.color = 'var(--err)'
      msgEl.textContent = r?.reason ?? r?.error ?? '提交失败'
    }
  } finally {
    btn.disabled = false
  }
})

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'v2d/task-event' || msg?.type === 'v2d/task-blob') void refresh()
  return false
})

// 从 popup「保存到文件」跳转而来：定位并高亮任务（保存仍需用户点击——iOS 拦截无手势下载）
const saveParam = new URLSearchParams(location.search).get('save')
if (saveParam) {
  void (async () => {
    await refresh()
    document.querySelector(`[data-task-id="${saveParam}"]`)?.scrollIntoView({ block: 'center' })
    document.querySelector(`[data-task-id="${saveParam}"] .actions`)?.classList.add('flash')
  })()
}

void initOfflineBox()
void refresh()
setInterval(() => void refresh(), 3000)
