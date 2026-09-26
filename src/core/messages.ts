/** SW 消息协议（popup/options ↔ background）。 */

export type BgRequest =
  | { type: 'list'; tabId: number }
  | { type: 'clear'; tabId: number }
  | { type: 'probe'; tabId: number; id: string }
  | { type: 'probeMany'; tabId: number; ids: string[] }
  | { type: 'download'; tabId: number; id: string; variantUrl?: string; pageTitle?: string }
  | { type: 'hlsInfo'; tabId: number; id: string }
  | { type: 'scanDom'; tabId: number }
  | { type: 'siteProbe'; tabId: number }
  | { type: 'transfer115'; tabId: number; id: string; pageTitle?: string; variantUrl?: string }
  | { type: 'transferList' }
  | { type: 'transferCancel'; taskId: string }
  | { type: 'transferPause'; taskId: string }
  | { type: 'transferResume'; taskId: string }
  | { type: 'transferRetry'; taskId: string }
  | { type: 'transferDelete'; taskId: string }
  | { type: 'transferClearFinished' }
  /** Safari：向传输宿主页索取合并产物的 blob URL（用户手势内触发 <a download>） */
  | { type: 'getStagedBlob'; taskId: string }
  /** 手动彩蛋：粘贴 直链/磁力/ed2k 走 115 离线（§离线已移出自动通道） */
  | { type: 'offlineSubmit'; url: string }

/** offscreen ↔ SW 的内部事件（不经 BgRequest 路由） */
export interface TaskEvent {
  type: 'v2d/task-event'
  taskId: string
  state?: string
  received?: number
  uploaded?: number
  size?: number
  speedBps?: number
  error?: string
  pickCode?: string
  instant?: boolean
}

export async function send<T = unknown>(req: BgRequest): Promise<T> {
  return chrome.runtime.sendMessage(req) as Promise<T>
}

/**
 * 尽力而为的后台 ping（iOS「已启动」标记）。
 * Safari 的 chrome 命名空间对回调/承诺的支持不一致：统一走回调风格，
 * 返回 Promise 就再兜一层 catch；同步抛错（上下文失效等）也吞掉。
 * 任何情况下都不允许抛错——调用方（尤其内容脚本）不能因此中断。
 */
export function pingBackground(): void {
  try {
    const r = (
      chrome.runtime as unknown as {
        sendMessage(msg: unknown, cb?: (resp: unknown) => void): unknown
      }
    ).sendMessage({ type: 'v2d/app-ping' }, () => void chrome.runtime.lastError)
    if (r instanceof Promise) r.catch(() => {})
  } catch {
    /* ignore */
  }
}
