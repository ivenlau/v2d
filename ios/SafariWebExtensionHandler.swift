import SafariServices

/**
 * 扩展原生消息桥（iOS App 内嵌任务页数据源）：
 *  - "mirror"        ：扩展 SW 把最新任务列表镜像进 App Group（App 侧读取渲染）
 *  - "commands-get"  ：App 写入的操作命令（retry/cancel/delete）被 SW 取走执行
 *  - "commands-clear"：SW 取走后清空命令队列
 *
 * ⚠️ App Group 组名必须在运行时从签名描述文件解析：SideStore 等自签工具重签时会
 * 改写 App Group（固定组名读不到共享数据——历史 bug：App 任务列表恒为空）。
 */
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let fallbackGroup = "group.com.ivenlau.v2d"
    private static var cachedGroup: String?

    /// 从本 bundle 的 embedded.mobileprovision 解析实际授予的 App Group
    private static func resolveAppGroup() -> String {
        if let cached = cachedGroup { return cached }
        var candidates: [String] = []
        if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
           let raw = try? Data(contentsOf: url),
           let text = String(data: raw, encoding: .utf8) {
            // 1) 描述文件里声明的 App Groups
            if let r = text.range(of: "com\\.apple\\.security\\.application-groups[\\s\\S]*?</array>", options: .regularExpression) {
                let seg = String(text[r])
                if let g = seg.range(of: "group\\.[A-Za-z0-9.\\-]+", options: .regularExpression) {
                    candidates.append(String(seg[g]))
                }
            }
            // 2) AltStore/SideStore 风格：group.<teamID>.<工具标识>
            if let team = extractTeamID(text) {
                candidates.append("group.\(team).com.rileytestut.AltStore")
                candidates.append("group.\(team).com.SideStore.SideStore")
            }
        }
        candidates.append(fallback)
        for c in candidates {
            if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: c) != nil {
                cachedGroup = c
                return c
            }
        }
        cachedGroup = fallback
        return fallback
    }

    private static func extractTeamID(_ provisionText: String) -> String? {
        guard let r = provisionText.range(of: "<key>application-identifier</key>\\s*<string>[A-Z0-9]{10}\\.", options: .regularExpression) else { return nil }
        let seg = String(provisionText[r]).split(separator: ".").last ?? ""
        return seg.isEmpty ? nil : String(seg)
    }

    override func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let type = message["type"] as? String ?? ""

        var response: [String: Any] = ["ok": true]
        switch type {
        case "mirror":
            if let tasks = message["tasks"] {
                UserDefaults(suiteName: resolveAppGroup())?.set(tasks, forKey: "transfer.tasks")
            }
        case "commands-get":
            response["commands"] = UserDefaults(suiteName: resolveAppGroup())?.array(forKey: "app.commands") ?? []
        case "commands-clear":
            UserDefaults(suiteName: resolveAppGroup())?.removeObject(forKey: "app.commands")
        default:
            response = ["ok": false, "error": "unknown type"]
        }

        let reply = NSExtensionItem()
        reply.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [reply])
    }
}
