/**
 * TS → fMP4 流式转封装（方案 §5.1）：单实例 mux.js Transmuxer 逐段 push/flush，
 * init 段只在首次输出（重复 moov 会破坏拼接出的 fMP4）。
 */

import muxjs from 'mux.js'
import type { TransmuxSegment } from 'mux.js'

export class TsRemuxer {
  private muxer = new muxjs.Transmuxer({ keepOriginalTimestamps: true })
  private initSent = false
  private pending: {
    resolve: (out: Uint8Array[]) => void
    reject: (e: unknown) => void
  } | null = null

  constructor() {
    this.muxer.on('data', (segment: TransmuxSegment) => {
      const out: Uint8Array[] = []
      if (!this.initSent && segment.initSegment?.length) {
        out.push(segment.initSegment)
        this.initSent = true
      }
      if (segment.data?.length) out.push(segment.data)
      this.pending?.resolve(out)
      this.pending = null
    })
    this.muxer.on('done', () => {
      // 无可转封装数据（如该段不含受支持的轨）：产出空
      this.pending?.resolve([])
      this.pending = null
    })
  }

  /** 转封装一个 TS 段，产出应顺序写入的 fMP4 块列表 */
  remux(ts: Uint8Array): Promise<Uint8Array[]> {
    return new Promise((resolve, reject) => {
      if (this.pending) {
        reject(new Error('remuxer busy'))
        return
      }
      this.pending = { resolve, reject }
      try {
        this.muxer.push(ts)
        this.muxer.flush()
      } catch (e) {
        this.pending = null
        reject(e)
      }
    })
  }
}
