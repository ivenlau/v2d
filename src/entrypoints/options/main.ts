/**
 * 设置页（§9.4）：统一「即改即存」交互；115 区块（§9.5 产品红线）
 * 开关默认关 → 动态申请权限 → 认证引导（扫码/导入 token）→ 已连接面板。
 */

import QRCode from 'qrcode'
import { loadSettings, saveSettings } from '@/core/settings'
import { client115 } from '@/providers/115/runtime'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T
const input = (sel: string): HTMLInputElement => $(sel) as HTMLInputElement
const area = (sel: string): HTMLTextAreaElement => $(sel) as HTMLTextAreaElement

const V115_ORIGINS = ['*://*.115.com/*', '*://*.aliyuncs.com/*']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let savedTimer: ReturnType<typeof setTimeout> | undefined
function flashSaved(): void {
  const el = $('#saved')
  el.classList.add('show')
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => el.classList.remove('show'), 1500)
}

// ── 通用（即改即存） ───────────────────────────────────────────────────
async function initGeneric(): Promise<void> {
  const settings = await loadSettings()
  input('#badge').checked = settings.badge
  area('#blacklist').value = settings.blacklist.join('\n')

  input('#badge').addEventListener('change', async () => {
    await saveSettings({ badge: input('#badge').checked })
    flashSaved()
  })
  // change 事件在失焦时触发，避免每敲一个字符写一次 storage
  area('#blacklist').addEventListener('change', async () => {
    const blacklist = area('#blacklist').value
      .split(/\r?\n/)
      .map((s: string) => s.trim())
      .filter(Boolean)
    await saveSettings({ blacklist })
    flashSaved()
  })
}

// ── 115：启用开关与权限（§9.5） ────────────────────────────────────────
async function init115(): Promise<void> {
  const settings = await loadSettings()
  input('#v115-enabled').checked = settings.v115.enabled
  if (settings.v115.enabled) await showActiveOrAuth()
}

input('#v115-enabled').addEventListener('change', async () => {
  const settings = await loadSettings()
  if (input('#v115-enabled').checked) {
    let granted = false
    try {
      granted = await chrome.permissions.request({ origins: V115_ORIGINS })
    } catch {
      granted = false
    }
    if (!granted) {
      input('#v115-enabled').checked = false
      return
    }
    await saveSettings({ v115: { ...settings.v115, enabled: true } })
    await showActiveOrAuth()
  } else {
    // ⚠️ permissions.remove 在未授予状态下会 reject，必须兜住，
    // 否则异常中断导致 enabled 永远关不掉（历史 bug）
    try {
      await chrome.permissions.remove({ origins: V115_ORIGINS })
    } catch {
      /* 权限本来就不在，忽略 */
    }
    await saveSettings({ v115: { ...settings.v115, enabled: false } })
    $('#v115-auth').classList.add('hidden')
    $('#v115-active').classList.add('hidden')
    setChip('')
  }
})

function setChip(text: string, ok = true): void {
  const chip = $('#v115-state')
  chip.classList.toggle('hidden', !text)
  chip.textContent = text
  chip.style.background = ok ? 'var(--ok)' : 'var(--warn)'
}

async function showActiveOrAuth(): Promise<void> {
  const settings = await loadSettings()
  const client = client115(settings.v115.appId)
  await client.loadToken()
  if (client.hasToken() && (await client.checkLogin())) {
    await showActive()
  } else {
    $('#v115-auth').classList.remove('hidden')
    $('#v115-active').classList.add('hidden')
    setChip('待认证', false)
  }
}

// ── 认证：扫码授权（唯一方式） ─────────────────────────────────────────
input('#qr-start').addEventListener('click', async () => {
  const btn = input('#qr-start')
  const img = $('img#qr-img') as HTMLImageElement
  const status = $('#qr-status')
  btn.disabled = true
  try {
    const client = client115()
    const start = await client.startQrAuth()
    img.src = await QRCode.toDataURL(start.qrcode, { width: 180, margin: 1 })
    img.classList.remove('hidden')
    status.textContent = '等待扫码…'

    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await sleep(2000)
      const s = await client.pollQrStatus(start.uid, start.time, start.sign)
      if (s === 1) status.textContent = '已扫码，请在手机上确认'
      else if (s === 2) {
        await client.exchangeQrToken(start.uid, start.verifier)
        status.textContent = '授权成功 ✓'
        btn.disabled = false
        await showActive()
        return
      } else if (s === -1) {
        status.textContent = '二维码已过期，请重新生成'
        break
      } else if (s === -2) {
        status.textContent = '已取消授权，请重新生成'
        break
      }
    }
  } catch (e) {
    status.textContent = `失败：${e instanceof Error ? e.message : String(e)}（检查网络，或权限是否已授予）`
  }
  btn.disabled = false
})

// ── 已连接面板 ────────────────────────────────────────────────────────
interface DirEntry {
  /** ⚠️ 字符串透传：115 新体系 file_id 超 JS 安全整数，数字化会精度丢失 */
  cid: string
  name: string
}
let dirTrail: DirEntry[] = [{ cid: '0', name: '' }]

function trailPath(): string {
  const names = dirTrail.slice(1).map((t) => t.name)
  return names.length ? '/' + names.join('/') : '/'
}

function renderSavedPath(root?: string): void {
  // 「已保存」与「正在浏览」是两回事：前者持久显示，不被目录浏览覆盖（历史 bug）
  $('#dir-saved').textContent =
    root?.trim() || '默认规则（/来自浏览器/{站点}/{年-月}/）'
}

async function showActive(): Promise<void> {
  $('#v115-auth').classList.add('hidden')
  $('#v115-active').classList.remove('hidden')
  setChip('已连接')

  const client = client115()
  const { used, total } = await client.userSpace()
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1) + ' GB'
  $('#v115-space').textContent = total ? `空间：${gb(used)} / ${gb(total)}` : '空间信息获取失败'

  const settings = await loadSettings()
  renderSavedPath(settings.v115.targetRoot)
  dirTrail = [{ cid: '0', name: '' }]
  renderCrumbs()
  await loadDir('0')
}

async function loadDir(cid: string): Promise<void> {
  const listEl = $('#dir-list')
  listEl.innerHTML = '<div class="dim">加载中…</div>'
  try {
    const { list } = await client115().listFiles(cid, 100)
    const dirs = list
      .map((it) => ({
        cid: String(it.file_id ?? it.fid ?? it.cid ?? ''),
        name: String(it.file_name ?? it.fn ?? ''),
        isDir: String(it.file_category ?? it.fc ?? '') === '0',
      }))
      .filter((it) => it.isDir && it.cid)
    listEl.innerHTML = ''
    if (!dirs.length) listEl.innerHTML = '<div class="dim">（空目录）</div>'
    for (const d of dirs) {
      const row = document.createElement('div')
      row.className = 'dir-row'
      row.textContent = '📁 ' + d.name
      row.addEventListener('click', () => {
        dirTrail.push({ cid: d.cid, name: d.name })
        renderCrumbs()
        void loadDir(d.cid)
      })
      listEl.appendChild(row)
    }
    renderCrumbs()
  } catch (e) {
    listEl.innerHTML = `<div class="dim">加载失败：${e instanceof Error ? e.message : String(e)}</div>`
  }
}

function renderCrumbs(): void {
  const crumbs = $('#dir-breadcrumbs')
  crumbs.innerHTML = ''
  const label = document.createElement('span')
  label.className = 'dim'
  label.textContent = '正在浏览：'
  crumbs.appendChild(label)
  dirTrail.forEach((t, i) => {
    if (i > 0) {
      const sep = document.createElement('span')
      sep.textContent = ' / '
      crumbs.appendChild(sep)
    }
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = i === 0 ? '根目录' : t.name
    a.addEventListener('click', (ev) => {
      ev.preventDefault()
      dirTrail = dirTrail.slice(0, i + 1)
      renderCrumbs()
      void loadDir(t.cid)
    })
    crumbs.appendChild(a)
  })
}

input('#dir-create').addEventListener('click', async () => {
  const name = input('#dir-newname').value.trim()
  if (!name) return
  const parentCid = dirTrail[dirTrail.length - 1].cid
  await client115().createDir(parentCid, name)
  input('#dir-newname').value = ''
  await loadDir(parentCid)
})

input('#dir-select').addEventListener('click', async () => {
  const settings = await loadSettings()
  await saveSettings({ v115: { ...settings.v115, targetRoot: trailPath() } })
  renderSavedPath(trailPath())
  flashSaved()
})

input('#dir-reset').addEventListener('click', async () => {
  const settings = await loadSettings()
  await saveSettings({ v115: { ...settings.v115, targetRoot: '' } })
  renderSavedPath(undefined)
  flashSaved()
})

input('#v115-logout').addEventListener('click', async () => {
  await client115().forgetTokens()
  $('#v115-active').classList.add('hidden')
  $('#v115-auth').classList.remove('hidden')
  setChip('待认证', false)
})

void initGeneric()
void init115()
