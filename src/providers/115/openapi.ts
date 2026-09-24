/**
 * 115 开放平台 API 客户端（对照 tg115bot cloud115/openapi.py 逐语义移植，
 * 零第三方依赖；扩展环境浏览器原生 UA 与 Chrome 126 UA 同族，无需覆写）。
 *
 * 协议自包含：
 *   鉴权  PKCE(S256) 扫码授权 -> access_token / refresh_token（Bearer 头）
 *   刷新  POST /open/refreshToken；业务返回 40140125/40140126 时自动刷新并重试一次
 *   目录  GET /open/folder/get_info（path -> file_id/cid，带缓存）
 *         POST /open/folder/add（建目录；code 20004 = 已存在视为成功）
 *   上传  POST /open/upload/init（秒传探测：fileid=整文件SHA1大写、target=U_1_{cid}；
 *         data.status==2 命中；sign_key/sign_check 需二次区间 SHA1 后重调）
 *         GET /open/upload/get_token（OSS STS 临时凭证，每次全新——见 ossUpload.ts 约束）
 *   离线  POST /open/offline/add_task_urls（⚠️ urls 字段是单个 URL 字符串，尽管名字是复数）
 *   扫码  POST passportapi /open/authDeviceCode -> GET qrcodeapi /get/status/ -> POST deviceCodeToToken
 *
 * 端口注入：fetchFn / storage 可替换 —— 单测用 mock，扩展内接全局 fetch 与 chrome.storage.local。
 */

import type { FetchLike, JsonStorage } from './env'
import { createMemoryStorage } from './env'
import { RateLimiter } from './rate'
import { makePkcePair } from './pkce'
import type { OssCallback, OssToken } from './ossSign'

export const BASE_API = 'https://proapi.115.com'
export const BASE_PASSPORT = 'https://passportapi.115.com'
export const QR_STATUS_URL = 'https://qrcodeapi.115.com/get/status/'
/** p115client 同款公共测试 AppID；用户可在设置中覆盖为自己的开放平台 app_id */
export const DEFAULT_APP_ID = 100195125

/** 令牌相关错误码（对照 telegram-115bot handle_token_expiry） */
export const CODE_TOKEN_EXPIRED = 40140125 // access_token 过期，可刷新后重试
export const CODE_TOKEN_INVALID = 40140126 // 被其他会话刷新吊销（115 单会话轮换）
export const CODE_NEED_REAUTH = [40140116, 40140119] // 授权已解除，必须重新扫码
export const CODE_DIR_EXISTS = 20004 // 目录已存在

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthRequiredError'
  }
}

export type JsonDict = Record<string, any>

export interface TokenPair {
  access_token: string
  refresh_token: string
}

export interface Open115Options {
  fetchFn?: FetchLike
  storage?: JsonStorage
  storageKey?: string
  rateLimiter?: RateLimiter
  appId?: number
  /** token 轮换落盘时回调（worker 场景：经消息桥交回 SW 持久化） */
  onTokenSaved?: (pair: TokenPair) => void
}

const TOKEN_KEY_DEFAULT = '115.open_token'

export interface QrAuthStart {
  uid: string | number
  time: string | number
  sign: string
  /** 可直接渲染成二维码的 URL */
  qrcode: string
  verifier: string
}

export interface UploadInitData {
  /** status==2 秒传命中 */
  status?: string | number
  bucket?: string
  object?: string
  callback?: OssCallback
  pick_code?: string
  /** 二次区间校验：sign_check 形如 "1234567-2345678"（闭区间字节） */
  sign_key?: string
  sign_check?: string
}

export interface OfflineTask {
  name?: string
  url?: string
  /** -1 失败 / 1 进行 / 2 完成 */
  status?: number
  percentDone?: number
  info_hash?: string
  file_id?: string | number
  wp_path_id?: string | number
  delete_file_id?: string | number
  [k: string]: unknown
}

export class Open115Client {
  private readonly fetchFn: FetchLike
  private readonly storage: JsonStorage
  private readonly storageKey: string
  private readonly rate: RateLimiter
  private readonly onTokenSaved?: (pair: TokenPair) => void
  readonly appId: number

  accessToken = ''
  refreshToken = ''
  requestCount = 0
  readonly dailyLimit = 9500 // 官方 10000/日打 0.95 折
  private countDate = -1
  private pathCache = new Map<string, JsonDict>()
  /** token 是否已从 storage 水合（每上下文实例一次） */
  private tokenHydrated = false

  constructor(opts: Open115Options = {}) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init))
    this.storage = opts.storage ?? createMemoryStorage()
    this.storageKey = opts.storageKey ?? TOKEN_KEY_DEFAULT
    this.rate = opts.rateLimiter ?? new RateLimiter(500, 200)
    this.onTokenSaved = opts.onTokenSaved
    this.appId = opts.appId ?? DEFAULT_APP_ID
    const today = dayOfYear()
    this.countDate = today
  }

  // ── token 持久化 ──────────────────────────────────────────────────────
  async loadToken(): Promise<void> {
    const data = (await this.storage.get(this.storageKey)) as
      | Partial<TokenPair>
      | undefined
    this.accessToken = String(data?.access_token ?? '')
    this.refreshToken = String(data?.refresh_token ?? '')
    this.tokenHydrated = true
  }

  /**
   * ⚠️ 关键：SW / options / offscreen worker 各持有独立 client 实例，
   * token 的持久真相在 storage。鉴权请求前必须惰性水合一次——
   * 否则 worker 首个请求就是匿名请求，115 报 40140123「access_token 格式错误」
   * （历史 bug：只有 options 页显式调过 loadToken，worker 从未加载）。
   */
  private async ensureTokenHydrated(): Promise<void> {
    if (!this.tokenHydrated) await this.loadToken()
  }

  hasToken(): boolean {
    return !!(this.accessToken || this.refreshToken)
  }

  private async saveToken(): Promise<void> {
    const pair = { access_token: this.accessToken, refresh_token: this.refreshToken }
    await this.storage.set(this.storageKey, { ...pair, saved_at: Date.now() })
    this.onTokenSaved?.(pair)
  }

  /** 设置页「导入 token」（§9.5 备用认证手段：从 tg115bot 导出后粘贴） */
  async importTokens(pair: TokenPair): Promise<void> {
    this.accessToken = pair.access_token
    this.refreshToken = pair.refresh_token
    this.tokenHydrated = true // 内存值即真相，避免后续水合覆盖
    await this.saveToken()
  }

  async forgetTokens(): Promise<void> {
    this.accessToken = ''
    this.refreshToken = ''
    this.tokenHydrated = true
    await this.storage.remove(this.storageKey)
  }

  // ── HTTP 基础 ────────────────────────────────────────────────────────
  private countRequest(): void {
    const today = dayOfYear()
    if (today !== this.countDate) {
      this.requestCount = 0
      this.countDate = today
    }
    this.requestCount += 1
  }

  private static ok(resp: JsonDict): boolean {
    return resp.code === 0 || resp.state === true
  }

  private async request(
    method: string,
    url: string,
    opts: {
      params?: Record<string, string | number>
      data?: Record<string, string | number>
      auth?: boolean
      retry?: boolean
    } = {},
  ): Promise<JsonDict> {
    const { params, data, auth = true, retry = true } = opts
    const headers: Record<string, string> = {}
    if (auth) {
      await this.ensureTokenHydrated()
      // 启动时只有 refresh_token 也能先换 access_token
      if (!this.accessToken && this.refreshToken) await this.refreshAccessToken()
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    }
    this.countRequest()
    if (url.includes(BASE_API) && this.requestCount > this.dailyLimit) {
      throw new Error(
        `115 日请求已达安全阈值(${this.dailyLimit})，为避风控暂停 API 调用，0 点自动恢复`,
      )
    }
    await this.rate.acquire()

    const qs = params
      ? '?' + new URLSearchParams(toStrMap(params)).toString()
      : ''
    const resp = await this.fetchFn(url + qs, {
      method,
      headers,
      body: data ? new URLSearchParams(toStrMap(data)) : undefined,
    })
    const text = await resp.text()
    let json: JsonDict
    try {
      json = JSON.parse(text)
    } catch {
      json = { state: false, code: resp.status, message: text.slice(0, 200) }
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      json = { state: false, code: resp.status, message: String(json).slice(0, 200) }
    }

    const code = json.code
    if (
      auth &&
      retry &&
      (code === CODE_TOKEN_EXPIRED || code === CODE_TOKEN_INVALID)
    ) {
      // 三段式恢复（对照 tg115bot；扩展多上下文版：SW / options / worker 都持有 client）：
      // ① storage 里有其他上下文刚刷新的新 token → 重读直接复用（省一次刷新，也避免
      //    refresh_token 已被轮换导致的无谓失败）
      // ② 自己刷新
      // ③ 刷新失败再看一眼 storage；仍无 → 明确要求重新扫码
      const prevAccess = this.accessToken
      const prevRefresh = this.refreshToken
      await this.loadToken()
      if (this.accessToken && this.accessToken !== prevAccess) {
        return this.request(method, url, { ...opts, retry: false })
      }
      if (await this.refreshAccessToken()) {
        return this.request(method, url, { ...opts, retry: false })
      }
      await this.loadToken()
      if (this.accessToken && this.accessToken !== prevAccess) {
        return this.request(method, url, { ...opts, retry: false })
      }
      throw new AuthRequiredError(
        `115 令牌失效(code=${code})且刷新失败，请重新扫码授权`,
      )
    }
    if (auth && CODE_NEED_REAUTH.includes(code)) {
      throw new AuthRequiredError(`115 令牌失效(code=${code})，请重新扫码授权`)
    }
    return json
  }

  // ── token 刷新 ───────────────────────────────────────────────────────
  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false
    await this.rate.acquire()
    let resp: JsonDict = {}
    try {
      const r = await this.fetchFn(`${BASE_PASSPORT}/open/refreshToken`, {
        method: 'POST',
        // 浏览器 fetch 传 URLSearchParams 自动带 form content-type 与原生 UA
        body: new URLSearchParams({ refresh_token: this.refreshToken }),
      })
      resp = (await r.json()) as JsonDict
    } catch {
      resp = {}
    }
    const data = (resp?.data ?? {}) as JsonDict
    if (resp?.state && data.access_token) {
      this.accessToken = String(data.access_token)
      this.refreshToken = String(data.refresh_token ?? this.refreshToken)
      await this.saveToken()
      return true
    }
    return false
  }

  // ── 扫码授权（PKCE） ─────────────────────────────────────────────────
  async startQrAuth(): Promise<QrAuthStart> {
    const { verifier, challenge } = await makePkcePair()
    const resp = await this.request('POST', `${BASE_PASSPORT}/open/authDeviceCode`, {
      data: {
        client_id: this.appId,
        code_challenge: challenge,
        code_challenge_method: 'sha256',
      },
      auth: false,
    })
    const data = (resp.data ?? {}) as JsonDict
    if (!(Open115Client.ok(resp) && data.uid != null)) {
      throw new Error(`获取扫码二维码失败: ${JSON.stringify(resp).slice(0, 200)}`)
    }
    return {
      uid: data.uid,
      time: data.time,
      sign: data.sign,
      qrcode: data.qrcode,
      verifier,
    }
  }

  /** 轮询扫码状态：0=待扫 1=已扫待确认 2=已确认 -1=过期 -2=取消；异常返回 null（继续轮询，不当失效） */
  async pollQrStatus(
    uid: string | number,
    t: string | number,
    sign: string,
  ): Promise<number | null> {
    let resp: JsonDict | null = null
    try {
      await this.rate.acquire()
      const qs = new URLSearchParams({ uid: String(uid), time: String(t), sign })
      const r = await this.fetchFn(`${QR_STATUS_URL}?${qs}`)
      resp = (await r.json()) as JsonDict
    } catch {
      return null // 网络抖动不算失效
    }
    const data = resp && typeof resp === 'object' ? resp.data : null
    if (typeof data !== 'object' || data === null) return null
    return (data as JsonDict).status
  }

  /** 扫码确认后换取 token 并持久化 */
  async exchangeQrToken(uid: string | number, verifier: string): Promise<void> {
    const resp = await this.request(
      'POST',
      `${BASE_PASSPORT}/open/deviceCodeToToken`,
      { data: { uid, code_verifier: verifier }, auth: false },
    )
    const data = (resp.data ?? {}) as JsonDict
    if (!data.access_token) {
      throw new Error(`换取 token 失败: ${JSON.stringify(resp).slice(0, 200)}`)
    }
    await this.importTokens({
      access_token: String(data.access_token),
      refresh_token: String(data.refresh_token ?? ''),
    })
  }

  // ── 文件系统 ─────────────────────────────────────────────────────────
  async getFileInfo(path: string, useCache = true): Promise<JsonDict | null> {
    const p = '/' + (path || '').replace(/^\/+|\/+$/g, '')
    if (p === '/') return { file_id: 0, file_name: '/', file_category: '0' }
    if (useCache && this.pathCache.has(p)) return this.pathCache.get(p)!
    const resp = await this.request('GET', `${BASE_API}/open/folder/get_info`, {
      params: { path: p },
    })
    if (!Open115Client.ok(resp)) return null
    const info = resp.data
    if (typeof info !== 'object' || info === null || Array.isArray(info) || !Object.keys(info).length) {
      return null
    }
    this.pathCache.set(p, info)
    return info
  }

  invalidatePathCache(path = ''): void {
    if (path) {
      const prefix = path.replace(/\/+$/, '') + '/'
      for (const k of [...this.pathCache.keys()]) {
        if (k === path || k.startsWith(prefix)) this.pathCache.delete(k)
      }
    } else {
      this.pathCache.clear()
    }
  }

  /**
   * 在 pid 下建目录；已存在(20004)视为成功；失败抛出含完整 API 响应的错误。
   * ⚠️ pid 必须以字符串透传：115 新体系 file_id 超过 JS Number 安全整数，
   * 数字化会精度丢失 → 服务端收到错误的 id 报 20009「父目录不存在」。
   */
  async createDir(pid: string | number, name: string): Promise<true> {
    const resp = await this.request('POST', `${BASE_API}/open/folder/add`, {
      data: { pid, file_name: name },
    })
    if (Open115Client.ok(resp) || resp.code === CODE_DIR_EXISTS) return true
    throw new Error(
      `folder/add 响应异常: ${JSON.stringify(resp).slice(0, 300)}`,
    )
  }

  /** 递归创建目录，返回目标 cid（字符串透传，防大整数精度丢失） */
  async createDirRecursive(path: string): Promise<string> {
    const p = '/' + (path || '').replace(/^\/+|\/+$/g, '')
    if (p === '/') return '0'
    this.invalidatePathCache(p)
    const info = await this.getFileInfo(p, false)
    if (info && info.file_id != null) return String(info.file_id)

    const parts = p.split('/').filter(Boolean)
    let pid: string = '0'
    let cur = ''
    for (const name of parts) {
      cur += '/' + name
      const exists = await this.getFileInfo(cur, false)
      if (exists && exists.file_id != null) {
        pid = String(exists.file_id)
        continue
      }
      try {
        await this.createDir(pid, name)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        throw new Error(`创建目录失败: ${cur} —— ${reason}`)
      }
      const info2 = await this.getFileInfoRetry(cur)
      pid = String(info2.file_id)
    }
    return pid
  }

  private async getFileInfoRetry(path: string, tries = 3, delayMs = 500): Promise<JsonDict> {
    for (let i = 0; i < tries; i++) {
      const info = await this.getFileInfo(path, false)
      if (info && info.file_id != null) return info
      await new Promise((r) => setTimeout(r, delayMs))
    }
    throw new Error(`建目录后取不到 cid: ${path}`)
  }

  /** 列目录（直接子项）。⚠️ show_dir=1 必带：实测缺省时列表混入子目录文件。 */
  async listFiles(cid: string | number, limit = 32, offset = 0): Promise<{ list: JsonDict[]; count?: number }> {
    const resp = await this.request('GET', `${BASE_API}/open/ufile/files`, {
      params: { cid, limit, offset, show_dir: 1 },
    })
    if (!Open115Client.ok(resp)) return { list: [] }
    const data = resp.data
    if (Array.isArray(data)) return { list: data }
    if (typeof data === 'object' && data !== null && Array.isArray(data.list)) {
      return { list: data.list, count: Number(data.count ?? 0) }
    }
    return { list: [] }
  }

  // ── 上传 ─────────────────────────────────────────────────────────────
  /**
   * 秒传探测 / 取 OSS 参数。⚠️ 开放平台无 128KB preid，fileid = 整文件 SHA1 大写。
   * 返回 data：status==2 秒传命中；否则含 bucket/object/callback/pick_code；
   * 含 sign_key+sign_check 时需对区间算 SHA1（大写）后带 sign_key/sign_val 重调。
   */
  async uploadInit(
    fileName: string,
    fileSize: number,
    sha1: string,
    cid: string | number,
    signKey = '',
    signVal = '',
  ): Promise<UploadInitData> {
    const data: Record<string, string | number> = {
      file_name: fileName,
      file_size: fileSize,
      target: `U_1_${cid}`,
      fileid: sha1,
    }
    if (signKey && signVal) {
      data.sign_key = signKey
      data.sign_val = signVal
    }
    const resp = await this.request('POST', `${BASE_API}/open/upload/init`, { data })
    if (!Open115Client.ok(resp)) {
      throw new Error(`upload/init 失败: ${JSON.stringify(resp).slice(0, 200)}`)
    }
    return (resp.data ?? {}) as UploadInitData
  }

  /** 取 OSS STS 临时凭证。⚠️ 每次返回全新 STS 且与 OSS multipart 会话绑定（见 ossUpload.ts） */
  async getUploadToken(): Promise<OssToken & { endpoint?: string }> {
    const resp = await this.request('GET', `${BASE_API}/open/upload/get_token`)
    if (!Open115Client.ok(resp)) {
      throw new Error(`upload/get_token 失败: ${JSON.stringify(resp).slice(0, 200)}`)
    }
    const data = (resp.data ?? {}) as JsonDict
    for (const k of ['AccessKeyId', 'AccessKeySecret', 'SecurityToken']) {
      if (!data[k]) throw new Error(`STS 凭证缺字段 ${k}`)
    }
    return data as OssToken & { endpoint?: string }
  }

  // ── 离线下载 ─────────────────────────────────────────────────────────
  /** 添加离线任务。⚠️ urls 字段是单个 URL 字符串（尽管名字是复数）。 */
  async offlineAdd(url: string, savePath: string): Promise<void> {
    const wpPathId = await this.createDirRecursive(savePath)
    const resp = await this.request('POST', `${BASE_API}/open/offline/add_task_urls`, {
      data: { urls: url, wp_path_id: wpPathId },
    })
    if (!Open115Client.ok(resp)) {
      throw new Error(`添加离线任务失败: ${JSON.stringify(resp).slice(0, 200)}`)
    }
  }

  async offlineList(page = 1): Promise<{ tasks: OfflineTask[]; page_count?: number }> {
    const resp = await this.request('GET', `${BASE_API}/open/offline/get_task_list`, {
      params: { page },
    })
    if (!Open115Client.ok(resp)) return { tasks: [] }
    const data = resp.data
    if (typeof data === 'object' && data !== null) {
      return { tasks: (data.tasks ?? []) as OfflineTask[], page_count: data.page_count }
    }
    return { tasks: [] }
  }

  /** 删除离线任务记录。delSourceFile: 1=连已下载文件一起删 0=仅清记录 */
  async offlineDel(infoHash: string, delSourceFile = 0): Promise<boolean> {
    const resp = await this.request('POST', `${BASE_API}/open/offline/del_task`, {
      data: { info_hash: infoHash, del_source_file: delSourceFile },
    })
    return Open115Client.ok(resp)
  }

  /** 离线配额：{ used, count } */
  async offlineQuota(): Promise<JsonDict> {
    const resp = await this.request('GET', `${BASE_API}/open/offline/get_quota_info`)
    if (!Open115Client.ok(resp)) return {}
    return (resp.data ?? {}) as JsonDict
  }

  // ── 探活 ─────────────────────────────────────────────────────────────
  /** 空间用量：{ used, total }。轻量请求，兼作探活（能暴露 token 失效）。 */
  async userSpace(): Promise<{ used: number; total: number }> {
    const resp = await this.request('GET', `${BASE_API}/open/user/info`)
    if (!Open115Client.ok(resp)) return { used: 0, total: 0 }
    const data = (resp.data ?? {}) as JsonDict
    // 字段名多版本差异：老形态 used_size/size_total；新形态 rt_space_info.{all_use,all_total}.size
    const rt = (data.rt_space_info ?? {}) as JsonDict
    const allUse = (rt.all_use ?? {}) as JsonDict
    const allTotal = (rt.all_total ?? {}) as JsonDict
    return {
      used: Number(data.used_size ?? data.space_used ?? allUse.size ?? 0),
      total: Number(data.size_total ?? data.space_total ?? allTotal.size ?? 0),
    }
  }

  async checkLogin(): Promise<boolean> {
    try {
      const { used, total } = await this.userSpace()
      return used > 0 || total > 0
    } catch {
      return false
    }
  }
}

// ── 模块级纯函数 ────────────────────────────────────────────────────────

/** 完成判定（对照 check_offline_download_success）：status==2 或 percentDone==100 */
export function offlineDone(task: OfflineTask): boolean {
  return task.status === 2 || task.percentDone === 100
}

export function offlineFailed(task: OfflineTask): boolean {
  return task.status === -1
}

function toStrMap(m: Record<string, string | number>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) out[k] = String(v)
  return out
}

function dayOfYear(): number {
  const now = new Date()
  const start = new Date(now.getFullYear(), 0, 0)
  return Math.floor((now.getTime() - start.getTime()) / 86400000)
}
