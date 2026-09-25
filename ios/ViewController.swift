import UIKit
import SwiftUI

// MARK: - App Group（运行时从签名描述文件解析组名）

enum AppGroup {
    static let fallback = "group.com.ivenlau.v2d"
    private static var cached: String?

    static var defaults: UserDefaults? { UserDefaults(suiteName: resolve()) }

    static func resolve() -> String {
        if let c = cached { return c }
        var candidates: [String] = []
        if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
           let raw = try? Data(contentsOf: url),
           let text = String(data: raw, encoding: .utf8) {
            if let r = text.range(of: "com\\.apple\\.security\\.application-groups[\\s\\S]*?</array>", options: .regularExpression) {
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
        candidates.append(fallback)
        for c in candidates {
            if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: c) != nil {
                cached = c
                return c
            }
        }
        cached = fallback
        return fallback
    }
}

// MARK: - 任务模型

struct AppTask: Identifiable {
    let id: String
    let name: String
    let state: String
    let progress: Double?
    let error: String

    init(dict: [String: Any]) {
        self.id = dict["id"] as? String ?? UUID().uuidString
        self.name = dict["fileName"] as? String ?? "未命名"
        self.state = dict["state"] as? String ?? ""
        let size = (dict["size"] as? NSNumber)?.intValue ?? 0
        if size > 0 {
            let done = (dict["received"] as? NSNumber)?.intValue
                ?? (dict["uploaded"] as? NSNumber)?.intValue ?? 0
            self.progress = Double(done) / Double(size)
        } else {
            self.progress = nil
        }
        self.error = dict["error"] as? String ?? ""
    }
}

private let STATE_LABELS: [String: String] = [
    "queued": "排队中", "offline-adding": "提交离线", "offline-polling": "115 转存中",
    "downloading": "下载中", "hashing": "校验中", "transmuxing": "合并封装",
    "checking": "秒传检测中", "uploading": "上传中", "saving": "保存本地",
    "staged": "待保存", "paused": "已暂停", "done": "已完成",
    "failed": "失败", "cancelled": "已取消",
]

// MARK: - IMG_0207 启用引导

private struct GuideStep: Identifiable {
    let id: Int
    let title: String
    let subtitle: Text
}

private let GUIDE_STEPS: [GuideStep] = [
    GuideStep(id: 1, title: "打开 iPhone「设置」", subtitle: Text("在主屏幕进入系统设置。")),
    GuideStep(id: 2, title: "点击「App」", subtitle: Text("在设置首页找到并点击「App」。")),
    GuideStep(id: 3, title: "点击「Safari 浏览器」", subtitle: Text("在 App 列表中找到并进入 Safari 浏览器。")),
    GuideStep(id: 4, title: "进入「扩展」并启用 V2D", subtitle: {
        Text("在 Safari 设置中进入「扩展」，开启 V2D 并将网站访问设置为")
        + Text("「允许所有网站」").foregroundColor(.orange)
        + Text("。")
    }()),
]

private struct GuideSection: View {
    @AppStorage("guideCollapsed") private var collapsed = false

    var body: some View {
        DisclosureGroup(isExpanded: $collapsed) {
            ForEach(GUIDE_STEPS) { step in
                VStack(alignment: .leading, spacing: 4) {
                    Text("步骤 \(step.id)")
                        .font(.caption).bold()
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color.blue.opacity(0.12))
                        .foregroundColor(.blue)
                        .clipShape(Capsule())
                    Text(step.title).font(.headline)
                    step.subtitle.font(.subheadline).foregroundColor(.secondary)
                }
                .padding(.vertical, 6)
            }
        } label: {
            HStack {
                Text("Safari 扩展启用引导（4 步）").font(.headline)
                Spacer()
                Image(systemName: collapsed ? "chevron.down" : "chevron.up")
            }
        }
    }
}

// MARK: - 任务列表（SwiftUI）

struct TaskListView: View {
    @State private var tasks: [AppTask] = []

    var body: some View {
        List {
            Section { GuideSection() }
            Section("进行中") {
                let act = tasks.filter { !["done", "failed", "cancelled", "staged"].contains($0.state) }
                if act.isEmpty { Text("暂无进行中的任务").foregroundColor(.secondary) }
                ForEach(act) { row($0) }
            }
            Section("已结束") {
                let fin = tasks.filter { ["done", "failed", "cancelled"].contains($0.state) }
                if fin.isEmpty { Text("暂无历史记录").foregroundColor(.secondary) }
                ForEach(fin) { row($0) }
            }
        }
        .onAppear(perform: load)
        .onReceive(Timer.publish(every: 3, on: .main, in: .common).autoconnect()) { _ in
            load()
        }
    }

    private func row(_ t: AppTask) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(STATE_LABELS[t.state] ?? t.state)
                    .font(.caption).bold()
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(chipColor(t.state).opacity(0.85))
                    .foregroundColor(.white)
                    .clipShape(Capsule())
                Text(t.name).font(.subheadline).lineLimit(1)
            }
            if let p = t.progress {
                ProgressView(value: p)
                Text("\(Int(p * 100))%").font(.caption2).foregroundColor(.secondary)
            }
            if !t.error.isEmpty {
                Text(t.error).font(.caption).foregroundColor(.red)
            }
        }
        .padding(.vertical, 2)
    }

    private func chipColor(_ state: String) -> Color {
        switch state {
        case "done": return .green
        case "failed": return .red
        case "cancelled": return .gray
        case "paused": return .orange
        default: return .indigo
        }
    }

    private func load() {
        let defaults = UserDefaults(suiteName: AppGroup.resolve())
        guard let arr = defaults?.array(forKey: "transfer.tasks") as? [[String: Any]] else {
            tasks = []
            return
        }
        tasks = arr
            .sorted { ($0["createdAt"] as? Double ?? 0) > ($1["createdAt"] as? Double ?? 0) }
            .map(AppTask.init(dict:))
    }
}

// MARK: - UIKit 桥（承载 SwiftUI）

class ViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let hosting = UIHostingController(rootView: TaskListView())
        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }
}
