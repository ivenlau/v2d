/** SW 消息协议（popup/options ↔ background）。 */

export type BgRequest =
  | { type: 'list'; tabId: number }
  | { type: 'clear'; tabId: number }
  | { type: 'probe'; tabId: number; id: string }
  | { type: 'probeMany'; tabId: number; ids: string[] }
  | { type: 'download'; tabId: number; id: string; variantUrl?: string; pageTitle?: string }
  | { type: 'hlsInfo'; tabId: number; id: string }
  | { type: 'scanDom'; tabId: number }
  | { type: 'transfer115'; tabId: number; id: string; pageTitle?: string; variantUrl?: string }
  | { type: 'transferList' }
  | { type: 'transferCancel'; taskId: string }
  | { type: 'transferPause'; taskId: string }
  | { type: 'transferResume'; taskId: string }
  | { type: 'transferRetry'; taskId: string }
  | { type: 'transferDelete'; taskId: string }
  | { type: 'transferClearFinished' }
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
