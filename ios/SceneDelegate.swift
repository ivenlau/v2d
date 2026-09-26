import UIKit
import SwiftUI

/// 程序化创建窗口内容（不依赖 storyboard）——converter 的 storyboard 引用旧 outlet，替换 VC 后会崩溃
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: TaskListView())
        self.window = window
        window.makeKeyAndVisible()
    }
}
