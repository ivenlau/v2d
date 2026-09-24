/** 失败原因人话化（§9.2：失败原因可视化） */

export function humanizeError(err?: string): string {
  if (!err) return ''
  // STS 会话丢失：大文件 × 慢上行的协议级硬约束（§7.4-1）
  if (err.includes('OSS 分片会话')) {
    return '文件太大而上行带宽不足：超出 115 单次凭证的有效窗口，已传分片无法续用。建议：在设置中把通道策略改为「仅 115 离线下载」，或换更快的网络后重试。'
  }
  // OSS 错误自带定位信息（签名/凭证/Date），不再叠加源站提示
  if (err.startsWith('OSS')) return err
  if (err.includes('403')) {
    return `${err} —— 源站防盗链拒绝，可先完整播放一遍视频再重试`
  }
  if (err.includes('404') || err.includes('410')) {
    return '链接已失效（404），请刷新页面后重新嗅探'
  }
  if (err.includes('日请求已达安全阈值')) {
    return '已达 115 接口今日调用上限，0 点后自动恢复'
  }
  if (err.includes('40140123') || err.includes('access_token 格式错误')) {
    return '115 令牌无效（格式错误或已失效）：请到设置页「退出 115 登录」后重新扫码授权'
  }
  if (err.includes('911') || err.includes('验证') || err.includes('安全') || err.includes('风控')) {
    return `${err} —— 触发 115 风控：请打开 115 客户端或网页版完成一次安全验证，再回来重试`
  }
  return err
}
