import Foundation

/// What pages.json returns: who is signed in (and the public name the stream shows), and their pages.
struct MyPages {
    let email: String
    let name: String?
    let pages: [PublishedPage]
}

/// A published page: its web page, its document as an .rc, its preview.
struct PublishedPage: Identifiable, Hashable {
    let id: String
    let title: String
    let url: URL?
    let rcUrl: URL?
    let previewUrl: URL?
    let created: String
    let rcBytes: Int
    let width: Int
    let height: Int
    /// Its entry in the stream, when the account posted it (on the account's own pages only).
    var stream: StreamEntry?

    init(json p: [String: Any], stream: StreamEntry? = nil) {
        let doc = p["document"] as? [String: Any]
        id = p["id"] as? String ?? p["page_id"] as? String ?? ""
        title = (p["title"] as? String).nonEmpty ?? "Untitled"
        url = (p["url"] as? String).flatMap(URL.init(string:))
        rcUrl = (p["rc_url"] as? String).flatMap(URL.init(string:))
        previewUrl = (p["preview_url"] as? String).nonEmpty.flatMap(URL.init(string:))
        created = p["created"] as? String ?? ""
        rcBytes = p["rc_bytes"] as? Int ?? 0
        width = doc?["width"] as? Int ?? 0
        height = doc?["height"] as? Int ?? 0
        self.stream = stream
    }
}

/// A page's entry in the stream: the name it is shown under, its tags and its score.
struct StreamEntry: Hashable {
    let title: String
    let tags: [String]
    let score: Int
}

/// What stream/items.json returns: the items, and the tags in use (the most used first).
struct StreamPage {
    let items: [StreamItem]
    let tags: [String]
}

/// One item of the stream: its name, poster and votes, and the published page it plays.
struct StreamItem: Identifiable, Hashable {
    var id: String { page.id }
    let title: String
    let author: String
    /// The poster's account id (to block them), or nil from an older server.
    let authorId: Int?
    let tags: [String]
    var score: Int
    var ups: Int
    var downs: Int
    /// This account's vote (1, -1, 0), or nil signed out.
    var myVote: Int?
    let showcase: Bool
    /// An app (several screens, played by AppPlayerScreen from page.url), not a page.
    let isApp: Bool
    let page: PublishedPage

    init(json j: [String: Any]) {
        title = (j["title"] as? String).nonEmpty ?? "Untitled"
        author = j["author"] as? String ?? ""
        authorId = j["author_id"] as? Int
        tags = j["tags"] as? [String] ?? []
        score = j["score"] as? Int ?? 0
        ups = j["ups"] as? Int ?? 0
        downs = j["downs"] as? Int ?? 0
        myVote = j["my_vote"] as? Int
        showcase = j["showcase"] as? Bool ?? false
        isApp = j["kind"] as? String == "app"
        page = PublishedPage(json: j)
    }
}

/// An author this account blocked in the stream.
struct BlockedAuthor: Identifiable, Hashable {
    let id: Int
    let name: String
}

/// An item's tally after a vote.
struct Vote {
    let score: Int
    let ups: Int
    let downs: Int
    let myVote: Int
}

/// Downloads a public file (a page's .rc or preview).
func download(_ url: URL) async throws -> Data {
    let (data, response) = try await URLSession.shared.data(from: url)
    if let h = response as? HTTPURLResponse, h.statusCode >= 400 { throw Failure("HTTP \(h.statusCode) for \(url.absoluteString)") }
    return data
}
