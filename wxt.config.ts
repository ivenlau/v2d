import { defineConfig } from 'wxt'

// 权限策略见 docs/方案设计.md §10：
//   - <all_urls>：视频嗅探 + 后台拉流（视频下载类必要权限）
//   - 115/OSS 相关走 optional_host_permissions，随 §9.5「115 转存」开关动态申请
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'V2D - 视频嗅探转存',
    description: '嗅探页面视频，一键下载到本地，或转存到 115 网盘',
    permissions: [
      'storage',
      'unlimitedStorage',
      'downloads',
      'scripting',
      'activeTab',
      'webRequest',
      'offscreen',
    ],
    host_permissions: ['<all_urls>'],
    optional_host_permissions: ['*://*.115.com/*', '*://*.aliyuncs.com/*'],
    // hash-wasm（SHA1 流式计算）依赖 WASM：MV3 默认 CSP 禁止 wasm-eval，
    // 会导致传输 Worker 静默崩溃（任务永远卡在「下载中」）。
    // 'wasm-unsafe-eval' 是 Chrome 官方允许的最小化放行（不影响页面脚本策略）。
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    action: {
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
      },
    },
  },
})
