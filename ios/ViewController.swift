import UIKit

// MARK: - App Group

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

struct AppTask {
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

private func stateColor(_ state: String) -> UIColor {
    switch state {
    case "done": return .systemGreen
    case "failed": return .systemRed
    case "cancelled": return .systemGray
    case "paused": return .systemOrange
    default: return .systemIndigo
    }
}

// MARK: - ViewController（任务列表 + 引导）

class ViewController: UIViewController {
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private var tasks: [AppTask] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "V2D 任务"

        tableView.dataSource = self
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 72
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        tableView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // 表头：启用引导
        let guideHeader = buildGuideHeader()
        tableView.tableHeaderView = guideHeader
        NSLayoutConstraint.activate([
            guideHeader.widthAnchor.constraint(equalTo: tableView.widthAnchor),
        ])
        guideHeader.layoutIfNeeded()
        guideHeader.frame.size = guideHeader.systemLayoutSizeFitting(
            CGSize(width: tableView.bounds.width, height: UIView.layoutFittingCompressedSize.height)
        )
        tableView.tableHeaderView = guideHeader

        loadTasks()
    }

    // MARK: IMG_0207 引导卡片

    private func buildGuideHeader() -> UIView {
        let container = UIView()
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)

        let titleLabel = UILabel()
        titleLabel.text = "Safari 扩展启用引导（4 步）"
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        stack.addArrangedSubview(titleLabel)

        let steps: [(Int, String, String)] = [
            (1, "打开 iPhone「设置」", "在主屏幕进入系统设置。"),
            (2, "点击「App」", "在设置首页找到并点击「App」。"),
            (3, "点击「Safari 浏览器」", "在 App 列表中找到并进入 Safari 浏览器。"),
        ]
        for (n, title, sub) in steps {
            let card = UIView()
            card.backgroundColor = .secondarySystemGroupedBackground
            card.layer.cornerRadius = 12
            card.translatesAutoresizingMaskIntoConstraints = false
            let chip = UILabel()
            chip.text = "步骤 \(n)"
            chip.font = .systemFont(ofSize: 12, weight: .bold)
            chip.textColor = .systemBlue
            chip.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.12)
            chip.textAlignment = .center
            chip.layer.cornerRadius = 6
            chip.translatesAutoresizingMaskIntoConstraints = false
            chip.heightAnchor.constraint(equalToConstant: 22).isActive = true
            chip.widthAnchor.constraint(equalToConstant: 52).isActive = true
            let t = UILabel()
            t.text = title
            t.font = .systemFont(ofSize: 15, weight: .semibold)
            let s = UILabel()
            s.text = sub
            s.font = .systemFont(ofSize: 13)
            s.textColor = .secondaryLabel
            s.numberOfLines = 0
            card.addSubview(chip)
            card.addSubview(t)
            card.addSubview(s)
            NSLayoutConstraint.activate([
                chip.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
                chip.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
                t.topAnchor.constraint(equalTo: chip.bottomAnchor, constant: 8),
                t.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
                t.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
                s.topAnchor.constraint(equalTo: t.bottomAnchor, constant: 4),
                s.leadingAnchor.constraint(equalTo: t.leadingAnchor),
                s.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
                s.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
            ])
            stack.addArrangedSubview(card)
        }

        // 步骤 4（含橙色高亮）
        let card4 = UIView()
        card4.backgroundColor = .secondarySystemGroupedBackground
        card4.layer.cornerRadius = 12
        card4.translatesAutoresizingMaskIntoConstraints = false
        let chip4 = UILabel()
        chip4.text = "步骤 4"
        chip4.font = .systemFont(ofSize: 12, weight: .bold)
        chip4.textColor = .systemBlue
        chip4.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.12)
        chip4.textAlignment = .center
        chip4.layer.cornerRadius = 6
        chip4.translatesAutoresizingMaskIntoConstraints = false
        chip4.heightAnchor.constraint(equalToConstant: 22).isActive = true
        chip4.widthAnchor.constraint(equalToConstant: 52).isActive = true
        let t4 = UILabel()
        t4.text = "进入「扩展」并启用 V2D"
        t4.font = .systemFont(ofSize: 15, weight: .semibold)
        t4.numberOfLines = 0
        let s4 = UILabel()
        s4.font = .systemFont(ofSize: 13)
        s4.numberOfLines = 0
        let plain = NSMutableAttributedString(
            string: "在 Safari 设置中进入「扩展」，开启 V2D 并将网站访问设置为",
            attributes: [.foregroundColor: UIColor.secondaryLabel, .font: UIFont.systemFont(ofSize: 13)]
        )
        plain.append(NSAttributedString(
            string: "「允许所有网站」",
            attributes: [.foregroundColor: UIColor.systemOrange, .font: UIFont.boldSystemFont(ofSize: 13)]
        ))
        plain.append(NSAttributedString(string: "。", attributes: [.foregroundColor: UIColor.secondaryLabel]))
        s4.attributedText = plain
        card4.addSubview(chip4)
        card4.addSubview(t4)
        card4.addSubview(s4)
        NSLayoutConstraint.activate([
            chip4.topAnchor.constraint(equalTo: card4.topAnchor, constant: 12),
            chip4.leadingAnchor.constraint(equalTo: card4.leadingAnchor, constant: 14),
            t4.topAnchor.constraint(equalTo: chip4.bottomAnchor, constant: 8),
            t4.leadingAnchor.constraint(equalTo: card4.leadingAnchor, constant: 14),
            t4.trailingAnchor.constraint(equalTo: card4.trailingAnchor, constant: -14),
            s4.topAnchor.constraint(equalTo: t4.bottomAnchor, constant: 4),
            s4.leadingAnchor.constraint(equalTo: t4.leadingAnchor),
            s4.trailingAnchor.constraint(equalTo: card4.trailingAnchor, constant: -14),
            s4.bottomAnchor.constraint(equalTo: card4.bottomAnchor, constant: -12),
        ])
        stack.addArrangedSubview(card4)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
        ])
        return container
    }

    private func loadTasks() {
        let defaults = UserDefaults.standard
        guard let arr = defaults.array(forKey: "transfer.tasks") as? [[String: Any]] else {
            tasks = []
            tableView.reloadData()
            return
        }
        tasks = arr.compactMap { item -> AppTask? in
            guard let dict = item as? [String: Any] else { return nil }
            return AppTask(dict: dict)
        }
        tableView.reloadData()
    }
}

extension ViewController: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch section {
        case 0: return max(1, tasks.filter { !["done", "failed", "cancelled", "staged"].contains($0.state) }.count)
        case 1: return tasks.filter { ["done", "failed", "cancelled"].contains($0.state) }.count
        default: return 0
        }
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch section {
        case 0: return "进行中"
        case 1: return "已结束"
        default: return nil
        }
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell") ?? UITableViewCell(style: .subtitle, reuseIdentifier: "cell")
        let filtered: [AppTask]
        if indexPath.section == 0 {
            filtered = tasks.filter { !["done", "failed", "cancelled", "staged"].contains($0.state) }
        } else {
            filtered = tasks.filter { ["done", "failed", "cancelled"].contains($0.state) }
        }
        if indexPath.row < filtered.count {
            let t = filtered[indexPath.row]
            cell.textLabel?.text = t.name
            cell.detailTextLabel?.text = (STATE_LABELS[t.state] ?? t.state) + (t.error.isEmpty ? "" : " — \(t.error)")
            cell.detailTextLabel?.textColor = t.error.isEmpty ? .secondaryLabel : .systemRed
        } else {
            cell.textLabel?.text = "提示：请在 Safari 中使用 V2D 转存视频"
            cell.detailTextLabel?.text = nil
        }
        return cell
    }
}
