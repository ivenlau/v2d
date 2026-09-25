import UIKit

// 最简安全版本：纯 UIKit，零外部依赖，排除闪退后逐层恢复功能

class ViewController: UIViewController {
    private let tableView = UITableView()

    private var tasks: [(name: String, state: String, error: String)] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "V2D 任务"

        tableView.dataSource = self
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 60
        tableView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tableView)
        NSLayoutConstraint.activate([
            tableView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        loadTasks()
    }

    private func loadTasks() {
        // 从共享容器读取（如有 App Group 权限）；否则显示提示
        let defaults = UserDefaults.standard
        guard let arr = defaults.array(forKey: "transfer.tasks") as? [[String: Any]] else {
            tasks = [(name: "提示：请在 Safari 中使用 V2D 转存视频", state: "info", error: "")]
            tableView.reloadData()
            return
        }
        tasks = arr.compactMap { item -> (name: String, state: String, error: String)? in
            guard let dict = item as? [String: Any] else { return nil }
            return (
                dict["fileName"] as? String ?? "未命名",
                dict["state"] as? String ?? "",
                dict["error"] as? String ?? ""
            )
        }
        tableView.reloadData()
    }
}

extension ViewController: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        max(1, tasks.count)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell") ?? UITableViewCell(style: .subtitle, reuseIdentifier: "cell")
        if indexPath.row < tasks.count {
            let t = tasks[indexPath.row]
            cell.textLabel?.text = t.name
            cell.detailTextLabel?.text = t.state + (t.error.isEmpty ? "" : " — \(t.error)")
        } else {
            cell.textLabel?.text = "提示：请在 Safari 中使用 V2D 转存视频"
            cell.detailTextLabel?.text = nil
        }
        return cell
    }
}
