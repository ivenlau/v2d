/**
 * 悬浮球（默认关闭，设置页开启后由 SW 在页面加载完成时注入）。
 * 自包含 unlisted 脚本：Shadow DOM 隔离样式；可拖动；点击展开页内快捷面板
 * （iframe 加载扩展 popup 页，嵌入模式下与页面通过 postMessage 关闭面板）。
 */

export default defineUnlistedScript(() => {
  interface BallWindow {
    __v2dFloatingBall?: boolean
  }
  if ((window as unknown as BallWindow).__v2dFloatingBall) return
  ;(window as unknown as BallWindow).__v2dFloatingBall = true

  const BALL_SIZE = 44
  const PANEL_W = 392
  const PANEL_H = 600

  const host = document.createElement('div')
  host.id = 'v2d-float-host'
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
      background: linear-gradient(135deg, #6366f1, #4338ca);
      color: #fff;
      border: 2px solid rgba(255,255,255,.85);
      box-shadow: 0 4px 14px rgba(0,0,0,.28);
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 11px/1 system-ui, sans-serif;
      letter-spacing: .3px;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    .panel-wrap {
      position: fixed;
      z-index: 2147483647;
      width: ${PANEL_W}px;
      height: ${PANEL_H}px;
      max-height: 82vh;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,.4);
      border: 1px solid rgba(0,0,0,.15);
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

  function applyPos(): void {
    ball.style.left = `${x}px`
    ball.style.top = `${y}px`
  }

  // ── 拖动 + 点击判定（位移阈值 4px） ──
  let dragging = false
  let moved = false
  let sx = 0
  let sy = 0
  ball.addEventListener('pointerdown', (e) => {
    dragging = true
    moved = false
    sx = e.clientX
    sy = e.clientY
    ball.setPointerCapture(e.pointerId)
  })
  ball.addEventListener('pointermove', (e) => {
    if (!dragging) return
    x += e.clientX - sx
    y += e.clientY - sy
    sx = e.clientX
    sy = e.clientY
    moved = moved || Math.abs(e.clientX - sx) > 2 || Math.abs(e.clientY - sy) > 2
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
      clamp()
      wrap.style.left = `${Math.max(8, x - PANEL_W + BALL_SIZE + 16)}px`
      wrap.style.top = `${Math.max(8, Math.min(y, window.innerHeight - PANEL_H - 8))}px`
      wrap.classList.add('open')
    } else {
      wrap.classList.remove('open')
    }
  }

  // 面板内（嵌入 popup）发来的关闭消息
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data === 'v2d-close-panel' && panelOpen) togglePanel()
  })

  shadow.append(ball, wrap)
  document.documentElement.appendChild(host)

  window.addEventListener('resize', () => {
    clamp()
    applyPos()
  })
})
