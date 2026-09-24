/**
 * OPFS 暂存（§6.1/§6.2）：大文件转存的磁盘级缓冲。
 * 必须在 Worker 内使用（createSyncAccessHandle 仅 Worker 可用）。
 * 内存保证：写入按 chunk 流式进行，读取按分片 seek 读——常驻内存与文件大小无关。
 */

import type { ByteSource } from './ossUpload'

// lib.dom 的 File System Access 类型未覆盖 Worker 专属同步句柄，手动补齐
declare global {
  interface FileSystemSyncAccessHandle {
    read(buffer: Uint8Array, options?: { at?: number }): number
    write(buffer: Uint8Array, options?: { at?: number }): number
    flush(): void
    close(): void
    truncate(size: number): void
    getSize(): number
  }
  interface FileSystemFileHandle {
    createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
  }
}

const STAGING_DIR = 'staging'

export class OpfsStage {
  private handle: FileSystemSyncAccessHandle | null = null
  private fileName = ''
  private dir: FileSystemDirectoryHandle | null = null
  private written = 0

  /** 打开（或复用已有）暂存文件；written 从文件实际大小起（断点续传基础） */
  static async open(taskId: string): Promise<OpfsStage> {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true })
    const fileName = `${taskId}.part`
    const fileHandle = await dir.getFileHandle(fileName, { create: true })
    const stage = new OpfsStage()
    stage.dir = dir
    stage.fileName = fileName
    stage.handle = await fileHandle.createSyncAccessHandle()
    stage.written = stage.handle.getSize()
    return stage
  }

  /** 丢弃已有内容从头开始（断点不可信时） */
  reset(): void {
    if (!this.handle) throw new Error('OpfsStage 未打开')
    this.handle.truncate(0)
    this.written = 0
  }

  /** 顺序写一个 chunk */
  write(chunk: Uint8Array): void {
    if (!this.handle) throw new Error('OpfsStage 未打开')
    this.handle.write(chunk, { at: this.written })
    this.written += chunk.length
  }

  get size(): number {
    return this.written
  }

  /** 上传期只读视图（分片 seek 读，内存有界） */
  byteSource(): ByteSource {
    const handle = this.handle
    if (!handle) throw new Error('OpfsStage 未打开')
    const size = this.written
    return {
      size,
      async read(offset, length) {
        const buf = new Uint8Array(length)
        const n = handle.read(buf, { at: offset })
        if (n < length) return buf.subarray(0, Math.max(0, n))
        return buf
      },
    }
  }

  /** 关闭句柄并删除暂存文件（任何一步失败都不抛——清理尽力而为） */
  async dispose(): Promise<void> {
    try {
      this.handle?.close()
    } catch {
      /* ignore */
    }
    this.handle = null
    try {
      await this.dir?.removeEntry(this.fileName)
    } catch {
      /* ignore */
    }
  }

  /** 只关句柄、保留文件（本地保存路径：文件还要经 blob URL 交给 downloads） */
  async close(): Promise<void> {
    try {
      this.handle?.close()
    } catch {
      /* ignore */
    }
    this.handle = null
  }
}

/** 清理全部残留暂存（SW 启动时调用；worker 崩溃可能留下孤儿文件） */
export async function purgeStaging(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(STAGING_DIR, { recursive: true })
  } catch {
    /* 目录不存在等情况忽略 */
  }
}
