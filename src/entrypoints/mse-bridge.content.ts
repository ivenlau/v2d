/**
 * MSE 深捕获桥（ISOLATED world）：MAIN world 钩子没有 chrome API，
 * 本桥用 window.postMessage ↔ chrome.runtime 双向搬运：
 *   钩子 → bg：分组摘要 / 拉取元数据 / 数据块（逐块等待 bg 写完再 ack，形成背压）/ 完成信号
 *   bg → 钩子：拉取请求
 * 数据块经 runtime 消息以 base64 传输（通道不支持 TypedArray，会序列化成空对象），单块 2MB。
 */

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  main: () => {
    const send = (msg: Record<string, unknown>): void => {
      try {
        const r = chrome.runtime.sendMessage(msg)
        if (r instanceof Promise) r.catch(() => {})
      } catch {
        /* 扩展上下文失效（更新/重载）→ 静默 */
      }
    }

    window.addEventListener('message', (e) => {
      if (e.source !== window) return
      const m = e.data as { __v2dMse?: string; requestId?: string } | undefined
      if (!m || !m.__v2dMse) return

      if (m.__v2dMse === 'groups') {
        send({ type: 'v2d/mse-groups', groups: (m as { groups: unknown }).groups })
      } else if (m.__v2dMse === 'pull-meta') {
        const p = m as unknown as {
          requestId: string
          mime: string
          bytes: number
          appends: number
          overflow: boolean
        }
        send({
          type: 'v2d/mse-meta',
          requestId: p.requestId,
          mime: p.mime,
          bytes: p.bytes,
          appends: p.appends,
          overflow: p.overflow,
        })
      } else if (m.__v2dMse === 'pull-chunk') {
        const p = m as unknown as { requestId: string; data: ArrayBuffer; done: boolean }
        // 背压：等 bg 落盘完成再 ack 钩子发下一块。
        // ⚠️ runtime 消息通道不支持 TypedArray（会序列化成空对象），必须走 base64
        void (async () => {
          try {
            const bytes = new Uint8Array(p.data)
            let bin = ''
            for (let i = 0; i < bytes.length; i += 0x8000) {
              bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            }
            const resp = (await chrome.runtime.sendMessage({
              type: 'v2d/mse-chunk',
              requestId: p.requestId,
              data: btoa(bin),
              done: p.done,
            })) as { ok?: boolean } | undefined
            if (resp && resp.ok === false) return // 写失败：不再 ack，拉取停滞由 bg 超时收口
          } catch {
            return
          }
          window.postMessage({ __v2dMse: 'pull-ack', requestId: p.requestId }, '*')
        })()
      } else if (m.__v2dMse === 'pull-missing') {
        send({ type: 'v2d/mse-pull-missing', requestId: m.requestId })
      } else if (m.__v2dMse === 'pull-done') {
        send({ type: 'v2d/mse-pull-done', requestId: m.requestId })
      }
    })

    // bg → 钩子：拉取请求 / 重新上报摘要（SW 重启后恢复分组内存态）
    chrome.runtime.onMessage.addListener((msg: { type?: string; requestId?: string; groupId?: string; limitBytes?: number }) => {
      if (msg?.type === 'v2d/mse-pull' && msg.requestId && msg.groupId) {
        window.postMessage(
          {
            __v2dMse: 'pull',
            requestId: msg.requestId,
            groupId: msg.groupId,
            ...(typeof msg.limitBytes === 'number' ? { limitBytes: msg.limitBytes } : {}),
          },
          '*',
        )
      } else if (msg?.type === 'v2d/mse-announce') {
        window.postMessage({ __v2dMse: 'announce' }, '*')
      }
      return false
    })
  },
})
