/**
 * TS → MP4 转封装（mediabunny，与 DASH 管线同一套已验证链路）：
 * 按序拼接的 TS 分段视为一个连续流 → demux（avc/hevc + aac）→ packet 级拷贝进 MP4。
 * 不用 mux.js：其对多段 push/flush 的输出时间轴不连续（tfdt 步进紊乱），产物时长错乱。
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

/** 把按序拼接的 TS 分段转封装为单个 MP4。失败抛错，由调用方回退原样拼接 .ts。 */
export async function remuxTsToMp4(chunks: Uint8Array[], signal: AbortSignal): Promise<Uint8Array> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob(chunks as BlobPart[])) })
  const vTrack = await input.getPrimaryVideoTrack()
  if (!vTrack) throw new Error('TS 流中无可转封装的视频轨')
  const vCodec = await vTrack.getCodec()
  if (!vCodec) throw new Error('未知视频编码')
  const aTrack = await input.getPrimaryAudioTrack()

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const vSource = new EncodedVideoPacketSource(vCodec)
  output.addVideoTrack(vSource)
  const vSink = new EncodedPacketSink(vTrack)
  let aSource: EncodedAudioPacketSource | null = null
  let aSink: EncodedPacketSink | null = null
  if (aTrack) {
    const aCodec = await aTrack.getCodec()
    if (aCodec) {
      aSource = new EncodedAudioPacketSource(aCodec)
      output.addAudioTrack(aSource)
      aSink = new EncodedPacketSink(aTrack)
    }
  }

  await output.start()
  const vMeta = { decoderConfig: (await vTrack.getDecoderConfig()) ?? undefined }
  for await (const packet of vSink.packets()) {
    if (signal.aborted) throw new Error('cancelled')
    await vSource.add(packet, vMeta)
  }
  if (aSink && aSource && aTrack) {
    const aMeta = { decoderConfig: (await aTrack.getDecoderConfig()) ?? undefined }
    for await (const packet of aSink.packets()) {
      if (signal.aborted) throw new Error('cancelled')
      await aSource.add(packet, aMeta)
    }
  }
  await output.finalize()
  const buffer = output.target.buffer
  if (!buffer) throw new Error('转封装输出为空')
  return new Uint8Array(buffer)
}

/** 把两个独立封装的轨道文件（MSE 捕获的视频/音频 fMP4 或 WebM）合流为单个 MP4 */
export async function mergeTrackBlobs(video: Blob, audio: Blob, signal: AbortSignal): Promise<Uint8Array> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) })
  const vTrack = await input.getPrimaryVideoTrack()
  if (!vTrack) throw new Error('捕获视频轨解析失败')
  const vCodec = await vTrack.getCodec()
  if (!vCodec) throw new Error('未知视频编码')
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const vSource = new EncodedVideoPacketSource(vCodec)
  output.addVideoTrack(vSource)
  const vSink = new EncodedPacketSink(vTrack)

  const aInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(audio) })
  const aTrack = await aInput.getPrimaryAudioTrack()
  const aCodec = aTrack ? await aTrack.getCodec() : null
  if (!aTrack || !aCodec) throw new Error('捕获音频轨解析失败')
  const aSource = new EncodedAudioPacketSource(aCodec)
  output.addAudioTrack(aSource)
  const aSink = new EncodedPacketSink(aTrack)

  await output.start()
  const vMeta = { decoderConfig: (await vTrack.getDecoderConfig()) ?? undefined }
  for await (const packet of vSink.packets()) {
    if (signal.aborted) throw new Error('cancelled')
    await vSource.add(packet, vMeta)
  }
  const aMeta = { decoderConfig: (await aTrack.getDecoderConfig()) ?? undefined }
  for await (const packet of aSink.packets()) {
    if (signal.aborted) throw new Error('cancelled')
    await aSource.add(packet, aMeta)
  }
  await output.finalize()
  const buffer = output.target.buffer
  if (!buffer) throw new Error('合并输出为空')
  return new Uint8Array(buffer)
}
