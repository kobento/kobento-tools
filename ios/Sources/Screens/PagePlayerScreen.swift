import SwiftUI

/// A published page playing (the account's own, or one from the stream): its document
/// downloaded and played like a showcase. The account's own pages can be shared to the stream.
struct PagePlayerScreen: View {
    let open: OpenPage
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    @State private var look = Look.auto
    @State private var info = false
    @State private var nav = NavigatorBridge()
    @State private var sharing = false
    @State private var bytes: Result<Data, Error>?
    @State private var attempt = 0

    private var page: PublishedPage { open.own ? model.current(open.page) : open.page }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if info {
                VStack(alignment: .leading, spacing: 6) {
                    FlowLayout(spacing: 20, lineSpacing: 8) {
                        if case .success(let d) = bytes { Fact(label: "Size", value: formatBytes(d.count)) }
                        if page.width > 0 { Fact(label: "Designed at", value: "\(page.width) × \(page.height) dp") }
                        if page.created.count >= 10 { Fact(label: "Published", value: String(page.created.prefix(10))) }
                        if let s = page.stream { Fact(label: "In the stream", value: "score \(s.score)") }
                    }
                    if let url = page.url { Button("Open the web page") { openURL(url) }.font(.subheadline) }
                }
                .padding(.horizontal, 16).padding(.vertical, 4)
            }
            LookChips(looks: Look.page, look: $look)
            switch bytes {
            case nil:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failure(let e):
                VStack(spacing: 8) {
                    Text("Could not load this page").font(.headline)
                    Text(e.localizedDescription).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { bytes = nil; attempt += 1 }
                }
                .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .success(let d):
                DocumentFrame(formFactor: "phone") {
                    PlayerView(bytes: d, dark: look.dark(systemDark: scheme == .dark), nav: nav).id(look)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigatorBack(nav)
        .toolbar {
            ToolbarItem(placement: .principal) { TitleBlock(title: page.title, subtitle: open.subtitle) }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if open.own && model.account.email != nil {
                    Button { sharing = true } label: { Image(systemName: page.stream == nil ? "square.and.arrow.up" : "square.and.arrow.up.fill") }
                        .accessibilityLabel(page.stream == nil ? "Share to the stream" : "Edit or take out of the stream")
                }
                Button { withAnimation { info.toggle() } } label: { Image(systemName: info ? "info.circle.fill" : "info.circle") }
                    .accessibilityLabel(info ? "Hide details" : "Details")
            }
        }
        .sheet(isPresented: $sharing) { ShareSheet(page: page) }
        .task(id: attempt) {
            guard let url = page.rcUrl else { bytes = .failure(Failure("This page has no document.")); return }
            do { bytes = .success(try await download(url)) } catch { bytes = .failure(error) }
        }
    }
}

/// Post a page to the stream, or rename, retag or take it out.
private struct ShareSheet: View {
    let page: PublishedPage
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var title = ""
    @State private var tags = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let entry = page.stream
        let needsName = model.name == nil
        NavigationStack {
            Form {
                Section {
                    Text(entry == nil
                         ? "Everyone can open it from the stream and vote on it. The page itself stays where it is."
                         : "Score \(entry!.score). Rename or retag it, or take it out (its votes go too).")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if needsName {
                    Section {
                        TextField("Your name", text: $name).textContentType(.name)
                    } footer: { Text("Shown with what you post") }
                }
                Section {
                    TextField("Name in the stream", text: $title)
                } header: { Text("Name in the stream") }
                Section {
                    TextField("Tags", text: $tags).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Tags") } footer: { Text("A few words, with commas: game, physics") }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                if entry != nil {
                    Section {
                        Button("Take out of the stream", role: .destructive) {
                            act { try await model.unshare(page) }
                        }
                    }
                }
            }
            .navigationTitle(entry == nil ? "Share to the stream" : "In the stream")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button(entry == nil ? "Share" : "Save") {
                            let t = title.trimmingCharacters(in: .whitespaces)
                            let n = needsName ? name.trimmingCharacters(in: .whitespaces) : nil
                            act { try await model.share(page, title: t, tags: tags, name: n) }
                        }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty
                                  || (needsName && name.trimmingCharacters(in: .whitespaces).isEmpty))
                    }
                }
            }
            .onAppear {
                title = entry?.title ?? page.title
                tags = entry?.tags.joined(separator: ", ") ?? ""
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func act(_ step: @escaping () async throws -> Void) {
        Task {
            busy = true
            error = nil
            do { try await step(); dismiss() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}
