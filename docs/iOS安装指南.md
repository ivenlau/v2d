# iOS 安装指南（无 Mac 自签路线）

> 适用：没有 Mac，用 GitHub Actions 出未签名 IPA + SideStore 自签安装。
> 免费个人 Apple ID 即可；签名 7 天过期，过期后用 SideStore 重新续签（手机上点一下）。

## 一、出包（GitHub Actions）

1. 打开仓库的 **Actions** 标签页 → 左侧选 **iOS Build** → **Run workflow**
2. 等待构建完成（约 3~5 分钟，绿色 ✓）
3. 进入该次运行页面，下载 Artifact **v2d-ios-unsigned**（内含 `V2D-unsigned.ipa`）

## 二、安装到 iPhone（SideStore 自签）

1. App Store 安装 **SideStore**（配套还需安装 **AltStore** 的邮箱插件说明见 SideStore 文档），并用你的 Apple ID 登录
   - iOS 17+ 需要「开发者模式」：设置 → 隐私与安全性 → 开发者模式 → 开启
2. 在 SideStore 中点 **+**，选择下载好的 `V2D-unsigned.ipa`，用 Apple ID 签名安装
3. 首次启动若提示「不受信任的开发者」：设置 → 通用 → VPN 与设备管理 → 信任你的 Apple ID 证书

## 三、启用扩展

1. 打开 V2D App 一次（壳 App，显示提示页即可）
2. 设置 → Safari → 扩展 → **V2D** → 开启「允许这些扩展」，并给予权限
3. 打开任意视频页（如 B站），地址栏的拼图/AA 菜单里确认 V2D 扩展已启用
4. 点扩展图标 → 弹窗内操作（与桌面版一致：候选列表 → 转存 115）

## 四、本地保存（iOS 差异）

- iOS 版 HLS/DASH 合并完成后，任务变为「待保存」
- 到 **传输管理页**（V2D App 内或 Safari 扩展弹窗）点 **⬇ 保存到文件** → 存入「文件」App
- 直链「存本地」在 iOS 版暂不可用（依赖 chrome.downloads），请改用转存 115

## 五、冒烟验证清单（首包必测）

| # | 项目 | 通过标准 |
|---|---|---|
| 1 | 扩展启用后 popup 能打开并显示候选 | B站视频页出现 DASH 候选 |
| 2 | 转存 115 全链路 | 下载→合并→秒传/上传 进度推进，网盘查收 |
| 3 | OPFS 暂存 | 合并大视频（>100MB）不崩 |
| 4 | B站 CDN Referer | 下载不报 403（若 403 → DNR 在 Safari 不可用，需换方案） |
| 5 | 保存到文件 | 待保存任务点击后，文件出现在「文件」App |

## 六、常见问题

- **签名 7 天过期**：App 打不开时，打开 SideStore 点续签即可
- **3 个应用上限**：免费 Apple ID 同时最多 3 个自签应用，删除不用的再装
- **B站 403**：Safari 的 DNR 若不支持 modifyHeaders，B站 CDN 下载会 403——这是已知限制，进任务错误信息可确认
