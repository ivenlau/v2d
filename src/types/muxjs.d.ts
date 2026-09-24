/** mux.js 无官方类型，按本插件用到的最小 API 面声明 */

declare module 'mux.js' {
  export interface TransmuxSegment {
    /** ftyp+moov（首个 flush 产出） */
    initSegment?: Uint8Array
    /** moof+mdat 分片数据 */
    data?: Uint8Array
    type?: string
    duration?: number
  }

  export interface Transmuxer {
    on(event: 'data', cb: (segment: TransmuxSegment) => void): void
    on(event: 'done', cb: () => void): void
    on(event: string, cb: (arg?: unknown) => void): void
    push(data: Uint8Array): void
    flush(): void
    reset(): void
  }

  export interface TransmuxerCtor {
    new (options?: { keepOriginalTimestamps?: boolean }): Transmuxer
  }

  const muxjs: {
    Transmuxer: TransmuxerCtor
  }
  export default muxjs
}
