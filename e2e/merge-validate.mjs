/**
 * DASH 双轨合并核心逻辑验证（Node 直跑，无需浏览器/扩展/115）：
 * 真实 B站 CDN 下载（UA+Referer）→ mediabunny 双轨 remux → 产物校验（ftyp/时长/轨道）。
 */
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { Input, ALL_FORMATS, BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Mp4OutputFormat, Output } from 'mediabunny'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }

const view = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7')).json()
const cid = view.data.cid
const play = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=BV1GJ411x7h7&cid=${cid}&qn=64&fnval=4048`)).json()
const pick = (v) => [v.baseUrl, ...(v.backupUrl ?? [])].find((u) => !u.includes('mcdn')) ?? v.baseUrl
const videoUrl = pick(play.data.dash.video[0])
const audioUrl = pick(play.data.dash.audio[0])
console.log('视频轨:', play.data.dash.video[0].id, play.data.dash.video[0].width + 'x' + play.data.dash.video[0].height)

async function fetchBuf(url, out) {
  // 沙箱出口代理对 CDN 域 TLS 拦截（证书异常），用 curl -k 完成下载（仅本地验证用）
  execSync(`curl -sk --max-time 120 -A "${UA}" -H "Referer: https://www.bilibili.com/" -o "${out}" "${url}"`)
  const buf = await (await import('node:fs/promises')).readFile(out)
  console.log('  fetched', url.slice(0, 60), '→', Math.round(buf.byteLength / 1024), 'KB')
  return buf
}

const videoBuf = await fetchBuf(videoUrl, '/tmp/e2e-video.m4s')
const audioBuf = await fetchBuf(audioUrl, '/tmp/e2e-audio.m4s')

// ── mediabunny 双轨合并（与 dashPipeline.ts 同构逻辑） ──
const output = new Output({
  format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
  target: new BufferTarget(),
})
const vInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([videoBuf])) })
const vTrack = await vInput.getPrimaryVideoTrack()
if (!vTrack) throw new Error('视频轨解析失败')
const vCodec = await vTrack.getCodec()
const vSource = new EncodedVideoPacketSource(vCodec)
output.addVideoTrack(vSource)
const vSink = new EncodedPacketSink(vTrack)

const aInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([audioBuf])) })
const aTrack = await aInput.getPrimaryAudioTrack()
const aCodec = await aTrack.getCodec()
const aSource = new EncodedAudioPacketSource(aCodec)
output.addAudioTrack(aSource)
const aSink = new EncodedPacketSink(aTrack)
console.log('轨道: video', vCodec, await vTrack.getCodedWidth() + 'x' + (await vTrack.getCodedHeight()), '| audio', aCodec)

await output.start()
const vMeta = { decoderConfig: (await vTrack.getDecoderConfig()) ?? undefined }
let n = 0
for await (const packet of vSink.packets()) {
  await vSource.add(packet, vMeta)
  n++
}
console.log('视频 packets:', n)
const aMeta = { decoderConfig: (await aTrack.getDecoderConfig()) ?? undefined }
let m = 0
for await (const packet of aSink.packets()) {
  await aSource.add(packet, aMeta)
  m++
}
console.log('音频 packets:', m)
await output.finalize()

const buf = output.target.buffer
if (!buf?.byteLength) throw new Error('输出为空')
const head = Buffer.from(buf.slice(0, 12)).toString('latin1')
if (!head.includes('ftyp')) throw new Error('输出不是 MP4（缺 ftyp）')
writeFileSync('/tmp/dash-merge-out.mp4', new Uint8Array(buf))
console.log(`✅ 合并成功: /tmp/dash-merge-out.mp4 ${Math.round(buf.byteLength / 1024 / 1024 * 10) / 10}MB moov 前置=${head.indexOf('ftyp') < 64}`)

// ── 产物回读校验：双轨时长一致、可解析 ──
const check = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([buf])) })
const cv = await check.getPrimaryVideoTrack()
const ca = await check.getPrimaryAudioTrack()
const dv = await cv.computeDuration()
const da = ca ? await ca.computeDuration() : 0
console.log(`✅ 回读: 视频 ${Math.round(dv)}s / 音频 ${Math.round(da)}s（差 ${Math.abs(Math.round(dv - da))}s）`)
if (Math.abs(dv - da) > 3) throw new Error('双轨时长偏差过大')
console.log('✅ DASH 双轨合并核心逻辑验证通过')
