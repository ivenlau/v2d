/**
 * Popup（§9.1）：本页候选列表 + 一键存本地。
 * 懒探测：首屏前 3 个未探测项自动探测，其余点开时再探测。
 */

import '@/entrypoints/popup/popup.css'
import { pingBackground, send } from '@/core/messages'
import { hostInBlacklist, scoreCandidate } from '@/core/sniffer/patterns'
import { humanizeError } from '@/core/humanize'
import type { HlsVariant, MediaCandidate } from '@/core/types'
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

/** 用户重命名（popup 内编辑）：候选 id → 自定义文件名（后台再清洗并补扩展名） */
const renames = new Map<string, string>()

const ICON_VIDEO =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/></svg>'
const ICON_PENCIL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>'
const ICON_CARET =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'

/** 可预览直链：file 类 + 视频扩展名/mime（HLS/DASH 无法直接出帧，显示占位块） */
const VIDEO_EXT = /\.(mp4|webm|m4v|ogv|mov)([?#]|$)/i
function previewable(c: MediaCandidate): boolean {
  return (
    c.kind === 'file' &&
    !c.probeError &&
    (VIDEO_EXT.test(c.url) || (c.mime?.startsWith('video/') ?? false))
  )
}

function effectiveName(c: MediaCandidate): string {
  return renames.get(c.id) ?? c.fileName ?? c.url.slice(0, 80)
}

/** 清晰度选项的展示名（quality > resolution > name > 码率） */
function variantLabel(v: HlsVariant): string {
  return (
    v.quality ??
    v.resolution ??
    v.name ??
    (v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : '未知清晰度')
  )
}

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
  } else if (!c.size) {
    // 大小已知时直接以水印形式盖在缩略图左下角，不重复占元信息行
    parts.push('大小未知')
  }
  if (c.probeError) parts.push(`探测失败(${c.probeError})`)
  return parts.join(' · ')
}

/** 占位缩略块：视频图标 + 类型短标 */
function makePh(c: MediaCandidate): HTMLElement {
  const ph = document.createElement('div')
  ph.className = 'ph'
  ph.innerHTML = ICON_VIDEO
  const label = document.createElement('span')
  label.className = 'ph-label'
  label.textContent = KIND_LABEL[c.kind] ?? c.kind
  ph.appendChild(label)
  return ph
}

function render(list: MediaCandidate[]): void {
  const container = $('#list')
  container.querySelectorAll('.item').forEach((el) => el.remove())
  $('#count').textContent = list.length ? `共 ${list.length} 个候选` : ''

  let thumbCount = 0
  for (const c of list) {
    const item = document.createElement('div')
    item.className = 'item'
    item.dataset.id = c.id

    // 左侧 16:9 预览：可预览直链用 <video> 元数据帧（防盗链失败降级占位块），其余直接占位
    const thumb = document.createElement('div')
    thumb.className = 'thumb'
    if (previewable(c) && thumbCount < 8) {
      thumbCount++
      const v = document.createElement('video')
      v.muted = true
      v.preload = 'metadata'
      v.disablePictureInPicture = true
      // #t=0.5 让浏览器定位到近起始帧出画面；已有 fragment 的 URL 不重复追加
      v.src = c.url.includes('#') ? c.url : `${c.url}#t=0.5`
      v.addEventListener(
        'error',
        () => {
          v.remove()
          thumb.appendChild(makePh(c))
        },
        { once: true },
      )
      thumb.appendChild(v)
    } else {
      thumb.appendChild(makePh(c))
    }
    // 视频大小：黑底白字水印盖在缩略图左下角
    if (c.size) {
      const tag = document.createElement('span')
      tag.className = 'size-tag'
      tag.textContent = fmtSize(c.size)
      thumb.appendChild(tag)
    }

    const content = document.createElement('div')
    content.className = 'item-content'

    const head = document.createElement('div')
    head.className = 'item-head'
    const badge = document.createElement('span')
    badge.className = 'badge'
    badge.textContent = KIND_LABEL[c.kind] ?? c.kind
    const name = document.createElement('span')
    name.className = 'name'
    name.title = c.url
    name.textContent = effectiveName(c)
    const renameBtn = document.createElement('button')
    renameBtn.className = 'rename-btn'
    renameBtn.title = '重命名'
    renameBtn.innerHTML = ICON_PENCIL
    renameBtn.addEventListener('click', () => startRename(c, item))
    head.append(badge, name, renameBtn)

    const actions = document.createElement('div')
    actions.className = 'item-actions'
    appendActions(actions, c, item)

    content.append(head)
    // 元信息可能为空（大小已挪到缩略图水印且无探测异常）
    const metaText = metaLine(c)
    if (metaText) {
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.innerHTML = metaText.replace(/探测失败\((.*?)\)/, '<span class="err">探测失败($1)</span>')
      content.append(meta)
    }
    content.append(actions)
    item.append(thumb, content)
    container.appendChild(item)
  }

  $('#empty').style.display = list.length ? 'none' : ''
}

/** 内联重命名：名字 span ⇄ 输入框；Enter/失焦保存（客户端先清洗非法字符），Esc 取消 */
function startRename(c: MediaCandidate, item: HTMLElement): void {
  const nameSpan = item.querySelector('.name')
  if (!(nameSpan instanceof HTMLElement) || item.querySelector('.rename-input')) return
  const input = document.createElement('input')
  input.className = 'rename-input'
  input.maxLength = 200
  input.spellcheck = false
  input.value = effectiveName(c)
  nameSpan.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = (commit: boolean): void => {
    if (done) return
    done = true
    if (commit) {
      const v = input.value
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180)
      if (v) renames.set(c.id, v)
      else renames.delete(c.id)
    }
    const span = document.createElement('span')
    span.className = 'name'
    span.title = c.url
    span.textContent = effectiveName(c)
    input.replaceWith(span)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
}

/** 复制链接：clipboard API 优先，受限环境（iframe 嵌入面板）降级 execCommand */
async function copyLink(c: MediaCandidate): Promise<void> {
  const ok = await (async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(c.url)
      return true
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = c.url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const done = document.execCommand('copy')
        ta.remove()
        return done
      } catch {
        return false
      }
    }
  })()
  toast(ok ? '链接已复制' : '复制失败')
}

/** 直链本地保存（浏览器直下，不经合并队列） */
async function downloadFile(c: MediaCandidate, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true
  const r = await send<{ ok: boolean; reason?: string; error?: string }>({
    type: 'download',
    tabId,
    id: c.id,
    pageTitle: tabTitle,
    fileName: renames.get(c.id),
  })
  if (r?.ok) toast('已开始下载')
  else toast(r?.reason ?? r?.error ?? '下载失败')
  btn.disabled = false
}

// ── split 按钮的下拉菜单（分辨率菜单 / 操作菜单互斥；点击别处 / Esc 关闭） ──
let openMenuEl: HTMLElement | null = null
function closeSplitMenu(): void {
  openMenuEl?.classList.remove('open')
  openMenuEl = null
}
function toggleSplitMenu(menu: HTMLElement, anchor: HTMLElement, list: HTMLElement): void {
  if (openMenuEl === menu) {
    closeSplitMenu()
    return
  }
  closeSplitMenu()
  // 靠近列表底部时向上展开，避免被滚动容器裁剪
  const nearBottom = list.getBoundingClientRect().bottom - anchor.getBoundingClientRect().bottom < 150
  menu.classList.toggle('up', nearBottom)
  menu.classList.add('open')
  openMenuEl = menu
}
document.addEventListener('click', () => closeSplitMenu())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSplitMenu()
})

function appendActions(actions: HTMLElement, c: MediaCandidate, item: HTMLElement): void {
  if (c.kind === 'blob') {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = '页面 MSE 内嵌流：暂不支持，深捕获开发中'
    actions.appendChild(note)
    return
  }

  // 按钮组：[分辨率 ▾]（有 variants 时）+ [下载] + [▾ 更多]（复制链接 / 转存115）
  const isStream = c.kind === 'hls' || c.kind === 'dash'
  const variants = c.variants ?? []
  let selected: HlsVariant | undefined = variants[0]
  const split = document.createElement('div')
  split.className = 'split'

  if (variants.length > 1) {
    split.classList.add('has-quality')
    const qBtn = document.createElement('button')
    qBtn.className = 'split-quality'
    qBtn.title = '选择清晰度'
    qBtn.disabled = !!c.probeError
    const qLabel = document.createElement('span')
    qLabel.textContent = variantLabel(selected)
    const qCaret = document.createElement('span')
    qCaret.innerHTML = ICON_CARET
    qBtn.append(qLabel, qCaret)

    const qMenu = document.createElement('div')
    qMenu.className = 'menu q-menu'
    qBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // 每次展开重建，保证 ✓ 选中态同步
      qMenu.innerHTML = ''
      for (const v of variants) {
        const b = document.createElement('button')
        b.className = 'menu-item'
        b.textContent = (v === selected ? '✓ ' : '') + variantLabel(v)
        b.addEventListener('click', () => {
          selected = v
          qLabel.textContent = variantLabel(selected)
          closeSplitMenu()
        })
        qMenu.appendChild(b)
      }
      toggleSplitMenu(qMenu, qBtn, $('#list'))
    })
    split.appendChild(qBtn)
  }

  const main = document.createElement('button')
  main.className = 'split-main'
  main.textContent = '下载'
  main.disabled = !!c.probeError || !!c.live
  main.addEventListener('click', () =>
    void (isStream
      ? transferHls(c, 'local', selected?.url, main, renames.get(c.id))
      : downloadFile(c, main)),
  )

  const caret = document.createElement('button')
  caret.className = 'split-caret'
  caret.title = '更多操作'
  caret.innerHTML = ICON_CARET
  caret.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleSplitMenu(menu, caret, $('#list'))
  })

  const menu = document.createElement('div')
  menu.className = 'menu'
  const menuItem = (label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'menu-item'
    b.textContent = label
    b.addEventListener('click', () => onClick(b))
    return b
  }
  menu.appendChild(menuItem('复制链接', () => void copyLink(c)))
  // 未预填清晰度的 HLS：保留解析入口（拉取 master playlist 展示轨信息）
  if (isStream && !variants.length) {
    menu.appendChild(menuItem('解析信息', () => void expandHls(c, item)))
  }
  if (v115Enabled) {
    const up = menuItem('转存115', (b) =>
      void transferHls(c, 'cloud', selected?.url, b, renames.get(c.id)),
    )
    up.disabled = !!c.probeError || !!c.live
    menu.appendChild(up)
  }

  split.append(main, caret, menu)
  actions.appendChild(split)

  if (c.live) {
    const note = document.createElement('span')
    note.className = 'note'
    note.textContent = '直播流不支持'
    actions.appendChild(note)
  }
}

/** HLS 任务提交（存本地 / 转存 115 共用） */
async function transferHls(
  c: MediaCandidate,
  dest: 'local' | 'cloud',
  variantUrl: string | undefined,
  btn: HTMLButtonElement,
  fileName?: string,
): Promise<void> {
  btn.disabled = true
  const req =
    dest === 'local'
      ? { type: 'download' as const, tabId, id: c.id, variantUrl, pageTitle: tabTitle, fileName }
      : { type: 'transfer115' as const, tabId, id: c.id, variantUrl, pageTitle: tabTitle, fileName }
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
  v: HlsVariant,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'variant'
  const label = variantLabel(v)
  row.innerHTML = `<span class="badge">${label}</span><span class="name">${v.bandwidth ? Math.round(v.bandwidth / 1000) + 'kbps' : ''}</span>`
  const dl = document.createElement('button')
  dl.className = 'btn'
  dl.textContent = '⬇'
  dl.title = '合并下载为 MP4'
  dl.addEventListener('click', () => void transferHls(cand, 'local', v.url, dl, renames.get(cand.id)))
  row.appendChild(dl)
  if (v115Enabled) {
    const up = document.createElement('button')
    up.className = 'btn'
    up.textContent = '☁'
    up.title = '合并转存到 115'
    up.addEventListener('click', () => void transferHls(cand, 'cloud', v.url, up, renames.get(cand.id)))
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
  // 嵌入模式（悬浮球 iframe 面板）：隐藏外框差异、支持面板关闭与顶栏拖动
  const embedded = new URLSearchParams(location.search).get('embedded') === '1'
  if (embedded) {
    document.body.classList.add('embedded')
    const close = document.createElement('button')
    close.className = 'icon-btn'
    close.title = '收起面板'
    close.textContent = '✕'
    close.addEventListener('click', () => window.parent.postMessage('v2d-close-panel', '*'))
    document.querySelector('.topbar')?.appendChild(close)

    // 顶栏（非按钮处）按住拖动面板：iframe 是独立文档，宿主收不到这里的指针事件，
    // 把 screen 坐标偏移转发给宿主（screenX/Y 不含面板自身位移，连续拖动不会振荡）
    const topbar = document.querySelector<HTMLElement>('.topbar')
    let dragFromX = 0
    let dragFromY = 0
    let topbarDragging = false
    topbar?.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      topbarDragging = true
      dragFromX = e.screenX
      dragFromY = e.screenY
      topbar.setPointerCapture(e.pointerId)
      window.parent.postMessage({ type: 'v2d-panel-drag-start' }, '*')
    })
    topbar?.addEventListener('pointermove', (e) => {
      if (!topbarDragging) return
      window.parent.postMessage(
        { type: 'v2d-panel-drag', dx: e.screenX - dragFromX, dy: e.screenY - dragFromY },
        '*',
      )
    })
    const endTopbarDrag = (): void => {
      if (!topbarDragging) return
      topbarDragging = false
      window.parent.postMessage({ type: 'v2d-panel-drag-end' }, '*')
    }
    topbar?.addEventListener('pointerup', endTopbarDrag)
    topbar?.addEventListener('pointercancel', endTopbarDrag)
    // 指针被父页面/系统抢走时隐式释放捕获，也要结束拖动（防拖动状态卡死）
    topbar?.addEventListener('lostpointercapture', endTopbarDrag)
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

const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent)

/** 读 OPFS 待保存产物并触发 <a download>（扩展页面内，文件名受控）。
 *  iOS：popup 内 blob 下载不可靠（WebKitBlobResource 1）→ 跳转传输管理页走 Web Share。 */
async function saveStagedTask(t: TaskView): Promise<void> {
  if (IS_IOS) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?save=${t.id}`) })
    return
  }
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
  }
}

const TASK_STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  'offline-adding': '提交离线任务',
  'offline-polling': '115 转存中',
  downloading: '下载中',
  hashing: '校验中',
  transmuxing: '合成中',
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
      // 合并完成 → 等待用户点击保存（<a download>，文件名受控；SW 的 downloads API
      // 对 blob URL 会忽略 filename 落成随机名，故不自动保存）
      // iOS：popup 内 blob 下载不可靠 → 跳转传输管理页走 Web Share
      const save = document.createElement('button')
      save.className = 'mini-btn'
      save.textContent = '⬇ 保存到文件'
      save.title = IS_IOS ? '在传输管理页保存到「文件」App' : '保存到本地'
      save.addEventListener('click', () => void saveStagedTask(t))
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
pingBackground()

void init().catch((e) => {
  console.error(e)
  $('#empty').querySelector('p')!.textContent = `初始化失败：${String(e)}`
})

// 保持 scoreCandidate 被引用（供未来本地重排序；当前排序在 SW 侧完成）
void scoreCandidate
