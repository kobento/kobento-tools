import SwiftUI

/// An app made of several published pages (kobento-mcp's `apps` tool), played screen by screen:
/// the start screen, then each screen a route opens sliding in over the last (a sheet rising from
/// the bottom), with the route's values set as its string variables and the app's shared values
/// on it. Back (the navigation bar's, or a document's back) returns to the screen under it as it
/// was left: every screen on the stack keeps its own player.
///
/// The app comes from its link: <link>app.json (the copy frozen when it was published) and
/// <link>screens/<screen>.rc. Routes resolve as the server, the web page and the Android app
/// resolve them (AppSpec.resolve).
struct AppPlayerScreen: View {
    let open: OpenApp
    @State private var loaded: Result<(AppSpec, [String: Data]), Error>?
    @State private var attempt = 0

    var body: some View {
        Group {
            switch loaded {
            case nil:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failure(let e):
                VStack(spacing: 8) {
                    Text("Could not load this app").font(.headline)
                    Text(e.localizedDescription).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { loaded = nil; attempt += 1 }
                }
                .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .success(let (spec, documents)):
                AppStack(app: spec, documents: documents)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if loaded == nil { ToolbarItem(placement: .principal) { TitleBlock(title: open.title, subtitle: "App") } } }
        .task(id: attempt) {
            do {
                let base = open.link.absoluteString.hasSuffix("/") ? open.link : open.link.appendingPathComponent("")
                let spec = try AppSpec(json: try await download(base.appendingPathComponent("app.json")))
                // Every screen's document, downloaded once, at the same time.
                let documents = try await withThrowingTaskGroup(of: (String, Data).self) { g in
                    for id in spec.screens.keys {
                        g.addTask { (id, try await download(base.appendingPathComponent("screens/\(id).rc"))) }
                    }
                    return try await g.reduce(into: [String: Data]()) { $0[$1.0] = $1.1 }
                }
                loaded = .success((spec, documents))
            } catch {
                loaded = .failure(error)
            }
        }
    }
}

/// An app to open: its published link, and its title until app.json says it.
struct OpenApp: Hashable {
    let link: URL
    let title: String
}

/// One screen on the stack: which, the values its route passed, how it came in, and its player.
private final class StackEntry: Identifiable {
    let id: Int
    let screen: String
    let params: [String: String]
    let sheet: Bool
    let nav = NavigatorBridge()

    init(id: Int, screen: String, params: [String: String], sheet: Bool) {
        self.id = id
        self.screen = screen
        self.params = params
        self.sheet = sheet
    }
}

private struct AppStack: View {
    let app: AppSpec
    let documents: [String: Data]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var stack: [StackEntry]
    @State private var nextId = 1
    /// The app's shared values, as the screens leave them.
    @State private var state: [String: AppValue]
    @State private var topCanGoBack = false
    @State private var note: String?
    private let tick = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    init(app: AppSpec, documents: [String: Data]) {
        self.app = app
        self.documents = documents
        _stack = State(initialValue: [StackEntry(id: 0, screen: app.start, params: [:], sheet: false)])
        _state = State(initialValue: app.state)
    }

    private var top: StackEntry? { stack.last }

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .bottom) {
                ForEach(Array(stack.enumerated()), id: \.element.id) { i, entry in
                    if entry.sheet {
                        Color.black.opacity(0.32).ignoresSafeArea()
                            .onTapGesture { if entry === top { pop() } }
                            .transition(.opacity)
                            .zIndex(Double(i) - 0.5)
                    }
                    screen(entry)
                        .frame(height: entry.sheet ? g.size.height * 0.72 : g.size.height)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: entry.sheet ? 16 : 0, topTrailingRadius: entry.sheet ? 16 : 0))
                        // A screen covered by a pushed one slides a little to the left, as in a navigation stack.
                        .offset(x: i < stack.count - 1 && !stack[i + 1].sheet ? -g.size.width * 0.24 : 0)
                        .transition(.move(edge: entry.sheet ? .bottom : .trailing))
                        .zIndex(Double(i))
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .bottom)
            .clipped()
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: back) { Image(systemName: "chevron.backward").fontWeight(.semibold) }
                    .accessibilityLabel("Back")
            }
            ToolbarItem(placement: .principal) {
                TitleBlock(title: app.title, subtitle: top.flatMap { app.screens[$0.screen]?.title.nonEmptyTitle } ?? "App")
            }
        }
        .overlay(alignment: .bottom) {
            if let note {
                Text(note).font(.footnote)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.opacity)
            }
        }
        .onReceive(tick) { _ in poll() }
    }

    @ViewBuilder private func screen(_ entry: StackEntry) -> some View {
        if let bytes = documents[entry.screen] {
            PlayerView(bytes: bytes, dark: scheme == .dark, nav: entry.nav) { player in
                for (k, v) in entry.params { player.keep(string: v, named: k) }
                push(state, to: player, screen: entry.screen)
            }
            .onAppear {
                entry.nav.onBack = { if entry === top { pop() } }
                entry.nav.onNavigate = { route in if entry === top { navigate(from: entry, sent: route) } }
            }
        } else {
            Text("This screen has no document").foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(.systemBackground))
        }
    }

    /// The navigation bar's back: the top screen's own first (a Navigator inside it), then the stack's.
    private func back() {
        if let top, top.nav.back() { return }
        pop()
    }

    private func pop() {
        if stack.count > 1 {
            withAnimation(.easeInOut(duration: 0.28)) { _ = stack.removeLast() }
            // The screen shown again gets the app's values as the others left them.
            if let top, let p = top.nav.player { push(state, to: p, screen: top.screen); top.nav.wake() }
        } else {
            dismiss()
        }
    }

    private func navigate(from: StackEntry, sent: String) {
        guard let hit = app.resolve(from: from.screen, sent: sent) else { show("\(sent) goes nowhere in this app"); return }
        let asked = sent.firstMatch(of: #/[?&]presentation=(\w+)/#).map { String($0.1) }
        let how = hit.route.presentation ?? (asked == "modal" ? "sheet" : asked)
        let entry = StackEntry(id: nextId, screen: hit.route.to, params: hit.params,
                               sheet: how == "sheet" || app.screens[hit.route.to]?.sheet == true)
        nextId += 1
        withAnimation(.easeInOut(duration: 0.28)) {
            if how == "replace", !stack.isEmpty { stack.removeLast() }
            stack.append(entry)
        }
    }

    /// What the top screen changed of the shared values, and whether back is its own.
    private func poll() {
        guard let top, let p = top.nav.player else { return }
        let can = top.nav.canGoBack
        if can != topCanGoBack { topCanGoBack = can }
        for (name, kind) in app.screens[top.screen]?.vars ?? [:] where state[name] != nil {
            let now: AppValue? = kind == "string" ? p.string(named: name).map(AppValue.string)
                : { let f = p.float(named: name); return f.isNaN ? nil : .float(f) }()
            if let now, now != state[name] { state[name] = now }
        }
    }

    /// The app's shared values on a screen that declares them.
    private func push(_ values: [String: AppValue], to player: KBPlayer, screen: String) {
        let vars = app.screens[screen]?.vars ?? [:]
        for (name, value) in values where vars[name] != nil {
            switch value {
            case .float(let f): player.keep(float: f, named: name)
            case .string(let s): player.keep(string: s, named: name)
            }
        }
    }

    private func show(_ text: String) {
        withAnimation { note = text }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { withAnimation { if note == text { note = nil } } }
    }
}

private extension String {
    var nonEmptyTitle: String? { isEmpty ? nil : self }
}
