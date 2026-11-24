import Foundation

/// An app of the account's (kobento-mcp's apps tool): several pages tied together. `link` (its
/// published link) is nil until it is published.
struct MyApp: Identifiable, Hashable {
    let id: String
    let title: String
    let screens: Int
    let link: URL?
    let version: Int
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
    let title: String
    let start: String
    let screens: [String: AppScreenSpec]
    let routes: [AppRoute]
    let state: [String: AppValue]

    init(json data: Data) throws {
        let o = try JSON.object(data)
        title = o["title"] as? String ?? ""
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
        state = (o["state"] as? [String: [String: Any]] ?? [:]).mapValues { v in
            v["type"] as? String == "string" ? .string(v["value"] as? String ?? "")
                : .float((v["value"] as? NSNumber)?.floatValue ?? 0)
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
