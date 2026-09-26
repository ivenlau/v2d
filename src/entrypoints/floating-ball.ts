/**
 * 悬浮球（默认关闭，设置页开关控制）：注册式内容脚本，每页加载读一次设置，
 * 未开启直接返回（单次 storage 读 + 早退，开销可忽略）。
 * Shadow DOM 隔离样式；可拖动（记忆位置）；点击展开页内快捷面板
 * （iframe 加载扩展 popup 页，嵌入模式下与页面通过 postMessage 关闭面板）。
 */

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main: async () => {
    interface BallWindow {
      __v2dFloatingBall?: boolean
    }
    if ((window as unknown as BallWindow).__v2dFloatingBall) return
    ;(window as unknown as BallWindow).__v2dFloatingBall = true
    // iOS：内容脚本被注入即证明扩展在运行——经后台把「已启动」标记写进 App Group（失败静默）
    void chrome.runtime.sendMessage({ type: 'v2d/app-ping' }).catch(() => {})
    // iOS 加固：body 未就绪不注入（避免挂到 <html> 破坏布局）
    if (!document.body) return
    if (!location.protocol.startsWith('http')) return

    // ── 设置门禁：未开启 / 黑名单 → 不注入 ──
    try {
      const stored = (await chrome.storage.local.get('settings')).settings as {
        floatingBall?: boolean
        blacklist?: string[]
      }
      if (!stored?.floatingBall) return
      const host = location.hostname
      const blocked = (stored.blacklist ?? []).some(
        (e) => host === e || host.endsWith('.' + e),
      )
      if (blocked) return
    } catch {
      return
    }

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
        height: min(${PANEL_H}px, 82vh);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 10px 40px rgba(0,0,0,.4);
        border: 1px solid rgba(0,0,0,.15);
        display: none;
      }
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
        // 面板宽度自适应视口（iOS 窄屏），位置居中于球并夹紧在视口内
        const w = Math.min(PANEL_W, window.innerWidth - 16)
        const h = Math.min(PANEL_H, Math.round(window.innerHeight * 0.82))
        wrap.style.width = `${w}px`
        wrap.style.height = `${h}px`
        const left = x + BALL_SIZE / 2 - w / 2
        wrap.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`
        const top = y + BALL_SIZE / 2 - h / 2
        wrap.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`
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
    document.body.appendChild(host)

    window.addEventListener('resize', () => {
      clamp()
      applyPos()
    })
  },
})
