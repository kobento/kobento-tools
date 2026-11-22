import SwiftUI

/// A showcase playing: its looks, its details, and the document in the frame its form wants.
struct PlayerScreen: View {
    let showcase: Showcase
    @State private var look = Launch.showcase != nil ? Launch.look ?? .auto : .auto
    @State private var info = Launch.showcase != nil && Launch.info
    @State private var nav = NavigatorBridge()
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let bytes = showcase.bytes(look)
        VStack(alignment: .leading, spacing: 0) {
            if info { Details(showcase: showcase, bytes: bytes.count).transition(.opacity) }
            LookChips(looks: showcase.looks, look: $look)
            DocumentFrame(formFactor: showcase.formFactor) {
                // Each look is its own document, or the same one in another theme.
                PlayerView(bytes: bytes, dark: look.dark(systemDark: scheme == .dark), nav: nav).id(look)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigatorBack(nav)
        .toolbar {
            ToolbarItem(placement: .principal) { TitleBlock(title: showcase.name, subtitle: showcase.id) }
            ToolbarItem(placement: .topBarTrailing) {
                Button { withAnimation { info.toggle() } } label: {
                    Image(systemName: info ? "info.circle.fill" : "info.circle")
                }.accessibilityLabel(info ? "Hide details" : "Details")
            }
        }
    }
}

struct TitleBlock: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 0) {
            Text(title).font(.headline).lineLimit(1)
            Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

/// The looks to choose from, as a row of chips.
struct LookChips: View {
    let looks: [Look]
    @Binding var look: Look

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(looks) { l in Chip(label: l.rawValue, selected: l == look) { look = l } }
            }
            .padding(.horizontal, 16).padding(.vertical, 6)
        }
    }
}

struct Chip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label).font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(selected ? Color.accentColor.opacity(0.18) : Color.clear, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? Color.accentColor : Color(.separator)))
                .foregroundStyle(selected ? Color.accentColor : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The document at the size its form factor wants: a phone or tablet fills the space and lays
/// out to it; a watch is a circle, a square a square, a 4×1 widget a band.
struct DocumentFrame<Content: View>: View {
    let formFactor: String
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            Group {
                switch formFactor {
                case "watch-round": content.frame(width: side * 0.9, height: side * 0.9).clipShape(Circle())
                case "square": content.frame(width: side, height: side).clipShape(RoundedRectangle(cornerRadius: 12))
                case "widget-4x1": content.frame(width: g.size.width, height: g.size.width / 4).clipShape(RoundedRectangle(cornerRadius: 16))
                default: content.clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .padding(12)
    }
}

/// Size and shape of the document, what it shows off, then what it is.
private struct Details: View {
    let showcase: Showcase
    let bytes: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FlowLayout(spacing: 20, lineSpacing: 8) {
                Fact(label: "Size", value: formatBytes(bytes))
                if showcase.opCount > 0 { Fact(label: "Operations", value: showcase.opCount.formatted()) }
                if showcase.designWidth > 0 { Fact(label: "Designed at", value: "\(showcase.designWidth) × \(showcase.designHeight) dp") }
                Fact(label: "Form", value: forms[showcase.formFactor] ?? showcase.formFactor)
                if let r = showcase.repaint { Fact(label: "Repaints", value: repaints[r] ?? r) }
            }
            if !showcase.capabilities.isEmpty {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(showcase.capabilities, id: \.self) { c in
                        Text(c).font(.caption.weight(.medium))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
            Text(showcase.summary).font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16).padding(.vertical, 4)
    }
}

struct Fact: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.semibold))
        }
    }
}

/// Lays its children out left to right, wrapping to a new line when the width runs out.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(s))
                x += s.width + spacing
            }
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0; var y: CGFloat = 0 }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows = [Row()]
        for i in subviews.indices {
            let s = subviews[i].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].items.isEmpty && rows[rows.count - 1].width + spacing + s.width > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + lineSpacing))
            }
            var r = rows[rows.count - 1]
            r.width += (r.items.isEmpty ? 0 : spacing) + s.width
            r.height = max(r.height, s.height)
            r.items.append(i)
            rows[rows.count - 1] = r
        }
        return rows
    }
}
