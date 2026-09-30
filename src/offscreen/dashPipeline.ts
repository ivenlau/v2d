/**
 * DASH 双轨合并管线（M5，方案 §5.2）：视频轨 + 可选音频轨 → 单 MP4。
 * 用 mediabunny 做无损 remux（packet 级拷贝，不解码不转码）。
 *
 * 内存模型：双轨文件整体驻留（B站 1080P 短中视频量级可接受），>600MB 显式拒绝；
 * 后续迭代可换 StreamTarget + 流式 demux 进一步压缩峰值。
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'
import { createSHA1 } from 'hash-wasm'
import type { OpfsStage } from '@/providers/115/staging'

export interface DashPipelineOptions {
  stage: OpfsStage
  emit: (patch: Record<string, unknown>) => void
  signal: AbortSignal
  wantHash: boolean
  videoUrl: string
  audioUrl?: string
  /** 音轨允许缺失（Reddit 等场景）：音频拉取失败降级纯视频合成，不视为任务失败 */
  audioOptional?: boolean
}

export interface DashStageResult {
  sha1: string
  size: number
  ext: 'mp4'
}

const MAX_DASH_BYTES = 600 * 1024 * 1024

async function fetchBlob(
  url: string,
  signal: AbortSignal,
  onProgress: (received: number, total?: number) => void,
): Promise<Blob> {
  const resp = await fetch(url, { signal })
  if (!resp.ok) {
    const hint = resp.status === 403 ? '（Referer/防盗链被拒）' : ''
    throw new Error(`HTTP ${resp.status}${hint}`)
  }
  // 防盗链失效的 CDN 有时返回 200 + 文本/JSON 错误体——不能当视频喂给 demuxer
  const mime = resp.headers.get('content-type') ?? ''
  if (/^text\//i.test(mime) || /application\/(json|xml)/i.test(mime)) {
    throw new Error('CDN 返回了文本错误响应（防盗链可能失效），已中止合成')
  }
  if (!resp.body) throw new Error('响应无内容')
  const total = Number(resp.headers.get('content-length')) || undefined
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let lastEmit = 0
  let windowBytes = 0
  let windowStart = Date.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    windowBytes += value.length
    const now = Date.now()
    if (now - lastEmit >= 500) {
      const elapsed = (now - windowStart) / 1000
      onProgress(received, total)
      if (elapsed > 2) {
        windowBytes = 0
        windowStart = now
      }
      lastEmit = now
    }
  }
  return new Blob(chunks as BlobPart[])
}

/** 双轨无损合并为一个 mp4（mediabunny packet 拷贝） */
async function mergeDashToBlob(
  video: Blob,
  audio: Blob | undefined,
  signal: AbortSignal,
  audioOptional: boolean,
  emit: (patch: Record<string, unknown>) => void,
): Promise<Blob> {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })

  const vInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) })
  const vTrack = await vInput.getPrimaryVideoTrack()
  if (!vTrack) throw new Error('DASH 视频轨解析失败')
  const vCodec = await vTrack.getCodec()
  if (!vCodec) throw new Error('未知视频编码')
  const vSource = new EncodedVideoPacketSource(vCodec)
  output.addVideoTrack(vSource)
  const vSink = new EncodedPacketSink(vTrack)

  let aSource: EncodedAudioPacketSource | null = null
  let aSink: EncodedPacketSink | null = null
  let aTrack: import('mediabunny').InputAudioTrack | null = null
  if (audio) {
    const aInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(audio) })
    aTrack = await aInput.getPrimaryAudioTrack()
    const aCodec = aTrack ? await aTrack.getCodec() : null
    if (!aTrack || !aCodec) {
      // 音轨拉到了但解析不出（编码不受支持/数据异常）——明确失败，绝不产出无声视频
      console.error('[V2D dash] 音轨解析失败: track=', !!aTrack, 'codec=', aCodec)
      if (audioOptional) {
        console.warn('[V2D dash] 音轨允许缺失 → 降级为无声视频')
      } else {
        throw new Error(`音轨解析失败（音频编码 ${aCodec ?? '未知'} 不受支持），已取消合成`)
      }
    } else {
      aSource = new EncodedAudioPacketSource(aCodec)
      output.addAudioTrack(aSource)
      aSink = new EncodedPacketSink(aTrack)
    }
  }

  await output.start()

  // 长视频合成可达数十秒：定期心跳保持 SW 存活、UI 状态不停滞
  const vMeta = { decoderConfig: (await vTrack.getDecoderConfig()) ?? undefined }
  let lastMuxEmit = Date.now()
  for await (const packet of vSink.packets()) {
    if (signal.aborted) throw new Error('cancelled')
    await vSource.add(packet, vMeta)
    const now = Date.now()
    if (now - lastMuxEmit >= 1000) {
      lastMuxEmit = now
      emit({ state: 'transmuxing' })
    }
  }

  if (aSource && aSink && aTrack) {
    const aMeta = { decoderConfig: (await aTrack.getDecoderConfig()) ?? undefined }
    for await (const packet of aSink.packets()) {
      if (signal.aborted) throw new Error('cancelled')
      await aSource.add(packet, aMeta)
    }
  }

  await output.finalize()
  const buffer = output.target.buffer
  if (!buffer) throw new Error('DASH 合并输出为空')
  return new Blob([buffer], { type: 'video/mp4' })
}

export async function runDashToStage(opts: DashPipelineOptions): Promise<DashStageResult> {
  const { stage, emit, signal, wantHash, videoUrl, audioUrl, audioOptional } = opts

  emit({ state: 'downloading', segmentsTotal: audioUrl ? 2 : 1, segmentsDone: 0 })
  const video = await fetchBlob(videoUrl, signal, () => {})
  emit({
    state: 'downloading',
    segmentsDone: 1,
    segmentsTotal: audioUrl ? 2 : 1,
    received: video.size,
    size: video.size,
  })

  let audio: Blob | undefined
  if (audioUrl) {
    try {
      audio = await fetchBlob(audioUrl, signal, () => {})
      emit({
        state: 'downloading',
        segmentsDone: 2,
        segmentsTotal: 2,
        received: video.size + audio.size,
        size: video.size + audio.size,
      })
    } catch (e) {
      if (audioOptional && !signal.aborted) {
        audio = undefined
        emit({ state: 'downloading', note: '音频轨不可用，仅合成视频' })
      } else {
        throw e
      }
    }
  }

  const total = video.size + (audio?.size ?? 0)
  if (total > MAX_DASH_BYTES) {
    throw new Error(
      `DASH 双轨合并暂不支持超过 500MB 的视频（当前 ${Math.round(total / 1024 / 1024)}MB）`,
    )
  }

  emit({ state: 'transmuxing' })
  const merged = await mergeDashToBlob(video, audio, signal, !!audioOptional, emit)

  const hasher = await createSHA1()
  hasher.init()
  const reader = merged.stream().getReader()
  let written = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    stage.write(value)
    if (wantHash) hasher.update(value)
    written += value.length
  }

  return { sha1: hasher.digest('hex'), size: written, ext: 'mp4' as const }
}
