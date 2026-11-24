import SwiftUI

/// A published page to play: the account's own (it can share it), or a stream item.
struct OpenPage: Hashable {
    let page: PublishedPage
    let subtitle: String
    let own: Bool
}

/// The public stream: search, newest or top, a tag; tap an item to play it, vote on it signed in.
struct StreamTab: View {
    @Environment(AppModel.self) private var model
    @State private var reporting: StreamItem?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Documents people made with Kobento and chose to share."
                         + (model.account.email == nil ? " Sign in to vote." : ""))
                        .font(.subheadline).foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            Chip(label: "Newest", selected: model.sort == "new") { model.sort = "new" }
                            Chip(label: "Top", selected: model.sort == "top") { model.sort = "top" }
                            Divider().frame(height: 20).padding(.horizontal, 4)
                            Chip(label: "All", selected: model.tag == nil) { model.tag = nil }
                            // The tag filtering stays shown even when it is not among the most used.
                            let shown = model.tag.map { t in model.streamTags.contains(t) ? model.streamTags : [t] + model.streamTags } ?? model.streamTags
                            ForEach(shown, id: \.self) { t in
                                Chip(label: "#\(t)", selected: model.tag == t) { model.tag = model.tag == t ? nil : t }
                            }
                        }
                    }
                    if let e = model.streamError {
                        HStack {
                            Text(e).font(.caption).foregroundStyle(.red)
                            Spacer()
                            Button("Try again") { Task { await model.loadStream(force: true) } }.font(.caption)
                        }
                    }
                    if let items = model.streamItems {
                        if items.isEmpty {
                            Text(model.query.isEmpty && model.tag == nil ? "Nothing in the stream yet." : "Nothing matches.")
                                .font(.subheadline).foregroundStyle(.secondary).padding(.top, 8)
                        }
                        CardGrid {
                            ForEach(items) { item in
                                // Report and Block: not on the account's own items.
                                let others = model.account.accountId == nil || item.authorId != model.account.accountId
                                StreamCard(item: item, onVote: { model.vote(item, $0) },
                                           onReport: others ? { if model.account.email == nil { model.signIn() } else { reporting = item } } : nil,
                                           onBlock: others && item.authorId != nil ? { model.block(item) } : nil)
                            }
                        }
                    } else if model.streamLoading {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(16)
            }
            .navigationTitle("Stream")
            .searchable(text: $model.query, prompt: "Search titles, people, tags")
            .refreshable { await model.loadStream(force: true) }
            .toolbar { if model.streamLoading && model.streamItems != nil { ProgressView() } }
            // Loads for the filters as they are; typing waits a moment before it asks.
            .task(id: "\(model.sort)|\(model.tag ?? "")|\(model.query)|\(model.account.email ?? "")") {
                if !model.query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
                guard !Task.isCancelled else { return }
                await model.loadStream()
            }
            .navigationDestination(for: OpenPage.self) { PagePlayerScreen(open: $0) }
            .navigationDestination(for: OpenApp.self) { AppPlayerScreen(open: $0) }
            .sheet(item: $reporting) { item in
                ReportSheet(item: item) { reason, note in
                    reporting = nil
                    Task { await model.report(item, reason: reason, note: note) }
                }
            }
            .alert(model.notice ?? "", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
                Button("OK", role: .cancel) {}
            }
        }
    }
}

/// Why the item is reported (the server's reasons), and an optional note.
private struct ReportSheet: View {
    let item: StreamItem
    let onSend: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason: String?
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(Account.reportReasons, id: \.key) { r in
                        Button {
                            reason = r.key
                        } label: {
                            HStack {
                                Text(r.label).foregroundStyle(.primary)
                                Spacer()
                                if reason == r.key { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                        .accessibilityAddTraits(reason == r.key ? .isSelected : [])
                    }
                } header: {
                    Text("Why")
                } footer: {
                    Text("It disappears from your stream now. After several reports it is hidden for everyone until we review it.")
                }
                Section("Anything to add (optional)") {
                    TextField("Note", text: $note, axis: .vertical).lineLimit(1...4)
                        .onChange(of: note) { if note.count > 500 { note = String(note.prefix(500)) } }
                }
            }
            .navigationTitle("Report \u{201C}\(item.title)\u{201D}")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Report") { if let reason { onSend(reason, note.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                        .disabled(reason == nil)
                }
            }
        }
    }
}

struct StreamCard: View {
    let item: StreamItem
    let onVote: (Int) -> Void
    var onReport: (() -> Void)?
    var onBlock: (() -> Void)?

    private var card: some View {
                Card {
                    RemoteImage(url: item.page.previewUrl)
                        .overlay(alignment: .topLeading) {
                            if item.showcase {
                                Text("Showcase").font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(Color.accentColor.opacity(0.2), in: RoundedRectangle(cornerRadius: 6))
                            }
                        }
                } caption: {
                    Text(item.title).font(.subheadline.weight(.semibold)).lineLimit(2, reservesSpace: true)
                    Text("by \(item.author)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if !item.tags.isEmpty {
                        Text(item.tags.map { "#\($0)" }.joined(separator: "  ")).font(.caption).foregroundStyle(Color.accentColor).lineLimit(1)
                    }
                }
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                // An app plays screen by screen; a page in the page player.
                if item.isApp, let link = item.page.url {
                    NavigationLink(value: OpenApp(link: link, title: item.title)) { card }
                } else {
                    NavigationLink(value: OpenPage(page: item.page, subtitle: "by \(item.author)", own: false)) { card }
                }
            }
            .buttonStyle(.plain)
            HStack(spacing: 4) {
                VoteButton(systemImage: "arrowtriangle.up.fill", label: "Vote up", on: item.myVote == 1, color: .green) { onVote(1) }
                Text("\(item.score)").font(.subheadline.weight(.bold)).monospacedDigit()
                VoteButton(systemImage: "arrowtriangle.down.fill", label: "Vote down", on: item.myVote == -1, color: .red) { onVote(-1) }
                Text("+\(item.ups) / −\(item.downs)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 0)
                if onReport != nil || onBlock != nil {
                    Menu {
                        if let onReport { Button("Report…", systemImage: "flag", action: onReport) }
                        if let onBlock { Button("Block \(item.author)", systemImage: "hand.raised", role: .destructive, action: onBlock) }
                    } label: {
                        Image(systemName: "ellipsis").font(.body).foregroundStyle(.secondary).frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Report or block")
                }
            }
            .padding(.horizontal, 6).padding(.bottom, 4)
            .background(Color(.secondarySystemBackground))
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

private struct VoteButton: View {
    let systemImage: String
    let label: String
    let on: Bool
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.body).foregroundStyle(on ? color : Color.secondary)
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(on ? "\(label) (tap again to take it back)" : label)
    }
}

/// A published page's preview, downloaded (nothing while it loads or when there is none).
struct RemoteImage: View {
    let url: URL?

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image { image.resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 6)) }
        }
    }
}
