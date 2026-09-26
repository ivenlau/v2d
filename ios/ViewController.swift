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

// MARK: - ViewController（任务暂无法在 App 内同步，主页只展示说明卡片：
//          未检测到扩展启动 → 启用引导；已启动 → 使用说明。
//          布局全程用 UIStackView 托管，不写手工行约束，避免压缩成一条线）

class ViewController: UIViewController {
    private enum Mode { case onboarding, ready }

    private struct Step {
        let title: String
        let detail: NSAttributedString
    }

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()
    private let gradient = CAGradientLayer()
    private var mode: Mode?

    private static let onboardingSteps: [Step] = [
        Step(title: "打开 iPhone「设置」", detail: detailText("在主屏幕进入系统设置。")),
        Step(title: "点击「App」", detail: detailText("在设置首页找到并点击「App」。")),
        Step(title: "点击「Safari 浏览器」", detail: detailText("在 App 列表中找到并进入 Safari 浏览器。")),
        Step(title: "进入「扩展」并启用 V2D", detail: detailText(
            "在 Safari 设置中进入「扩展」，开启 V2D 并将网站访问设置为「允许所有网站」。",
            highlight: "「允许所有网站」")),
    ]

    private static let readySteps: [Step] = [
        Step(title: "打开视频页面", detail: detailText("在 Safari 中打开包含视频的网页，工具栏图标会出现角标。")),
        Step(title: "点击工具栏的 V2D 图标", detail: detailText("页面内嗅探到的视频会列在候选卡片中。")),
        Step(title: "选择「存本地」或「转存 115」", detail: detailText(
            "直链保存原文件，HLS 自动合并为 MP4；转存 115 需先在设置页扫码授权。")),
        Step(title: "在「传输管理」查看进度", detail: detailText("支持暂停 / 重试 / 清理历史，入口在 Safari 扩展弹窗内。")),
    ]

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "V2D"

        gradient.colors = [
            UIColor(red: 0.36, green: 0.44, blue: 0.97, alpha: 1).cgColor,
            UIColor(red: 0.55, green: 0.35, blue: 0.95, alpha: 1).cgColor,
        ]
        gradient.startPoint = CGPoint(x: 0.5, y: 0)
        gradient.endPoint = CGPoint(x: 0.5, y: 1)
        view.layer.insertSublayer(gradient, at: 0)

        // 顶部从安全区开始（渐变铺满全屏，内容不顶刘海），底部延伸到屏下（回弹时露出渐变）
        scrollView.alwaysBounceVertical = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)

        // 内容栈：官方推荐配方——边距交给 layoutMargins，宽度等于可视宽度，无冗余约束
        contentStack.axis = .vertical
        contentStack.spacing = 20
        contentStack.isLayoutMarginsRelativeArrangement = true
        contentStack.layoutMargins = UIEdgeInsets(top: 28, left: 20, bottom: 24, right: 20)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            contentStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            contentStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            contentStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            contentStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
        ])

        refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        gradient.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refresh()
    }

    /// 每次回到前台重读 App Group 标记，扩展启用后自动切到使用说明
    private func refresh() {
        let activated = AppGroup.defaults?.bool(forKey: "extension.activated") ?? false
        let next: Mode = activated ? .ready : .onboarding
        guard next != mode else { return }
        mode = next
        rebuild(for: next)
    }

    private func rebuild(for newMode: Mode) {
        for v in contentStack.arrangedSubviews { v.removeFromSuperview() }

        contentStack.addArrangedSubview(buildHero())

        switch newMode {
        case .onboarding:
            contentStack.addArrangedSubview(buildCard(
                title: "启用 Safari 扩展",
                subtitle: "首次使用请按下面 4 步开启扩展",
                steps: Self.onboardingSteps))
        case .ready:
            contentStack.addArrangedSubview(buildCard(
                title: "开始使用",
                subtitle: "扩展已启用，在 Safari 里这样转存视频",
                steps: Self.readySteps))
        }

        // 已启动态才有底部说明；引导页保持干净
        if newMode == .ready {
            let footer = UILabel()
            footer.numberOfLines = 0
            footer.textAlignment = .center
            footer.font = .systemFont(ofSize: 12)
            footer.textColor = UIColor.white.withAlphaComponent(0.75)
            footer.text = "任务进度暂不在本 App 内展示，请在 Safari 扩展的「传输管理」中查看"
            contentStack.addArrangedSubview(footer)
        }
    }

    // MARK: 品牌区（垂直栈，全部居中）

    private func buildHero() -> UIView {
        // 图标与主屏一致：读 asset catalog 的 AppIcon（converter 模板为单尺寸图）；
        // 加载失败退化为 emoji 占位
        let icon: UIView
        if let image = UIImage(named: "AppIcon") {
            let iv = UIImageView(image: image)
            iv.contentMode = .scaleAspectFill
            iv.layer.cornerRadius = 14 // 64pt × 22.4%，与系统圆角一致
            iv.layer.masksToBounds = true
            icon = iv
        } else {
            let label = UILabel()
            label.text = "🎬"
            label.font = .systemFont(ofSize: 34)
            label.textAlignment = .center
            label.backgroundColor = UIColor.white.withAlphaComponent(0.22)
            label.layer.cornerRadius = 18
            label.layer.masksToBounds = true
            icon = label
        }
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant: 64),
            icon.heightAnchor.constraint(equalToConstant: 64),
        ])

        let name = UILabel()
        name.text = "V2D"
        name.font = .systemFont(ofSize: 28, weight: .bold)
        name.textColor = .white
        name.textAlignment = .center

        let tagline = UILabel()
        tagline.text = "Safari 视频转存助手"
        tagline.font = .systemFont(ofSize: 14)
        tagline.textColor = UIColor.white.withAlphaComponent(0.8)
        tagline.textAlignment = .center

        let stack = UIStackView(arrangedSubviews: [icon, name, tagline])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 8
        stack.setCustomSpacing(14, after: icon)
        return stack
    }

    // MARK: 步骤卡片

    private func buildCard(title: String, subtitle: String, steps: [Step]) -> UIView {
        let inner = UIStackView()
        inner.axis = .vertical
        inner.spacing = 14
        inner.translatesAutoresizingMaskIntoConstraints = false

        let t = UILabel()
        t.text = title
        t.font = .systemFont(ofSize: 20, weight: .bold)
        let s = UILabel()
        s.text = subtitle
        s.font = .systemFont(ofSize: 13)
        s.textColor = .secondaryLabel
        s.numberOfLines = 0
        inner.addArrangedSubview(t)
        inner.addArrangedSubview(s)
        inner.setCustomSpacing(18, after: s)

        for (i, step) in steps.enumerated() {
            if i > 0 {
                let line = UIView()
                line.backgroundColor = .separator
                line.alpha = 0.4
                line.translatesAutoresizingMaskIntoConstraints = false
                line.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
                inner.addArrangedSubview(line)
                inner.setCustomSpacing(14, after: line)
            }
            inner.addArrangedSubview(makeStepRow(number: i + 1, step: step))
        }

        let card = UIView()
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 20
        card.layer.shadowColor = UIColor.black.cgColor
        card.layer.shadowOpacity = 0.18
        card.layer.shadowRadius = 16
        card.layer.shadowOffset = CGSize(width: 0, height: 6)
        card.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.topAnchor.constraint(equalTo: card.topAnchor, constant: 18),
            inner.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -18),
            inner.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 18),
            inner.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -18),
        ])
        return card
    }

    /** 步骤行：序号徽章 + 标题/说明竖排，全部由栈托管 */
    private func makeStepRow(number: Int, step: Step) -> UIView {
        let badge = UILabel()
        badge.text = "\(number)"
        badge.font = .systemFont(ofSize: 13, weight: .bold)
        badge.textColor = .white
        badge.backgroundColor = .systemIndigo
        badge.textAlignment = .center
        badge.layer.cornerRadius = 12
        badge.layer.masksToBounds = true
        badge.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            badge.widthAnchor.constraint(equalToConstant: 24),
            badge.heightAnchor.constraint(equalToConstant: 24),
        ])
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)

        let title = UILabel()
        title.text = step.title
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.numberOfLines = 0
        let detail = UILabel()
        detail.attributedText = step.detail
        detail.numberOfLines = 0
        let textStack = UIStackView(arrangedSubviews: [title, detail])
        textStack.axis = .vertical
        textStack.spacing = 3

        let row = UIStackView(arrangedSubviews: [badge, textStack])
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = 12
        return row
    }

    /** 正文片段；highlight 中的子串以橙色加粗强调 */
    private static func detailText(_ text: String, highlight: String? = nil) -> NSAttributedString {
        let base = NSMutableAttributedString(
            string: text,
            attributes: [.foregroundColor: UIColor.secondaryLabel, .font: UIFont.systemFont(ofSize: 13)]
        )
        if let h = highlight, let r = text.range(of: h) {
            base.addAttributes(
                [.foregroundColor: UIColor.systemOrange, .font: UIFont.boldSystemFont(ofSize: 13)],
                range: NSRange(r, in: text))
        }
        return base
    }
}
