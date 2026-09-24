/** 跨端共享类型（core 层平台无关，桌面/iOS 复用） */

import type { CompletedPart } from '../providers/115/ossSign'

export type MediaKind = 'hls' | 'dash' | 'file' | 'blob'
export type MediaOrigin = 'network' | 'dom' | 'mse'

export interface HlsVariant {
  url: string
  bandwidth?: number
  resolution?: string
  name?: string
}

/** 嗅探到的媒体候选（§4.4 候选治理） */
export interface MediaCandidate {
  /** 稳定指纹：kind + url hash（去重键） */
  id: string
  tabId: number
  url: string
  kind: MediaKind
  origin: MediaOrigin
  mime?: string
  /** 字节数（file 类，来自响应头或 Range 探测） */
  size?: number
  /** hls media playlist 解析结果（探测后填充） */
  segments?: number
  durationSec?: number
  live?: boolean
  encrypted?: boolean
  /** master playlist 的清晰度列表（hls/dash 展开缓存） */
  variants?: HlsVariant[]
  /** dash：与清晰度配套的音频轨地址（站点适配器填充） */
  dashAudioUrl?: string
  /** dash：音轨允许缺失（探测存在才挂载；失败降级纯视频合成） */
  dashAudioOptional?: boolean
  fileName?: string
  pageTitle?: string
  /** 已探测（大小/Playlist 信息已知） */
  probed?: boolean
  /** 探测失败（如防盗链 403）——UI 置灰并提示 */
  probeError?: string
  discoveredAt: number
}

/** 115 转存配置（§9.5：默认关闭，开关 + 认证通过后才启用） */
export interface V115Settings {
  enabled: boolean
  /** 上传目标根目录（绝对路径）；空 = 默认规则 /来自浏览器/{host}/{YYYY-MM}/ */
  targetRoot?: string
  /** 用户自定义开放平台 app_id（空 = 公共测试 AppID） */
  appId?: number
}

/** DASH 双轨描述符（Reddit 等音轨缺失场景用 audioOptional 降级为纯视频合成） */
export interface DashSpec {
  video: string
  audio?: string
  audioOptional?: boolean
}

export interface Settings {
  /** 角标数字（可关，避免打扰） */
  badge: boolean
  /** 嗅探静音域名黑名单（hostname 精确或后缀匹配） */
  blacklist: string[]
  /** C 引擎 MSE 深捕获白名单（M3 生效，先占位） */
  mseHookSites: string[]
  v115: V115Settings
}

export const DEFAULT_SETTINGS: Settings = {
  badge: true,
  blacklist: [],
  mseHookSites: [],
  v115: { enabled: false },
}

export type { CompletedPart }
