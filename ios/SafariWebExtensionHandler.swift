import SafariServices
import os.log

/**
 * 扩展原生消息桥（iOS App 内嵌任务页数据源）：
 *  - "mirror"        ：扩展 SW 把最新任务列表镜像进 App Group（App 侧读取渲染）
 *  - "commands-get"  ：App 写入的操作命令（retry/cancel/delete）被 SW 取走执行
 *  - "commands-clear"：SW 取走后清空命令队列
 */
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let suiteName = "group.com.ivenlau.v2d"

    override func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let type = message["type"] as? String ?? ""

        var response: [String: Any] = ["ok": true]
        switch type {
        case "mirror":
            if let tasks = message["tasks"] {
                UserDefaults(suiteName: suiteName)?.set(tasks, forKey: "transfer.tasks")
            }
        case "commands-get":
            response["commands"] = UserDefaults(suiteName: suiteName)?.array(forKey: "app.commands") ?? []
        case "commands-clear":
            UserDefaults(suiteName: suiteName)?.removeObject(forKey: "app.commands")
        default:
            response = ["ok": false, "error": "unknown type"]
        }

        let reply = NSExtensionItem()
        reply.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [reply])
    }
}
