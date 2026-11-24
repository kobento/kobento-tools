import SwiftUI

@main
struct KobentoShowcasesApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.kobentoAccent)
                .onAppear { model.start() }
        }
    }
}

/// Three tabs: the bundled showcases, the public stream, and the account's own pages.
struct RootView: View {
    @State private var tab = Launch.tab

    enum Tab: String { case showcases, stream, pages }

    var body: some View {
        TabView(selection: $tab) {
            ShowcasesTab()
                .tabItem { Label("Showcases", systemImage: "square.grid.2x2") }
                .tag(Tab.showcases)
            StreamTab()
                .tabItem { Label("Stream", systemImage: "safari") }
                .tag(Tab.stream)
            PagesTab()
                .tabItem { Label("Your pages", systemImage: "person") }
                .tag(Tab.pages)
        }
    }
}

extension Color {
    /// Kobento's blue (the mark's): a deeper one on light backgrounds.
    static let kobentoAccent = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0x40 / 255, green: 0x9B / 255, blue: 0xF0 / 255, alpha: 1)
        : UIColor(red: 0x1F / 255, green: 0x6F / 255, blue: 0xC0 / 255, alpha: 1) })
}

/// What a launch asks for (`xcrun simctl launch <device> dev.kobento.showcases -showcase SHW-23`,
/// `-tab stream`): a showcase to open, a tab to start on. For tests and screenshots; read once.
enum Launch {
    private static let args = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
    static let showcase = args["showcase"] as? String
    static let tab = (args["tab"] as? String).flatMap(RootView.Tab.init(rawValue:)) ?? .showcases
    /// The look the showcase opens in ("Mono dark"), and whether its details show (`-info YES`).
    static let look = (args["look"] as? String).flatMap(Look.init(rawValue:))
    static let info = (args["info"] as? String) == "YES"
    /// An app to play at launch (`-tab pages -app https://mcp.kobento.dev/apps/<id>/`).
    static let app = (args["app"] as? String).flatMap(URL.init(string:))
}
