import Foundation
import SwiftUI

/// An app of the account's (kobento-mcp's apps tool): several pages tied together. `link` (its
/// published link) is nil until it is published.
struct MyApp: Identifiable, Hashable {
    let id: String
    let title: String
    let screens: Int
    let link: URL?
    let version: Int
    /// The owner's draft (the pages as they are now), played signed in.
    var draft: URL? = nil
}

/// A tab of the app's bottom bar: its screen, label and icon (a Material Symbols path in a 960 box).
struct AppTab {
    let screen: String
    let label: String
    let path: String?
    let pathSelected: String?
}

/// One screen of an app: its title, whether it shows as a sheet, the variables it declares
/// (name: "string", "float" or "other").
struct AppScreenSpec {
    let title: String
    let sheet: Bool
    let vars: [String: String]
}

/// A route: what a screen sends ("/plant/:id"), the screen that answers it, only from one screen
/// or from any, and how it comes in ("sheet", "replace", or nil: pushed).
struct AppRoute {
    let route: String
    let to: String
    let from: String?
    let presentation: String?
}

/// A shared value of the app's: a number or a text.
enum AppValue: Equatable {
    case float(Float)
    case string(String)
}

/// An app as it plays: its app.json (the copy frozen when it was published).
struct AppSpec {
    let id: String
    let title: String
    let start: String
    let screens: [String: AppScreenSpec]
    let routes: [AppRoute]
    let state: [String: AppValue]
    /// The shared values kept for next time.
    let persist: Set<String>
    /// The bottom bar (empty: none).
    let tabs: [AppTab]

    init(json data: Data) throws {
        let o = try JSON.object(data)
        title = o["title"] as? String ?? ""
        id = (o["id"] as? String).nonEmpty ?? title
        start = try o.string("start")
        let s = o["screens"] as? [String: [String: Any]] ?? [:]
        screens = s.mapValues { e in
            AppScreenSpec(title: e["title"] as? String ?? "", sheet: e["as"] as? String == "sheet",
                          vars: e["vars"] as? [String: String] ?? [:])
        }
        routes = (o["routes"] as? [[String: Any]] ?? []).compactMap { r in
            guard let route = r["route"] as? String, let to = r["to"] as? String else { return nil }
            return AppRoute(route: route, to: to, from: (r["from"] as? String).nonEmpty, presentation: (r["presentation"] as? String).nonEmpty)
        }
        let st = o["state"] as? [String: [String: Any]] ?? [:]
        state = st.mapValues { v in
            v["type"] as? String == "string" ? .string(v["value"] as? String ?? "")
                : .float((v["value"] as? NSNumber)?.floatValue ?? 0)
        }
        persist = Set(st.filter { $0.value["persist"] as? Bool == true }.keys)
        tabs = (o["tabs"] as? [[String: Any]] ?? []).compactMap { t in
            guard let screen = t["screen"] as? String else { return nil }
            return AppTab(screen: screen, label: t["label"] as? String ?? screen, path: (t["path"] as? String).nonEmpty, pathSelected: (t["path_selected"] as? String).nonEmpty)
        }
    }

    /// The route that answers `sent` from screen `from`, and the values it passes; nil when none
    /// does. As the server and the web page resolve it: a route limited to the sending screen
    /// first, then an exact route before a pattern, then the first listed.
    func resolve(from: String, sent: String) -> (route: AppRoute, params: [String: String])? {
        if sent.hasPrefix("@") { return nil }
        var best: (rank: Int, index: Int, route: AppRoute, params: [String: String])?
        for (i, r) in routes.enumerated() {
            guard let params = matchRoute(r.route, sent) else { continue }
            if let f = r.from, f != from { continue }
            let rank = (r.from != nil ? 0 : 2) + (r.route.contains(":") ? 1 : 0)
            if best == nil || rank < best!.rank { best = (rank, i, r, params) }
        }
        return best.map { ($0.route, $0.params) }
    }
}

/// "/plant/:id" against "/plant/42": ["id": "42"], or nil.
func matchRoute(_ pattern: String, _ sent: String) -> [String: String]? {
    func parts(_ s: String) -> [Substring] {
        (s.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "").split(separator: "/")
    }
    let p = parts(pattern), s = parts(sent)
    guard p.count == s.count else { return nil }
    var params: [String: String] = [:]
    for (a, b) in zip(p, s) {
        if a.hasPrefix(":") { params[String(a.dropFirst())] = String(b).removingPercentEncoding ?? String(b) }
        else if a != b { return nil }
    }
    return params
}

/// An SVG path of absolute M, L, Q and Z commands (the tab icons app.json carries), scaled from its
/// 960 box to the rect.
struct SVGPathShape: Shape {
    let d: String

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let k = min(rect.width, rect.height) / 960
        let scanner = Scanner(string: d)
        scanner.charactersToBeSkipped = CharacterSet(charactersIn: " ,\n")
        func num() -> CGFloat? { scanner.scanDouble().map { CGFloat($0) * k } }
        func pt() -> CGPoint? { guard let x = num(), let y = num() else { return nil }; return CGPoint(x: rect.minX + x, y: rect.minY + y) }
        while !scanner.isAtEnd {
            guard let c = scanner.scanCharacter() else { break }
            switch c {
            case "M": if let a = pt() { p.move(to: a) }
            case "L": if let a = pt() { p.addLine(to: a) }
            case "Q": if let c1 = pt(), let a = pt() { p.addQuadCurve(to: a, control: c1) }
            case "Z": p.closeSubpath()
            default: break
            }
        }
        return p
    }
}
