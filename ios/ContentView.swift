import SwiftUI

/// 任务条目：由 App Group 共享容器中的 transfer.tasks JSON 解码
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
    "queued": "排队中",
    "offline-adding": "提交离线",
    "offline-polling": "115 转存中",
    "downloading": "下载中",
    "hashing": "校验中",
    "transmuxing": "合并封装",
    "checking": "秒传检测中",
    "uploading": "上传中",
    "saving": "保存本地",
    "staged": "待保存",
    "paused": "已暂停",
    "done": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
]

struct ContentView: View {
    @State private var tasks: [AppTask] = []
    @State private var syncedAt = ""

    private let suiteName = "group.com.ivenlau.v2d"

    var body: some View {
        NavigationView {
            List {
                Section("进行中") {
                    let act = tasks.filter { !["done", "failed", "cancelled"].contains($0.state) }
                    if act.isEmpty {
                        Text("暂无进行中的任务").foregroundColor(.secondary)
                    }
                    ForEach(act) { row($0) }
                }
                Section("已结束") {
                    let fin = tasks.filter { ["done", "failed", "cancelled"].contains($0.state) }
                    if fin.isEmpty {
                        Text("暂无历史记录").foregroundColor(.secondary)
                    }
                    ForEach(fin) { row($0) }
                }
                Section {
                    Text("保存待保存任务的文件：请在 Safari 的 V2D 弹窗中操作。")
                        .font(.footnote).foregroundColor(.secondary)
                }
            }
            .navigationTitle("V2D 任务")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("刷新") { load() }
                }
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

    private func load(): Void {
        let defaults = UserDefaults(suiteName: suiteName)
        guard let arr = defaults?.array(forKey: "transfer.tasks") as? [[String: Any]] else {
            tasks = []
            return
        }
        tasks = arr
            .sorted { ($0["createdAt"] as? Double ?? 0) > ($1["createdAt"] as? Double ?? 0) }
            .map(AppTask.init(dict:))
        syncedAt = ""
    }
}
