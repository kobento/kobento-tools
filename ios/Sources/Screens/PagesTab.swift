import SwiftUI

/// The account's own pages: sign in, then the pages it published with Kobento's MCP tools.
struct PagesTab: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    AccountRow()
                    if model.account.email == nil {
                        Text("Sign in with your Kobento account to play the pages you published with Kobento's MCP tools, and share them to the stream.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    } else if let pages = model.pages {
                        // Apps: several pages tied together, played screen by screen.
                        if let apps = model.apps, !apps.isEmpty {
                            Text("Apps").font(.headline).padding(.top, 4)
                            ForEach(apps) { a in
                                // The published app, or the draft (the pages as they are now) before it is.
                                if let link = a.link ?? a.draft {
                                    NavigationLink(value: OpenApp(link: link, title: a.title, draft: a.link == nil)) { AppRow(app: a) }
                                        .buttonStyle(.plain)
                                        .accessibilityIdentifier("app-\(a.id)")
                                        .overlay(alignment: .trailing) {
                                            if a.link != nil, let d = a.draft {
                                                NavigationLink("Draft", value: OpenApp(link: d, title: a.title, draft: true))
                                                    .font(.subheadline).padding(.trailing, 36)
                                                    .accessibilityIdentifier("app-draft-\(a.id)")
                                            }
                                        }
                                } else {
                                    AppRow(app: a)
                                }
                            }
                            Text("Pages").font(.headline).padding(.top, 8)
                        }
                        if pages.isEmpty {
                            Text("None published yet. Pages you publish with Kobento's MCP tools appear here.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        CardGrid {
                            ForEach(pages) { p in
                                NavigationLink(value: OpenPage(page: p, subtitle: "Your page", own: true)) { PageCard(page: p) }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("page-\(p.id)")
                            }
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle("Your pages")
            .refreshable { if model.account.email != nil { try? await model.reloadPages() } }
            .navigationDestination(for: OpenPage.self) { PagePlayerScreen(open: $0) }
            .navigationDestination(for: OpenApp.self) { AppPlayerScreen(open: $0) }
        }
        .onAppear {
            // An app to open at launch (-app <link>): tests and screenshots.
            if let link = Launch.app, path.isEmpty {
                DispatchQueue.main.async { path.append(OpenApp(link: link, title: "App")) }
            }
        }
        // An app's link opened from elsewhere (a universal link): play it.
        .onChange(of: model.pendingApp) { _, open in
            guard let open else { return }
            model.pendingApp = nil
            path.append(open)
        }
    }
}

/// An app in the list: its name and screens; one not published yet cannot be played here.
private struct AppRow: View {
    let app: MyApp

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(app.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("\(app.screens) screen\(app.screens == 1 ? "" : "s") · " + (app.link == nil ? "draft, not published yet" : "version \(app.version)"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if app.link != nil || app.draft != nil { Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .contentShape(Rectangle())
    }
}

/// Sign in, or who is signed in (refresh, sign out); a sign-in error under it.
private struct AccountRow: View {
    @Environment(AppModel.self) private var model
    @State private var showBlocked = false
    @State private var confirmDelete = false
    @State private var deleting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(model.account.email.map { "Signed in as \($0)" } ?? "Not signed in")
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer()
                if model.busy {
                    ProgressView()
                } else if model.account.email == nil {
                    Button("Sign in") { model.signIn() }.buttonStyle(.borderedProminent)
                } else {
                    Button("Refresh") { model.refreshPages() }
                    Button("Sign out") { model.signOut() }
                }
            }
            if let e = model.error { Text(e).font(.caption).foregroundStyle(.red) }
            if let email = model.account.email {
                HStack {
                    Spacer()
                    Button("People you blocked") { showBlocked = true }
                    Button("Delete account", role: .destructive) { confirmDelete = true }.disabled(deleting)
                }
                .font(.subheadline)
                .sheet(isPresented: $showBlocked) { BlockedSheet() }
                .alert("Delete your account?", isPresented: $confirmDelete) {
                    Button("Delete my account", role: .destructive) {
                        deleting = true
                        model.run { defer { deleting = false }; try await model.deleteAccount() }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This deletes \(email) on Kobento for good, right away: every page you published (their links stop working), your items in the stream with their votes, your libraries, uploads and session history, and your sign-ins on every device. It cannot be undone.")
                }
            }
        }
    }
}

/// The authors this account blocked in the stream, each with Unblock.
private struct BlockedSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var list: [BlockedAuthor]?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.red) }
                if let list {
                    if list.isEmpty { Text("Nobody. In the stream, an item's ⋯ menu has Block: their items no longer show.").foregroundStyle(.secondary) }
                    ForEach(list) { b in
                        HStack {
                            Text(b.name).lineLimit(1)
                            Spacer()
                            Button("Unblock") {
                                Task {
                                    do { try await model.unblock(b.id); self.list = self.list?.filter { $0.id != b.id } }
                                    catch { self.error = error.localizedDescription }
                                }
                            }
                        }
                    }
                } else if error == nil {
                    ProgressView()
                }
            }
            .navigationTitle("People you blocked")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                do { list = try await model.account.blocked() } catch { self.error = error.localizedDescription }
            }
        }
    }
}

private struct PageCard: View {
    let page: PublishedPage

    var body: some View {
        Card {
            RemoteImage(url: page.previewUrl)
        } caption: {
            Text(page.title).font(.subheadline.weight(.semibold)).lineLimit(2)
            Text([String(page.created.prefix(10)), page.rcBytes > 0 ? formatBytes(page.rcBytes) : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if let s = page.stream {
                Text("In the stream · score \(s.score)").font(.caption).foregroundStyle(Color.accentColor).lineLimit(1)
            }
        }
    }
}
