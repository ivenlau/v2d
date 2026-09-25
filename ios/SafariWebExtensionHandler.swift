import SafariServices

// App Group 解析（文件级函数，SideStore 重签会改写组名所以运行时解析）
private let groupFallback = "group.com.ivenlau.v2d"
private var resolvedGroup: String?

private func appGroup() -> String {
    if let g = resolvedGroup { return g }
    var candidates: [String] = []
    if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
       let raw = try? Data(contentsOf: url),
       let text = String(data: raw, encoding: .utf8) {
        if let r = text.range(of: "com.apple.security.application-groups[\\s\\S]*?</array>", options: .regularExpression) {
            let seg = String(text[r])
            if let g = seg.range(of: "group\\.[A-Za-z0-9.\\-]+", options: .regularExpression) {
                candidates.append(String(seg[g]))
            }
        }
        if let teamR = text.range(of: "<key>application-identifier</key>\\s*<string>[A-Z0-9]{10}\\.", options: .regularExpression) {
            let team = String(text[teamR]).split(separator: ".").last ?? ""
            if !team.isEmpty {
                candidates.append("group.\(team).com.rileytestut.AltStore")
                candidates.append("group.\(team).com.SideStore.SideStore")
            }
        }
    }
    candidates.append(groupFallback)
    for c in candidates {
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: c) != nil {
            resolvedGroup = c
            return c
        }
    }
    resolvedGroup = groupFallback
    return groupFallback
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?["SFExtensionMessageKey"] as? [String: Any] ?? [:]
        let type = message["type"] as? String ?? ""
        let group = appGroup()
        let defaults = UserDefaults(suiteName: group)

        var response: [String: Any] = ["ok": true]
        switch type {
        case "mirror":
            if let tasks = message["tasks"] {
                defaults?.set(tasks, forKey: "transfer.tasks")
            }
        case "commands-get":
            response["commands"] = defaults?.array(forKey: "app.commands") ?? []
        case "commands-clear":
            defaults?.removeObject(forKey: "app.commands")
        default:
            response = ["ok": false, "error": "unknown type"]
        }

        let reply = NSExtensionItem()
        reply.userInfo = ["SFExtensionMessageKey": response]
        context.completeRequest(returningItems: [reply])
    }
}
