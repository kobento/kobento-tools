import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import UIKit

/// Signing in to a Kobento server (mcp.kobento.dev) the way a native app should (RFC 8252): the
/// server's own sign-in page in an ASWebAuthenticationSession (it shares Safari's cookies, so
/// someone signed in on the website only sees the "Allow" page), OAuth 2.1's authorization code
/// with PKCE, and the answer coming back on the app's scheme, dev.kobento.showcases:/oauth.
///
/// The app registers itself once per server (dynamic client registration, RFC 7591), keeps the
/// refresh token (30 days, a new one on each refresh) in the Keychain and the access token (1 h)
/// in memory, and refreshes when the access token has expired or is refused.
@MainActor @Observable
final class Account {
    static let scheme = "dev.kobento.showcases"
    static let redirect = "\(scheme):/oauth"

    /// The server: the app's KobentoServer, or the one a launch names (`-server http://localhost:8899`,
    /// for a local test server), for that launch only.
    let server: String
    /// The signed-in account's email, or nil.
    private(set) var email: String?
    /// The signed-in account's id (its items' author_id in the stream), once pages.json said it.
    private(set) var accountId: Int?

    private let defaults = UserDefaults.standard
    private var access: String?
    private var accessExpires = Date.distantPast
    private var metadataCache: [String: Any]?
    private var session: ASWebAuthenticationSession?
    private let anchor = WindowAnchor()

    init() {
        let named = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)["server"] as? String
        let built = Bundle.main.object(forInfoDictionaryKey: "KobentoServer") as? String ?? "https://mcp.kobento.dev"
        server = (named ?? built).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        // The saved sign-in belongs to one server: on another, sign out of that one.
        if defaults.string(forKey: K.server) != server {
            Keychain.delete(K.refresh)
            for k in [K.email, K.client, K.clientFor] { defaults.removeObject(forKey: k) }
            defaults.set(server, forKey: K.server)
        }
        email = Keychain.read(K.refresh) == nil ? nil : defaults.string(forKey: K.email)
        accountId = email == nil ? nil : defaults.object(forKey: K.id) as? Int
    }

    // MARK: Signing in and out

    /// Opens the server's sign-in page; returns once the app is signed in (throws if not).
    func signIn() async throws {
        let meta = try await metadata()
        let clientId = try await clientId(meta)
        let verifier = Self.random(48)
        let state = Self.random(16)
        let challenge = Self.b64(Data(SHA256.hash(data: Data(verifier.utf8))))
        var c = URLComponents(string: try meta.string("authorization_endpoint"))!
        c.queryItems = (c.queryItems ?? []) + [
            .init(name: "response_type", value: "code"), .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: Self.redirect), .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "scope", value: "mcp"),
            .init(name: "state", value: state),
        ]
        let answer = try await authenticate(c.url!)
        let q = URLComponents(url: answer, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ n: String) -> String? { q.first { $0.name == n }?.value }
        if let e = item("error") {
            throw Failure(e == "access_denied" ? "Sign-in cancelled." : item("error_description") ?? e)
        }
        guard item("state") == state else { throw Failure("This sign-in was not started here. Try again.") }
        guard let code = item("code") else { throw Failure("The server sent no code.") }
        let tokens = try await postForm(try meta.string("token_endpoint"), [
            "grant_type": "authorization_code", "code": code, "redirect_uri": Self.redirect,
            "client_id": clientId, "code_verifier": verifier,
        ])
        keep(tokens)
        let me = try await pages()
        defaults.set(me.email, forKey: K.email)
        email = me.email
    }

    private func authenticate(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.scheme) { answer, error in
                if let answer { cont.resume(returning: answer); return }
                if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    cont.resume(throwing: Failure("Sign-in cancelled."))
                } else {
                    cont.resume(throwing: error ?? Failure("The sign-in did not finish."))
                }
            }
            s.presentationContextProvider = anchor
            s.prefersEphemeralWebBrowserSession = false   // Safari's sign-in carries over
            session = s
            if !s.start() { cont.resume(throwing: Failure("Could not open the sign-in page.")) }
        }
    }

    /// Signs out: the server forgets the grant (its refresh token is revoked), the app its tokens.
    func signOut() async {
        let refresh = Keychain.read(K.refresh)
        clear()
        guard let refresh, let meta = try? await metadata(), let revoke = meta["revocation_endpoint"] as? String else { return }
        _ = try? await postForm(revoke, ["token": refresh, "client_id": defaults.string(forKey: K.client) ?? ""])
    }

    private func clear() {
        Keychain.delete(K.refresh)
        defaults.removeObject(forKey: K.email)
        defaults.removeObject(forKey: K.id)
        accountId = nil
        access = nil
        accessExpires = .distantPast
        email = nil
    }

    // MARK: The account's pages and the stream

    /// The signed-in account's published pages, newest first (deploy/pages.json).
    func pages() async throws -> MyPages {
        let body = try JSON.object(try await authorized("GET", "\(server)/deploy/pages.json"))
        let account = body["account"] as? [String: Any] ?? [:]
        if let id = account["id"] as? Int { defaults.set(id, forKey: K.id); accountId = id }
        let list = body["pages"] as? [[String: Any]] ?? []
        return MyPages(email: account["email"] as? String ?? "", name: (account["name"] as? String).nonEmpty,
                       pages: list.map { p in
                           let st = p["stream"] as? [String: Any]
                           return PublishedPage(json: p, stream: st.map {
                               StreamEntry(title: $0["title"] as? String ?? "", tags: $0["tags"] as? [String] ?? [], score: $0["score"] as? Int ?? 0)
                           })
                       })
    }

    /// The public stream (stream/items.json): newest or top first, only `tag`'s items, matching
    /// `query`'s words. Signed in, each item carries this account's vote.
    func stream(sort: String, tag: String?, query: String) async throws -> StreamPage {
        var c = URLComponents(string: "\(server)/examples/stream/items.json")!
        c.queryItems = [.init(name: "sort", value: sort)]
        if let tag { c.queryItems!.append(.init(name: "tag", value: tag)) }
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { c.queryItems!.append(.init(name: "q", value: q)) }
        let url = c.url!.absoluteString
        let data: Data
        if email == nil { data = try await request("GET", url) }
        else {
            do { data = try await authorized("GET", url) } catch is SignedOut { data = try await request("GET", url) }
        }
        let body = try JSON.object(data)
        let items = (body["items"] as? [[String: Any]] ?? []).map(StreamItem.init(json:))
        let tags = (body["tags"] as? [[String: Any]] ?? []).compactMap { $0["tag"] as? String }
        return StreamPage(items: items, tags: tags)
    }

    /// Votes on a stream item: 1, -1, or 0 to take the vote back. Returns its new tally.
    func vote(_ pageId: String, _ value: Int) async throws -> Vote {
        let j = try JSON.object(try await authorized("POST", "\(server)/examples/stream/\(pageId)/vote", form: ["value": "\(value)"]))
        return Vote(score: j["score"] as? Int ?? 0, ups: j["ups"] as? Int ?? 0, downs: j["downs"] as? Int ?? 0, myVote: j["my_vote"] as? Int ?? 0)
    }

    /// Posts one of the account's pages to the stream, or renames and retags it: `tags` as "a, b".
    /// `name`, when given, becomes the account's public name first (posting needs one).
    func postToStream(_ pageId: String, title: String, tags: String, name: String?) async throws {
        var form = ["title": title, "tags": tags]
        if let name { form["name"] = name }
        _ = try await authorized("POST", "\(server)/examples/stream/\(pageId)/post", form: form)
    }

    /// Takes one of the account's pages out of the stream (its votes go too).
    func removeFromStream(_ pageId: String) async throws {
        _ = try await authorized("POST", "\(server)/examples/stream/\(pageId)/remove", form: [:])
    }

    // MARK: Reporting, blocking, deleting the account

    /// Why an item is reported: the server's REPORT_REASONS (lib/accounts.mjs), in its order.
    static let reportReasons: [(key: String, label: String)] = [
        ("offensive", "Offensive or hateful"), ("sexual", "Sexual content"), ("violent", "Violent or dangerous"),
        ("spam", "Spam or misleading"), ("illegal", "Illegal, or someone else's work"), ("other", "Something else"),
    ]

    /// Reports someone else's stream item (a `reportReasons` key, an optional note): it leaves this account's stream.
    func report(_ pageId: String, reason: String, note: String) async throws {
        _ = try await authorized("POST", "\(server)/examples/stream/\(pageId)/report", form: ["reason": reason, "note": note])
    }

    /// Hides an author's stream items from this account (`unblock` shows them again).
    func block(_ authorId: Int) async throws {
        _ = try await authorized("POST", "\(server)/examples/stream/authors/\(authorId)/block", form: [:])
    }

    func unblock(_ authorId: Int) async throws {
        _ = try await authorized("POST", "\(server)/examples/stream/authors/\(authorId)/unblock", form: [:])
    }

    /// The authors this account blocked.
    func blocked() async throws -> [BlockedAuthor] {
        let j = try JSON.object(try await authorized("GET", "\(server)/examples/stream/blocked.json"))
        return (j["blocked"] as? [[String: Any]] ?? []).compactMap { b in
            (b["id"] as? Int).map { BlockedAuthor(id: $0, name: (b["name"] as? String).nonEmpty ?? "Someone") }
        }
    }

    /// Deletes the account on the server, for good: its pages, stream items, libraries, uploads
    /// and tokens (the person confirmed first). Then the app forgets it.
    func deleteAccount() async throws {
        _ = try await authorized("POST", "\(server)/account/me/delete", form: ["confirm": "delete"])
        clear()
    }

    // MARK: Tokens

    private func keep(_ t: [String: Any]) {
        access = t["access_token"] as? String
        accessExpires = Date().addingTimeInterval(TimeInterval(t["expires_in"] as? Int ?? 3600) - 60)
        if let r = t["refresh_token"] as? String, !r.isEmpty { Keychain.write(K.refresh, r) }
    }

    private func accessToken(forceRefresh: Bool = false) async throws -> String {
        if !forceRefresh, let access, Date() < accessExpires { return access }
        guard let refresh = Keychain.read(K.refresh) else { throw SignedOut() }
        let meta = try await metadata()
        let t: [String: Any]
        do {
            t = try await postForm(try meta.string("token_endpoint"),
                                   ["grant_type": "refresh_token", "refresh_token": refresh, "client_id": try await clientId(meta)])
        } catch let e as HTTPError where e.status == 400 || e.status == 401 {
            clear()   // expired or revoked: sign in again
            throw SignedOut()
        }
        keep(t)
        guard let a = access else { throw SignedOut() }
        return a
    }

    /// A request with the access token; refused once, refreshed and tried again.
    private func authorized(_ method: String, _ url: String, form: [String: String]? = nil) async throws -> Data {
        do {
            return try await request(method, url, form: form, bearer: try await accessToken())
        } catch let e as HTTPError where e.status == 401 {
            do {
                return try await request(method, url, form: form, bearer: try await accessToken(forceRefresh: true))
            } catch let e as HTTPError where e.status == 401 {
                clear()
                throw SignedOut()
            }
        }
    }

    // MARK: The server

    private func metadata() async throws -> [String: Any] {
        if let m = metadataCache { return m }
        let m = try JSON.object(try await request("GET", "\(server)/.well-known/oauth-authorization-server"))
        metadataCache = m
        return m
    }

    /// This app's client id on the server, registered the first time.
    private func clientId(_ meta: [String: Any]) async throws -> String {
        if let id = defaults.string(forKey: K.client), defaults.string(forKey: K.clientFor) == server { return id }
        let reg: [String: Any] = [
            "client_name": "Kobento showcases (iOS)", "redirect_uris": [Self.redirect],
            "grant_types": ["authorization_code", "refresh_token"], "token_endpoint_auth_method": "none",
        ]
        let body = try JSONSerialization.data(withJSONObject: reg)
        let j = try JSON.object(try await request("POST", try meta.string("registration_endpoint"), body: body, type: "application/json"))
        let id = try j.string("client_id")
        defaults.set(id, forKey: K.client)
        defaults.set(server, forKey: K.clientFor)
        return id
    }

    private func postForm(_ url: String, _ form: [String: String]) async throws -> [String: Any] {
        try JSON.object(try await request("POST", url, form: form))
    }

    private func request(_ method: String, _ url: String, form: [String: String]? = nil, body: Data? = nil,
                         type: String? = nil, bearer: String? = nil) async throws -> Data {
        guard let u = URL(string: url) else { throw Failure("Bad address: \(url)") }
        var r = URLRequest(url: u, timeoutInterval: 20)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer { r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let form {
            r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            r.httpBody = Data(form.map { "\(Self.enc($0.key))=\(Self.enc($0.value))" }.joined(separator: "&").utf8)
        } else if let body {
            r.setValue(type, forHTTPHeaderField: "Content-Type")
            r.httpBody = body
        }
        let (data, response) = try await URLSession.shared.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            let j = (try? JSON.object(data)) ?? [:]
            let why = (j["error_description"] as? String).nonEmpty ?? (j["error"] as? String).nonEmpty
            throw HTTPError(status: status, message: why ?? "HTTP \(status)")
        }
        return data
    }

    private enum K {
        static let server = "tokens_server"   // the server the saved sign-in belongs to
        static let client = "client_id"
        static let clientFor = "client_server"
        static let email = "email"
        static let id = "account_id"
        static let refresh = "refresh"
    }

    private static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }

    private static func b64(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func random(_ n: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: n)
        _ = SecRandomCopyBytes(kSecRandomDefault, n, &bytes)
        return b64(Data(bytes))
    }
}

/// Where the sign-in sheet is presented: the app's key window.
private final class WindowAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

/// The refresh token, in the Keychain (this device only, after the first unlock).
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Account.scheme, kSecAttrAccount as String: key]
    }

    static func read(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        delete(key)
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func delete(_ key: String) { SecItemDelete(query(key) as CFDictionary) }
}

struct Failure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct HTTPError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

struct SignedOut: LocalizedError {
    var errorDescription: String? { "Signed out: sign in again." }
}

enum JSON {
    static func object(_ data: Data) throws -> [String: Any] {
        guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure("The server's answer is not JSON.") }
        return o
    }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ k: String) throws -> String {
        guard let s = self[k] as? String else { throw Failure("The server's answer has no \(k).") }
        return s
    }
}

extension Optional where Wrapped == String {
    /// nil for nil, "" and "null".
    var nonEmpty: String? { flatMap { $0.isEmpty || $0 == "null" ? nil : $0 } }
}
