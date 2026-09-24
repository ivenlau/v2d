/**
 * HLS 下载管线（方案 §5.1，M3）：
 *   master → 自动选最高码率 → media playlist 详细解析 → 直播/不支持加密拒绝
 *   → 首段试转封装定模式（mp4 / ts 兜底；EXT-X-MAP 走 fMP4 原样拼接）
 *   → 窗口并发(4)下载 → AES-128 解密 → 按序写入 OPFS 暂存 + 增量 SHA1（wantHash 时）
 * 内存模型：单段字节 + 写窗口缓冲，与总时长无关（§6.3）。
 */

import { createSHA1 } from 'hash-wasm'
import { parseM3U8, parseMediaPlaylist, decryptAes128Segment, ivForSegment } from '@/core/m3u8'
import type { HlsEncryption, HlsSegment, MediaPlaylistDetails } from '@/core/m3u8'
import type { OpfsStage } from '@/providers/115/staging'
import { TsRemuxer } from './remux'

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

  // 2. 首段试转封装决定产物格式（mp4 / ts 兜底）；EXT-X-MAP = fMP4 HLS 原样拼接
  const remuxer = new TsRemuxer()
  let mode: 'mp4' | 'ts' = 'mp4'
  if (!media.mapUrl) {
    try {
      const raw = await fetchSegmentBuffer(segments[0], signal)
      const out = await remuxer.remux(raw)
      if (out.length === 0) throw new Error('无可转封装数据')
    } catch {
      mode = 'ts' // mux.js 不支持的编码（H.265 等）→ 原样合并 .ts
    }
  }

  // 3. 窗口并发下载 + 按序写入 + 增量 SHA1
  const hasher = await createSHA1()
  hasher.init()
  if (mode === 'mp4' && media.mapUrl) {
    const init = await fetchBuffer(media.mapUrl, undefined, signal)
    stage.write(init)
    hasher.update(init)
  }

  const buffer = new Map<number, Uint8Array[]>()
  let writeIdx = 0
  let written = 0
  let doneCount = 0
  let lastEmit = 0
  let windowBytes = 0
  let windowStart = Date.now()

  const flushInOrder = (): void => {
    while (buffer.has(writeIdx)) {
      for (const chunk of buffer.get(writeIdx)!) {
        stage.write(chunk)
        if (wantHash) hasher.update(chunk)
        written += chunk.length
      }
      buffer.delete(writeIdx)
      writeIdx += 1
    }
  }

  const processSegment = async (idx: number): Promise<void> => {
    const seg = segments[idx]
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await fetchSegmentBuffer(seg, signal)
        let chunks: Uint8Array[]
        if (mode === 'ts' || media.mapUrl) {
          chunks = [raw]
        } else {
          let data = raw
          if (seg.key) {
            const keyBytes = await getKeyBytes(seg.key, signal)
            data = await decryptAes128Segment(
              data,
              keyBytes,
              ivForSegment(seg.key, media.mediaSequence + idx),
            )
          }
          chunks = await remuxer.remux(data)
        }
        buffer.set(idx, chunks)
        doneCount += 1
        windowBytes += raw.length
        flushInOrder()
        const now = Date.now()
        if (now - lastEmit >= 500) {
          const elapsed = (now - windowStart) / 1000
          emit({
            state: 'downloading',
            segmentsDone: doneCount,
            segmentsTotal: segments.length,
            received: written,
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

  return {
    sha1: hasher.digest('hex'),
    size: stage.size,
    ext: mode === 'mp4' ? 'mp4' : 'ts',
    segmentsTotal: segments.length,
    durationSec: media.totalDuration,
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
