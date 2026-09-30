/**
 * 悬浮球（默认关闭，设置页开关控制）：注册式内容脚本，每页加载读一次设置，
 * 未开启直接返回（单次 storage 读 + 早退，开销可忽略）。
 * Shadow DOM 隔离样式；可拖动（记忆位置）；点击展开页内快捷面板
 * （iframe 加载扩展 popup 页，嵌入模式下与页面通过 postMessage 关闭面板）。
 * 面板拖动由嵌入 popup 顶栏（非按钮处）发起：iframe 是独立文档、父页面收不到
 * 其内部指针事件，经 postMessage 转发 screen 坐标偏移（不受面板自身位移影响）。
 */

import { pingBackground } from '@/core/messages'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main: async () => {
    interface BallWindow {
      __v2dFloatingBall?: boolean
    }
    if ((window as unknown as BallWindow).__v2dFloatingBall) return
    ;(window as unknown as BallWindow).__v2dFloatingBall = true
    // iOS 加固：body 未就绪不注入（避免挂到 <html> 破坏布局）
    if (!document.body) return
    if (!location.protocol.startsWith('http')) return

    // ── 设置门禁：未开启 / 黑名单 → 不注入 ──
    // iOS 加固：Safari 的 chrome 命名空间可能不返回 Promise（await undefined 会崩），
    // 统一回调风格读设置，任何异常都按「未开启」处理（保持零注入原则）
    type BallSettings = { settings?: { floatingBall?: boolean; blacklist?: string[] } }
    const stored = await new Promise<BallSettings>((resolve) => {
      try {
        // 回调签名在 @types/chrome 里返回 void，运行时可能返回 Promise——转型后兼容两者
        const api = chrome.storage.local as unknown as {
          get(key: string, cb: (res: unknown) => void): unknown
        }
        const r = api.get('settings', (res) => resolve((res ?? {}) as BallSettings))
        if (r instanceof Promise)
          r.then((v) => resolve((v ?? {}) as BallSettings)).catch(() => resolve({}))
      } catch {
        resolve({})
      }
    })
    const setting = stored?.settings
    if (!setting?.floatingBall) return
    const siteHost = location.hostname
    const blocked = (setting.blacklist ?? []).some(
      (e) => siteHost === e || siteHost.endsWith('.' + e),
    )
    if (blocked) return

    const BALL_SIZE = 44
    const PANEL_W = 392
    const PANEL_H = 600

    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .ball {
        position: fixed;
        z-index: 2147483646;
        width: ${BALL_SIZE}px;
        height: ${BALL_SIZE}px;
        border-radius: 50%;
        /* design/style.md：实心墨色盘（系统的主操作语言），细发丝环隔离任意底色页面 */
        background: #0a0a0a;
        color: #fafafa;
        border: 1px solid rgba(255,255,255,.22);
        box-shadow: 0 0 0 1px rgba(23,23,23,.06), 0 4px 16px rgba(0,0,0,.18);
        display: flex;
        align-items: center;
        justify-content: center;
        font: 600 10px/1 "Geist", "Inter", ui-sans-serif, system-ui, sans-serif;
        letter-spacing: .06em;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
      }
      .panel-wrap {
        position: fixed;
        z-index: 2147483647;
        height: min(${PANEL_H}px, 82vh);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 0 0 1px rgba(23,23,23,.05), 0 12px 40px rgba(0,0,0,.18);
        border: 1px solid #e5e5e5;
        display: none;
      }
      .panel-wrap.open { display: block; }
      iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    `
    shadow.append(style)

    // 记忆位置（页面本地存储；默认右下角）
    const saved = localStorage.getItem('v2d-ball-pos')
    let x = saved ? Number(JSON.parse(saved).x) : window.innerWidth - BALL_SIZE - 24
    let y = saved ? Number(JSON.parse(saved).y) : Math.round(window.innerHeight * 0.72)
    const clamp = (): void => {
      x = Math.min(Math.max(8, x), window.innerWidth - BALL_SIZE - 8)
      y = Math.min(Math.max(8, y), window.innerHeight - BALL_SIZE - 8)
    }
    clamp()

    const ball = document.createElement('div')
    ball.className = 'ball'
    ball.textContent = 'V2D'
    applyPos()

    const wrap = document.createElement('div')
    wrap.className = 'panel-wrap'
    const iframe = document.createElement('iframe')
    iframe.src = chrome.runtime.getURL('popup.html') + '?embedded=1'
    wrap.appendChild(iframe)

    // 面板位置（拖动记忆；未拖过则每次打开居中于球）
    let pw = PANEL_W
    let ph = PANEL_H
    let px = 0
    let py = 0
    let panelPlaced = false
    const savedPanelPos = localStorage.getItem('v2d-panel-pos')
    if (savedPanelPos) {
      px = Number(JSON.parse(savedPanelPos).x)
      py = Number(JSON.parse(savedPanelPos).y)
      panelPlaced = true
    }
    const clampPanel = (): void => {
      px = Math.min(Math.max(8, px), window.innerWidth - pw - 8)
      py = Math.min(Math.max(8, py), window.innerHeight - ph - 8)
    }
    const applyPanelPos = (): void => {
      wrap.style.left = `${px}px`
      wrap.style.top = `${py}px`
    }

    function applyPos(): void {
      ball.style.left = `${x}px`
      ball.style.top = `${y}px`
    }

    // ── 拖动 + 点击判定（相对按下点的累计位移超 4px 即视为拖动，不触发面板） ──
    let dragging = false
    let moved = false
    let downX = 0
    let downY = 0
    let lastX = 0
    let lastY = 0
    ball.addEventListener('pointerdown', (e) => {
      dragging = true
      moved = false
      downX = e.clientX
      downY = e.clientY
      lastX = e.clientX
      lastY = e.clientY
      ball.setPointerCapture(e.pointerId)
    })
    ball.addEventListener('pointermove', (e) => {
      if (!dragging) return
      x += e.clientX - lastX
      y += e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) moved = true
      applyPos()
    })
    ball.addEventListener('pointerup', () => {
      if (!dragging) return
      dragging = false
      clamp()
      applyPos()
      localStorage.setItem('v2d-ball-pos', JSON.stringify({ x, y }))
      if (!moved) togglePanel()
    })

    let panelOpen = false
    function togglePanel(): void {
      panelOpen = !panelOpen
      if (panelOpen) {
        // 面板尺寸自适应视口（iOS 窄屏）；位置：拖动过→记忆位置，否则居中于球
        pw = Math.min(PANEL_W, window.innerWidth - 16)
        ph = Math.min(PANEL_H, Math.round(window.innerHeight * 0.82))
        wrap.style.width = `${pw}px`
        wrap.style.height = `${ph}px`
        if (!panelPlaced) {
          px = x + BALL_SIZE / 2 - pw / 2
          py = y + BALL_SIZE / 2 - ph / 2
        }
        clampPanel()
        applyPanelPos()
        wrap.classList.add('open')
      } else {
        wrap.classList.remove('open')
      }
    }

    // 面板内（嵌入 popup）发来的消息：关闭面板 / 顶栏拖动。
    // screen 坐标偏移不含面板自身位移，连续拖动不会振荡；只认自己面板发来的消息
    let dragBasePx = 0
    let dragBasePy = 0
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return
      const d = e.data as string | { type?: string; dx?: number; dy?: number } | undefined
      if (typeof d === 'string') {
        if (d === 'v2d-close-panel' && panelOpen) togglePanel()
        return
      }
      if (!panelOpen || !d?.type) return
      if (d.type === 'v2d-panel-drag-start') {
        dragBasePx = px
        dragBasePy = py
      } else if (d.type === 'v2d-panel-drag' && typeof d.dx === 'number' && typeof d.dy === 'number') {
        px = dragBasePx + d.dx
        py = dragBasePy + d.dy
        panelPlaced = true
        clampPanel()
        applyPanelPos()
      } else if (d.type === 'v2d-panel-drag-end') {
        localStorage.setItem('v2d-panel-pos', JSON.stringify({ x: px, y: py }))
      }
    })

    shadow.append(ball, wrap)
    document.body.appendChild(host)

    // 注入完成 → ping 后台写「已启动」标记（失败静默，绝不影响球本身）
    pingBackground()

    window.addEventListener('resize', () => {
      clamp()
      applyPos()
      if (panelOpen) {
        clampPanel()
        applyPanelPos()
      }
    })
  },
})
