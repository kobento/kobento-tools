import Foundation
import Observation

/// The app's state across its tabs: the account and its pages, and the stream as last loaded.
@MainActor @Observable
final class AppModel {
    let account = Account()
    let showcases = Showcases.load()

    // Your pages
    var pages: [PublishedPage]?
    /// The account's apps (several pages tied together), or nil until listed.
    var apps: [MyApp]?
    /// An app's link the app was opened with (a universal link), for Your pages to play.
    var pendingApp: OpenApp?
    /// The account's public name (the stream shows it with what it posts), or nil.
    var name: String?
    var busy = false
    var error: String?

    // The stream
    var sort = "new"
    var tag: String?
    var query = ""
    var streamItems: [StreamItem]?
    var streamTags: [String] = []
    var streamLoading = false
    var streamError: String?
    private var streamLoadedFor: String?

    /// Runs one account step with the spinner and the error line.
    func run(_ step: @escaping () async throws -> Void) {
        Task {
            busy = true
            error = nil
            do { try await step() } catch is SignedOut {
                pages = nil
                error = SignedOut().errorDescription
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    func signIn() {
        run {
            try await self.account.signIn()
            try await self.reloadPages()
            self.streamLoadedFor = nil   // the votes are the account's now
        }
    }

    func signOut() {
        run {
            await self.account.signOut()
            self.pages = nil
            self.apps = nil
            self.name = nil
            self.streamLoadedFor = nil
        }
    }

    func refreshPages() { run { try await self.reloadPages() } }

    func reloadPages() async throws {
        let mine = try await account.pages()
        pages = mine.pages
        name = mine.name
        // An older server has no apps: the pages still show.
        apps = (try? await account.apps()) ?? []
    }

    /// Loads the pages once when the app starts signed in.
    func start() {
        if account.email != nil && pages == nil { refreshPages() }
    }

    // MARK: Stream

    private var streamKey: String { "\(sort)|\(tag ?? "")|\(query.trimmingCharacters(in: .whitespaces))|\(account.email ?? "")" }

    /// Loads the stream for the current filters, unless that is what is shown already.
    func loadStream(force: Bool = false) async {
        let key = streamKey
        if !force && key == streamLoadedFor { return }
        streamLoading = true
        defer { streamLoading = false }
        do {
            let page = try await account.stream(sort: sort, tag: tag, query: query)
            guard key == streamKey else { return }   // the filters moved on meanwhile
            streamItems = page.items
            streamTags = page.tags
            streamError = nil
            streamLoadedFor = key
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            streamError = error.localizedDescription
        }
    }

    /// Votes 1 or -1 (the same vote again takes it back). Signed out, it signs in first.
    func vote(_ item: StreamItem, _ value: Int) {
        guard account.email != nil else { signIn(); return }
        let v = item.myVote == value ? 0 : value
        Task {
            do {
                let t = try await account.vote(item.id, v)
                streamItems = streamItems?.map { i in
                    guard i.id == item.id else { return i }
                    var n = i
                    n.score = t.score; n.ups = t.ups; n.downs = t.downs; n.myVote = t.myVote
                    return n
                }
            } catch {
                streamError = error.localizedDescription
            }
        }
    }

    // MARK: Reporting and blocking (store rules for shared content)

    /// A note to show once (after a report or a block).
    var notice: String?

    /// Reports an item: it leaves this list at once; the server keeps it out of the next loads.
    func report(_ item: StreamItem, reason: String, note: String) async {
        do {
            try await account.report(item.id, reason: reason, note: note)
            streamItems = streamItems?.filter { $0.id != item.id }
            notice = "Thanks. \u{201C}\(item.title)\u{201D} is hidden for you, and we will review it."
        } catch {
            streamError = error.localizedDescription
        }
    }

    /// Blocks an item's author: their items leave this list, and the next loads.
    func block(_ item: StreamItem) {
        guard let author = item.authorId else { return }
        guard account.email != nil else { signIn(); return }
        Task {
            do {
                try await account.block(author)
                streamItems = streamItems?.filter { $0.authorId != author }
                notice = "Blocked \(item.author). You no longer see their items. Unblock them from Your pages."
            } catch {
                streamError = error.localizedDescription
            }
        }
    }

    func unblock(_ id: Int) async throws {
        try await account.unblock(id)
        streamLoadedFor = nil
    }

    /// Deletes the account on the server for good (the person confirmed), then signs out.
    func deleteAccount() async throws {
        try await account.deleteAccount()
        pages = nil
        name = nil
        streamLoadedFor = nil
    }

    // MARK: Sharing your pages

    func share(_ page: PublishedPage, title: String, tags: String, name: String?) async throws {
        try await account.postToStream(page.id, title: title, tags: tags, name: name)
        try await reloadPages()
        streamLoadedFor = nil
    }

    func unshare(_ page: PublishedPage) async throws {
        try await account.removeFromStream(page.id)
        try await reloadPages()
        streamLoadedFor = nil
    }

    /// The account's page as last listed (its stream entry changes when it is shared).
    func current(_ page: PublishedPage) -> PublishedPage { pages?.first { $0.id == page.id } ?? page }
}
