import SwiftUI

/// An app made of several published pages (kobento-mcp's `apps` tool), played screen by screen:
/// the start screen, then each screen a route opens sliding in over the last (a sheet rising from
/// the bottom), with the route's values set as its string variables and the app's shared values
/// on it. Back (the navigation bar's, a swipe from the leading edge, or a document's back) returns
/// to the screen under it as it was left: every screen on the stack keeps its own player.
///
/// An app with tabs has a bottom bar: each tab keeps its own stack (its players alive while another
/// tab shows), a route to a tab's screen switches to it, and tapping the tab showing goes back to
/// its first screen. Values the app marks persist are kept for next time (per app).
///
/// The app comes from its link: <link>app.json (the copy frozen when it was published) and
/// <link>screens/<screen>.rc, or the owner's draft (the pages as they are now, read signed in).
/// Routes resolve as the server, the web page and the Android app resolve them (AppSpec.resolve).
struct AppPlayerScreen: View {
    let open: OpenApp
    @Environment(AppModel.self) private var model
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
                AppStack(app: spec, documents: documents, draft: open.draft)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        // The app's own bottom bar (its tabs) replaces this app's while it plays.
        .toolbar(.hidden, for: .tabBar)
        .toolbar { if loaded == nil { ToolbarItem(placement: .principal) { TitleBlock(title: open.title, subtitle: open.draft ? "App · draft" : "App") } } }
        .task(id: attempt) {
            let account = model.account
            let draft = open.draft
            let fetch: @Sendable (URL) async throws -> Data = { url in draft ? try await account.authorizedDownload(url) : try await download(url) }
            do {
                let base = open.link.absoluteString.hasSuffix("/") ? open.link : open.link.appendingPathComponent("")
                let spec = try AppSpec(json: try await fetch(base.appendingPathComponent("app.json")))
                // Every screen's document, downloaded once, at the same time.
                let documents = try await withThrowingTaskGroup(of: (String, Data).self) { g in
                    for id in spec.screens.keys {
                        g.addTask { (id, try await fetch(base.appendingPathComponent("screens/\(id).rc"))) }
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

/// An app to open: its published link (or the draft's), and its title until app.json says it.
struct OpenApp: Hashable {
    let link: URL
    let title: String
    var draft = false
}

/// One screen on a stack: which, the values its route passed, how it came in, and its player.
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
    let draft: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    /// One stack per tab (one without tabs); cur is the tab showing.
    @State private var stacks: [[StackEntry]]
    @State private var cur = 0
    @State private var nextId: Int
    /// The app's shared values, as the screens leave them.
    @State private var state: [String: AppValue]
    @State private var note: String?
    private let tick = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    init(app: AppSpec, documents: [String: Data], draft: Bool) {
        self.app = app
        self.documents = documents
        self.draft = draft
        let roots = app.tabs.isEmpty ? [app.start] : app.tabs.map(\.screen)
        _stacks = State(initialValue: roots.enumerated().map { [StackEntry(id: $0.offset, screen: $0.element, params: [:], sheet: false)] })
        _nextId = State(initialValue: roots.count)
        // Values marked persist start from last time.
        var values = app.state
        for name in app.persist {
            let key = Self.key(app, name)
            switch values[name] {
            case .float: if UserDefaults.standard.object(forKey: key) != nil { values[name] = .float(UserDefaults.standard.float(forKey: key)) }
            case .string: if let s = UserDefaults.standard.string(forKey: key) { values[name] = .string(s) }
            case nil: break
            }
        }
        _state = State(initialValue: values)
    }

    private static func key(_ app: AppSpec, _ name: String) -> String { "app-values:\(app.id):\(name)" }
    private var stack: [StackEntry] { stacks[cur] }
    private var top: StackEntry? { stack.last }

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { g in
                ZStack {
                    // Every tab's stack stays (its players alive); the one showing is on top.
                    // A tab switch: the tab chosen fades in over the one showing (which stays as it
                    // is under it) while growing from 96% (250 ms); then the one under it goes.
                    ForEach(stacks.indices, id: \.self) { t in
                        stackView(stacks[t], size: g.size)
                            .scaleEffect(t == cur ? 1 : 0.96)
                            .opacity(t == cur ? 1 : 0)
                            // (The one left goes once covered; a zero-length animation ignores its delay.)
                            .animation(t == cur ? Self.fadeIn : .linear(duration: 0.01).delay(0.25), value: cur)
                            .allowsHitTesting(t == cur)
                            .zIndex(t == cur ? 1 : 0)
                    }
                }
                .frame(width: g.size.width, height: g.size.height, alignment: .bottom)
                .clipped()
                // Back with a swipe from the leading edge, as the navigation stack's own.
                .overlay(alignment: .leading) {
                    Color.clear.frame(width: 20).contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 12).onEnded { v in
                            if v.translation.width > 70 && abs(v.translation.height) < 80 { back() }
                        })
                }
            }
            if !app.tabs.isEmpty { tabBar }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: back) { Image(systemName: "chevron.backward").fontWeight(.semibold) }
                    .accessibilityLabel("Back")
            }
            ToolbarItem(placement: .principal) {
                TitleBlock(title: app.title, subtitle: (top.flatMap { app.screens[$0.screen]?.title.nonEmptyTitle } ?? "App") + (draft ? " · draft" : ""))
            }
        }
        .overlay(alignment: .bottom) {
            if let note {
                Text(note).font(.footnote)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, app.tabs.isEmpty ? 24 : 90)
                    .transition(.opacity)
            }
        }
        .onReceive(tick) { _ in poll() }
    }

    private func stackView(_ entries: [StackEntry], size: CGSize) -> some View {
        ZStack(alignment: .bottom) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { i, entry in
                if entry.sheet {
                    Color.black.opacity(0.32).ignoresSafeArea()
                        .onTapGesture { if entry === top { pop() } }
                        .transition(.opacity)
                        .zIndex(Double(i) - 0.5)
                }
                screen(entry)
                    .frame(height: entry.sheet ? size.height * 0.72 : size.height)
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: entry.sheet ? 16 : 0, topTrailingRadius: entry.sheet ? 16 : 0))
                    // A screen covered by a pushed one slides a little to the left, as in a navigation stack.
                    .offset(x: i < entries.count - 1 && !entries[i + 1].sheet ? -size.width * 0.24 : 0)
                    .transition(.move(edge: entry.sheet ? .bottom : .trailing))
                    .zIndex(Double(i))
            }
        }
        .frame(width: size.width, height: size.height, alignment: .bottom)
    }

    /// The bottom bar: each tab's icon (filled while it shows) and label.
    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(Array(app.tabs.enumerated()), id: \.offset) { i, t in
                Button { selectTab(i) } label: {
                    VStack(spacing: 4) {
                        if let d = (i == cur ? t.pathSelected ?? t.path : t.path) {
                            SVGPathShape(d: d).fill(style: FillStyle(eoFill: false)).frame(width: 24, height: 24)
                                .padding(.horizontal, 20).padding(.vertical, 4)
                                .background(i == cur ? Color.accentColor.opacity(0.16) : .clear, in: Capsule())
                        }
                        Text(t.label).font(.caption2.weight(i == cur ? .semibold : .regular)).lineLimit(1)
                    }
                    .foregroundStyle(i == cur ? Color.accentColor : .secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8).padding(.bottom, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t.label)
                .accessibilityAddTraits(i == cur ? .isSelected : [])
                .accessibilityIdentifier("tab-\(t.screen)")
            }
        }
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
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

    /// The incoming tab: Material's emphasized decelerate.
    private static let fadeIn = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.25)

    /// Shows tab i; again on the tab showing: back to its first screen.
    private func selectTab(_ i: Int) {
        if i == cur {
            if stacks[i].count > 1 { withAnimation(.easeInOut(duration: 0.28)) { stacks[i] = [stacks[i][0]] } }
            return
        }
        cur = i
        if let top, let p = top.nav.player { push(state, to: p, screen: top.screen); top.nav.wake() }
    }

    /// Back: the top screen's own first (a Navigator inside it), then the stack's, then leave.
    private func back() {
        if let top, top.nav.back() { return }
        pop()
    }

    private func pop() {
        if stacks[cur].count > 1 {
            withAnimation(.easeInOut(duration: 0.28)) { _ = stacks[cur].removeLast() }
            // The screen shown again gets the app's values as the others left them.
            if let top, let p = top.nav.player { push(state, to: p, screen: top.screen); top.nav.wake() }
        } else {
            dismiss()
        }
    }

    private func navigate(from: StackEntry, sent: String) {
        guard let hit = app.resolve(from: from.screen, sent: sent) else { show("\(sent) goes nowhere in this app"); return }
        if let t = app.tabs.firstIndex(where: { $0.screen == hit.route.to }) {
            // The tab's first screen is what the route names: that tab, back to its first screen.
            if t != cur { selectTab(t) }
            if stacks[t].count > 1 { withAnimation(.easeInOut(duration: 0.28)) { stacks[t] = [stacks[t][0]] } }
            if let p = stacks[t].first?.nav.player { for (k, v) in hit.params { p.keep(string: v, named: k) } }
            return
        }
        let asked = sent.firstMatch(of: #/[?&]presentation=(\w+)/#).map { String($0.1) }
        let how = hit.route.presentation ?? (asked == "modal" ? "sheet" : asked)
        let entry = StackEntry(id: nextId, screen: hit.route.to, params: hit.params,
                               sheet: how == "sheet" || app.screens[hit.route.to]?.sheet == true)
        nextId += 1
        withAnimation(.easeInOut(duration: 0.28)) {
            if how == "replace", stacks[cur].count > 1 { stacks[cur].removeLast() }
            stacks[cur].append(entry)
        }
    }

    /// What the top screen changed of the shared values (kept when marked persist).
    private func poll() {
        guard let top, let p = top.nav.player else { return }
        for (name, kind) in app.screens[top.screen]?.vars ?? [:] where state[name] != nil {
            let now: AppValue? = kind == "string" ? p.string(named: name).map(AppValue.string)
                : { let f = p.float(named: name); return f.isNaN ? nil : .float(f) }()
            if let now, now != state[name] {
                state[name] = now
                if app.persist.contains(name) {
                    switch now {
                    case .float(let f): UserDefaults.standard.set(f, forKey: Self.key(app, name))
                    case .string(let s): UserDefaults.standard.set(s, forKey: Self.key(app, name))
                    }
                }
            }
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
