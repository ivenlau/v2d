/**
 * 「待保存」任务的本地保存（popup / manager 共用）：
 * <a download> 触发浏览器下载后立即返回——删暂存、标终态一律由 SW 依
 * downloads.onChanged 收口（watchPageSave：完成→标 done+删暂存；失败→回待保存可重试）。
 * 页面绝不能在点击后就删 OPFS 暂存：Chrome 还在读 blob 背后的文件时删源，
 * 下载会以 NETWORK_FAILED（下载界面的「网络错误」）告终。
 */
export async function saveStagedProduct(taskId: string, fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('staging')
  const fh = await dir.getFileHandle(`${taskId}.part`)
  const file = await fh.getFile()
  if (file.size === 0) throw new Error('暂存文件为空')
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 下载已持有 blob 引用，URL 撤销不影响进行中的下载
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  // 观测不到下载终态的环境（Safari 无 downloads API）：退回旧语义（延迟后直接标完成）
  if (typeof chrome.downloads?.onChanged !== 'function') {
    await new Promise((r) => setTimeout(r, 800))
    await chrome.runtime.sendMessage({ type: 'v2d/task-saved', taskId })
    return
  }
  await chrome.runtime.sendMessage({ type: 'v2d/task-saving', taskId, blobUrl: url })
}
