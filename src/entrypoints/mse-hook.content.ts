/**
 * MSE 深捕获钩子（MAIN world，document_start，先于页面脚本执行）：
 * 补丁 SourceBuffer.prototype.appendBuffer / MediaSource.addSourceBuffer /
 * SourceBuffer.changeType，把播放器喂进 MSE 的媒体字节按 SourceBuffer 分组缓存。
 * 页面内存是捕获数据的真相源（上限 600MB/组，超出截断并标记）；
 * 经 ISOLATED 桥（mse-bridge.content）向扩展上报摘要、按需分块拉取。
 * 所有补丁逻辑都在 try/catch 内——捕获失败绝不能影响页面播放。
 */

interface MseGroup {
  id: number
  mime: string
  chunks: Uint8Array[]
  bytes: number
  appends: number
  overflow: boolean
}

interface MseWindow {
  __v2dMseHook?: boolean
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  main: () => {
    const w = window as unknown as MseWindow
    if (w.__v2dMseHook) return
    w.__v2dMseHook = true

    const MAX_GROUP_BYTES = 600 * 1024 * 1024
    const groups = new Map<number, MseGroup>()
    const sbIds = new WeakMap<object, number>()
    let nextId = 1

    const trackKind = (mime: string): 'video' | 'audio' | 'combined' => {
      if (mime.startsWith('audio/')) return 'audio'
      const codecs = /codecs="?([^"]*)"?/.exec(mime)?.[1] ?? ''
      return codecs.includes(',') ? 'combined' : 'video'
    }

    try {
      // addSourceBuffer：登记每个 SourceBuffer 的 mimeType → 分组
      const msProto = MediaSource.prototype as unknown as {
        addSourceBuffer: (mime: string) => SourceBuffer
      }
      const origAdd = msProto.addSourceBuffer
      msProto.addSourceBuffer = function (mime: string) {
        const sb = origAdd.call(this, mime)
        try {
          const id = nextId++
          sbIds.set(sb, id)
          groups.set(id, { id, mime: String(mime), chunks: [], bytes: 0, appends: 0, overflow: false })
        } catch {
          /* ignore */
        }
        return sb
      }

      // appendBuffer：抓字节（保留引用——播放器不会复用 append 后的 buffer）
      const sbProto = SourceBuffer.prototype as unknown as {
        appendBuffer: (data: ArrayBuffer | ArrayBufferView) => void
      }
      const origAppend = sbProto.appendBuffer
      sbProto.appendBuffer = function (data: ArrayBuffer | ArrayBufferView) {
        try {
          const id = sbIds.get(this)
          const g = id !== undefined ? groups.get(id) : undefined
          if (g && !g.overflow) {
            const view = ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : new Uint8Array(data)
            if (g.bytes + view.byteLength <= MAX_GROUP_BYTES) {
              g.chunks.push(view)
              g.bytes += view.byteLength
              g.appends += 1
              scheduleAnnounce()
            } else {
              g.overflow = true
              scheduleAnnounce()
            }
          }
        } catch {
          /* ignore */
        }
        return origAppend.call(this, data)
      }

      // changeType（清晰度/编码切换）：旧数据拼新编码不可播，重置该组
      const sbWithChange = sbProto as unknown as { changeType?: (mime: string) => void }
      if (typeof sbWithChange.changeType === 'function') {
        const origChange = sbWithChange.changeType
        sbWithChange.changeType = function (mime: string) {
          try {
            const id = sbIds.get(this)
            const g = id !== undefined ? groups.get(id) : undefined
            if (g) {
              g.mime = String(mime)
              g.chunks = []
              g.bytes = 0
              g.appends = 0
              g.overflow = false
              scheduleAnnounce()
            }
          } catch {
            /* ignore */
          }
          return origChange.call(this, mime)
        }
      }
    } catch {
      /* MediaSource 不可用（老内核）→ 静默放弃捕获 */
    }

    // ── 摘要上报（1s 节流）与分块拉取（stop-and-wait 背压） ──
    const announce = (): void => {
      const list = [...groups.values()]
        .filter((g) => g.bytes > 0)
        .map((g) => ({
          groupId: String(g.id),
          mime: g.mime,
          bytes: g.bytes,
          appends: g.appends,
          trackKind: trackKind(g.mime),
          overflow: g.overflow,
          title: document.title,
        }))
      window.postMessage({ __v2dMse: 'groups', groups: list }, '*')
    }
    let announceTimer: number | undefined
    const scheduleAnnounce = (): void => {
      if (announceTimer !== undefined) return
      announceTimer = window.setTimeout(() => {
        announceTimer = undefined
        announce()
      }, 1000)
    }

    const CHUNK = 2 * 1024 * 1024
    window.addEventListener('message', (e) => {
      const m = e.data as
        | { __v2dMse: string; requestId?: string; groupId?: string; limitBytes?: number }
        | undefined
      if (!m || e.source !== window) return

      // SW 重启会丢分组内存态：拉取方发现组缺失时先请求一次重新上报再重试
      if (m.__v2dMse === 'announce') {
        announce()
        return
      }

      if (m.__v2dMse === 'pull' && m.requestId && m.groupId) {
        const g = groups.get(Number(m.groupId))
        if (!g || g.bytes === 0) {
          window.postMessage({ __v2dMse: 'pull-missing', requestId: m.requestId }, '*')
          return
        }        // 拉取快照：只发开始拉取时已存在的分块（期间新 append 的不计入）
        const snapshot = g.chunks.slice()
        const limit = typeof m.limitBytes === 'number' && m.limitBytes > 0 ? m.limitBytes : Infinity
        window.postMessage(
          {
            __v2dMse: 'pull-meta',
            requestId: m.requestId,
            mime: g.mime,
            bytes: snapshot.reduce((s, c) => s + c.byteLength, 0),
            appends: g.appends,
            overflow: g.overflow,
          },
          '*',
        )
        let idx = 0
        let off = 0
        let sent = 0
        const sendNext = (): void => {
          if (idx >= snapshot.length || sent >= limit) {
            window.postMessage({ __v2dMse: 'pull-done', requestId: m.requestId }, '*')
            window.removeEventListener('message', onAck)
            return
          }
          const chunk = snapshot[idx]
          const end = Math.min(off + CHUNK, chunk.byteLength, off + (limit - sent))
          window.postMessage(
            {
              __v2dMse: 'pull-chunk',
              requestId: m.requestId,
              data: chunk.subarray(off, end),
              done: idx === snapshot.length - 1 && end >= chunk.byteLength,
            },
            '*',
          )
          sent += end - off
          off = end
          if (off >= chunk.byteLength) {
            idx++
            off = 0
          }
        }
        const onAck = (e2: MessageEvent): void => {
          const a = e2.data as { __v2dMse?: string; requestId?: string } | undefined
          if (!a || a.__v2dMse !== 'pull-ack' || a.requestId !== m.requestId) return
          sendNext()
        }
        window.addEventListener('message', onAck)
        sendNext()
      }
    })
  },
})
