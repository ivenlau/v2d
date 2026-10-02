/**
 * HLS 下载管线（方案 §5.1，M3）：
 *   master → 自动选最高码率 → media playlist 详细解析 → 直播/不支持加密拒绝
 *   → 窗口并发(4)下载 → AES-128 解密 → 整流 mediabunny 转封装 MP4
 *     （H.265 等不支持的编码/超限回退原样拼接 .ts；EXT-X-MAP 的 fMP4 HLS 原样拼接）
 *   → 写入 OPFS 暂存 + SHA1（wantHash 时）
 * 内存模型：整流字节驻留内存（与 DASH 管线一致，§6.3），超限自动走 .ts 回退。
 */

import { createSHA1 } from 'hash-wasm'
import { parseM3U8, parseMediaPlaylist, decryptAes128Segment, ivForSegment } from '@/core/m3u8'
import type { HlsEncryption, HlsSegment, MediaPlaylistDetails } from '@/core/m3u8'
import type { OpfsStage } from '@/providers/115/staging'
import { remuxTsToMp4 } from './remux'

export interface HlsPipelineOptions {
  stage: OpfsStage
  emit: (patch: Record<string, unknown>) => void
  signal: AbortSignal
  /** 是否随写入增量计算 SHA1（云端转存需要；纯本地保存跳过） */
  wantHash: boolean
}

export interface HlsStageResult {
  sha1: string
  size: number
  ext: 'mp4' | 'ts'
  segmentsTotal: number
  durationSec?: number
}

const WINDOW = 4
const SEG_RETRIES = 3
/** 整流驻留内存的上限：超过则跳过转封装直接原样 .ts（与 DASH 管线的 600MB 同一取舍） */
const TS_REMUX_MAX_BYTES = 600 * 1024 * 1024

async function fetchBuffer(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const r = await fetch(url, { headers, signal })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

async function fetchSegmentBuffer(seg: HlsSegment, signal: AbortSignal): Promise<Uint8Array> {
  if (seg.byterange) {
    const end = seg.byterange.offset + seg.byterange.length - 1
    return fetchBuffer(seg.url, { Range: `bytes=${seg.byterange.offset}-${end}` }, signal)
  }
  return fetchBuffer(seg.url, undefined, signal)
}

const keyCache = new Map<string, Uint8Array>()

async function getKeyBytes(key: HlsEncryption, signal?: AbortSignal): Promise<Uint8Array> {
  let bytes = keyCache.get(key.uri)
  if (!bytes) {
    bytes = await fetchBuffer(key.uri, undefined, signal)
    if (bytes.length !== 16) throw new Error(`AES-128 密钥长度异常: ${bytes.length}`)
    keyCache.set(key.uri, bytes)
  }
  return bytes
}

/** master → 自动选最高码率 → media playlist 详细解析（最多 3 层嵌套） */
async function resolveMediaPlaylist(playlistUrl: string, signal: AbortSignal): Promise<MediaPlaylistDetails> {
  for (let hop = 0; hop < 3; hop++) {
    const text = new TextDecoder().decode(await fetchBuffer(playlistUrl, undefined, signal))
    const summary = parseM3U8(text, playlistUrl)
    if (summary.type === 'media') {
      return parseMediaPlaylist(text, playlistUrl)
    }
    const variants = summary.variants ?? []
    if (!variants.length) throw new Error('master playlist 无可用清晰度')
    playlistUrl = variants[0].url // 已按带宽降序
  }
  throw new Error('playlist 嵌套过深')
}

export async function runHlsToStage(playlistUrl: string, opts: HlsPipelineOptions): Promise<HlsStageResult> {
  const { stage, emit, signal, wantHash } = opts

  // 1. 解析 playlist；直播/不支持加密直接拒绝
  const media = await resolveMediaPlaylist(playlistUrl, signal)
  if (media.live) throw new Error('直播流暂不支持下载')
  if (media.unsupportedEncryption) {
    throw new Error('该流使用了不支持的加密（SAMPLE-AES 等，通常伴随 DRM），无法下载')
  }
  const segments = media.segments
  if (!segments.length) throw new Error('播放列表没有分段')

  // 2. 窗口并发(4)下载 + AES-128 解密，按序累积。
  //    TS 转封装需要完整连续的流，这里整流入内存（与 DASH 管线同一内存取舍，超限走 .ts 回退）
  const hasher = await createSHA1()
  hasher.init()
  const buffer = new Map<number, Uint8Array>()
  let doneCount = 0
  let received = 0
  let lastEmit = 0
  let windowBytes = 0
  let windowStart = Date.now()

  const processSegment = async (idx: number): Promise<void> => {
    const seg = segments[idx]
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await fetchSegmentBuffer(seg, signal)
        let data = raw
        if (seg.key) {
          const keyBytes = await getKeyBytes(seg.key, signal)
          data = await decryptAes128Segment(
            data,
            keyBytes,
            ivForSegment(seg.key, media.mediaSequence + idx),
          )
        }
        buffer.set(idx, data)
        doneCount += 1
        received += raw.length
        windowBytes += raw.length
        const now = Date.now()
        if (now - lastEmit >= 500) {
          const elapsed = (now - windowStart) / 1000
          emit({
            state: 'downloading',
            segmentsDone: doneCount,
            segmentsTotal: segments.length,
            received,
            speedBps: elapsed > 0.2 ? windowBytes / elapsed : 0,
          })
          if (elapsed > 2) {
            windowBytes = 0
            windowStart = now
          }
          lastEmit = now
        }
        return
      } catch (e) {
        if (signal.aborted) throw new Error('cancelled')
        if (attempt >= SEG_RETRIES) {
          throw new Error(`分段 ${idx + 1}/${segments.length} 下载失败: ${msg(e)}`)
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }

  let next = 0
  const workers = Array.from({ length: Math.min(WINDOW, segments.length) }, async () => {
    while (next < segments.length && !signal.aborted) {
      const idx = next++
      await processSegment(idx)
    }
  })
  await Promise.all(workers)
  if (signal.aborted) throw new Error('cancelled')

  // 3. 产物组装：fMP4 HLS（EXT-X-MAP）init+分段原样拼接即完整 fMP4；
  //    TS HLS 整流转封装为 MP4（时间轴由 mediabunny 保证连续），不支持/超限回退原样 .ts
  const ordered: Uint8Array[] = []
  if (media.mapUrl) {
    const init = await fetchBuffer(media.mapUrl, undefined, signal)
    ordered.push(init)
  }
  for (let i = 0; i < segments.length; i++) ordered.push(buffer.get(i)!)
  buffer.clear()

  let ext: 'mp4' | 'ts' = media.mapUrl ? 'mp4' : 'ts'
  let finalChunks = ordered
  emit({ state: 'transmuxing' })
  if (!media.mapUrl && received <= TS_REMUX_MAX_BYTES) {
    try {
      finalChunks = [await remuxTsToMp4(ordered, signal)]
      ext = 'mp4'
    } catch (e) {
      if (signal.aborted) throw new Error('cancelled')
      // H.265 等 mediabunny 不支持的编码 → 原样拼接 .ts（历史兜底行为）。
      // 原因必须留痕：回退产物是 .ts 而非承诺的 .mp4，用户需要知道为什么
      const reason = msg(e)
      console.warn('[V2D hls] TS→MP4 转封装失败，回退原样 .ts：', reason)
      emit({ note: `转封装失败（${reason}），已按原始 TS 保存` })
      finalChunks = ordered
      ext = 'ts'
    }
  }

  // 4. 写入暂存 + SHA1（wantHash 时）
  let written = 0
  for (const chunk of finalChunks) {
    stage.write(chunk)
    if (wantHash) hasher.update(chunk)
    written += chunk.length
  }

  return {
    sha1: hasher.digest('hex'),
    size: written,
    ext,
    segmentsTotal: segments.length,
    durationSec: media.totalDuration,
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
