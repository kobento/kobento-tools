import SwiftUI

/// The app's side of the Navigator convention (kobento-mcp's Navigator component, which any
/// document may follow): the document navigates inside itself and the app keeps back's meaning.
///
/// - The document exports `canGoBack`: 1 while back is its own (its stack is deeper than one, a
///   sheet is open). Then the navigation bar's back button is the document's: each tap adds 1 to
///   its exported `backCount`, and it pops. Otherwise the system back button (and its edge
///   swipe) is shown and leaves the screen.
/// - The document asks the app with host actions: `back` (its start screen's back: leave) and
///   `navigate`, whose value is a route of the app's, maybe with `?presentation=modal|replace`.
///
/// A document without these variables reads NaN: nothing changes.
final class NavigatorBridge {
    weak var player: KBPlayer?
    /// Draws a frame: the player rests while nothing moves.
    var wake: () -> Void = {}
    var onBack: () -> Void = {}
    var onNavigate: (String) -> Void = { _ in }

    var canGoBack: Bool { (player?.float(named: "canGoBack") ?? .nan) > 0.5 }

    /// The system back: the document's while it can go back (true), else the app's (false).
    func back() -> Bool {
        guard let p = player, canGoBack else { return false }
        let n = p.float(named: "backCount")
        guard p.setFloat((n.isNaN ? 0 : n) + 1, named: "backCount") else { return false }
        wake()
        return true
    }

    /// The document's host actions.
    func action(_ name: String, _ value: String) {
        switch name {
        case "back": onBack()
        case "navigate": onNavigate(value)
        default: break
        }
    }
}

extension View {
    /// Back for a screen that plays a document: while the document can go back, the back button
    /// pops inside it; otherwise it is the system's. `routes` shows what the document asked to
    /// open (this app has no routes of its own).
    func navigatorBack(_ nav: NavigatorBridge) -> some View { modifier(NavigatorBack(nav: nav)) }
}

private struct NavigatorBack: ViewModifier {
    let nav: NavigatorBridge
    @Environment(\.dismiss) private var dismiss
    @State private var canGoBack = false
    @State private var route: String?
    private let tick = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    func body(content: Content) -> some View {
        content
            .navigationBarBackButtonHidden(canGoBack)
            .toolbar {
                if canGoBack {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { if !nav.back() { dismiss() } } label: {
                            Image(systemName: "chevron.backward").fontWeight(.semibold)
                        }
                        .accessibilityLabel("Back")
                    }
                }
            }
            .overlay(alignment: .bottom) {
                if let route {
                    Text("navigate \(route)").font(.footnote)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.bottom, 24)
                        .transition(.opacity)
                }
            }
            .onReceive(tick) { _ in
                let now = nav.canGoBack
                if now != canGoBack { canGoBack = now }
            }
            .onAppear {
                nav.onBack = { dismiss() }
                nav.onNavigate = { r in
                    withAnimation { route = r }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { withAnimation { if route == r { route = nil } } }
                }
            }
    }
}
