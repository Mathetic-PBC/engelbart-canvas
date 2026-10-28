import SwiftUI
import EngelbartUI
import EngelbartBuild

/// A line of text at a CSS size and line height (`font: <weight> <size>/<lh>`).
struct CSSText: View {
    let text: String
    var size: CGFloat
    var weight: Int = 400
    var lh: CGFloat = 1.5
    var color: Color = .pInk
    var lines: Int? = 1
    init(_ text: String, _ size: CGFloat, _ weight: Int = 400, lh: CGFloat = 1.5, color: Color = .pInk, lines: Int? = 1) {
        self.text = text; self.size = size; self.weight = weight; self.lh = lh; self.color = color; self.lines = lines
    }
    var body: some View {
        let font = Fonts.sans(size, weight: weight)
        let natural = ceil(font.ascender - font.descender + font.leading)
        Text(text)
            .font(Font(font))
            .foregroundColor(color)
            .lineLimit(lines)
            .truncationMode(.tail)
            .lineSpacing(max(0, size * lh - natural))
            .padding(.vertical, max(0, (size * lh - natural) / 2))
    }
}

/// ⌃ / ⌄ in a 14 px box (ModelGrid.jsx Caret).
struct Caret: View {
    let up: Bool
    var body: some View {
        Text(up ? "⌃" : "⌄").font(Font(Fonts.sans(11))).foregroundColor(.pFnt)
            .offset(y: up ? 1 : -3)
            .frame(width: 14, height: 14)
    }
}

/// The radio of a grid row: 14 px, ink with a white ✓ when on, #c9c9c9 ring otherwise.
struct Radio: View {
    let on: Bool
    var body: some View {
        ZStack {
            Circle().fill(on ? Color.pInk : Color.clear)
            Circle().strokeBorder(on ? Color.pInk : Color.pBd2, lineWidth: 1.5)
            if on { Text("✓").font(Font(Fonts.sans(9, weight: 600))).foregroundColor(.white) }
        }.frame(width: 14, height: 14)
    }
}

/// A grid row: radio, name, what trails it. `lit` washes it (#f2f2f2, or white in the effort column).
struct GridRow<Trailing: View>: View {
    enum Lit { case none, wash, white }
    let on: Bool
    let lit: Lit
    var hoverWash = true
    let name: String
    let onPick: () -> Void
    var onEnter: (() -> Void)? = nil
    @ViewBuilder var trailing: () -> Trailing
    @State private var over = false
    var body: some View {
        HStack(spacing: 10) {
            Radio(on: on)
            CSSText(name, 13, on ? 500 : 400, lh: 1.4).frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.vertical, 8).padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 6).fill(lit == .white ? Color.white : (lit == .wash || (hoverWash && over)) ? Color.pHov : Color.clear))
        .contentShape(Rectangle())
        .onHover { inside in over = inside; if inside { onEnter?() } }
        .onTapGesture { onPick() }
        .animation(.easeInOut(duration: 0.12), value: over)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
    }
}

/// The model and effort grid of a post-it's Build popup and of its "Needs you" card (ModelGrid.jsx; the @bart selector's
/// black and white, drawn as Claude Design "Post-it Quick Task" draws it): the provider field and the models on the left,
/// the efforts of the model under the pointer on the right. Each model keeps the effort it was last given here.
struct ModelGridView: View {
    let models: BuildChoices
    let choice: ModelChoice
    var efforts: [String: String] = [:]
    let onChoose: (ModelChoice) -> Void
    @State private var viewed: String?
    @State private var preview: String?
    @State private var listing = false

    var provider: String { viewed.flatMap { models.entry($0) != nil ? $0 : nil } ?? choice.provider }
    var entry: BuildChoices.Provider { models.entry(provider) ?? models.providers[0].provider }
    var shown: String { let p = preview ?? choice.model; return entry.model(p) != nil ? p : entry.models[0].key }
    var markedEffort: String { shown == choice.model ? choice.effort : ModelPick.effortFor(models, shown, efforts: efforts) }

    static func head(_ text: String) -> some View {
        Text(text.uppercased()).font(Font(Fonts.sans(9, weight: 500))).kerning(1.6).foregroundColor(.pFnt)
            .padding(EdgeInsets(top: 6, leading: 10, bottom: 8, trailing: 10))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                providerField.padding(.bottom, 6)
                Self.head("Model")
                VStack(spacing: 2) {
                    ForEach(entry.models, id: \.key) { item in
                        GridRow(on: provider == choice.provider && item.key == choice.model, lit: item.key == shown ? .wash : .none, hoverWash: false,
                                name: item.model.name, onPick: { onChoose(ModelChoice(provider: provider, model: item.key, effort: ModelPick.effortFor(models, item.key, efforts: efforts))) },
                                onEnter: { preview = item.key }) {
                            Text("›").font(Font(Fonts.sans(12))).foregroundColor(.pBd2).frame(width: 14)
                        }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            Rectangle().fill(Color.pBd).frame(width: 1).frame(maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 2) {
                Self.head("Effort · \(entry.model(shown)?.name ?? "")")
                VStack(spacing: 2) {
                    ForEach(entry.efforts, id: \.self) { effort in
                        GridRow(on: effort == markedEffort, lit: effort == markedEffort ? .white : .none, name: EffortLabels.label(effort),
                                onPick: { onChoose(ModelChoice(provider: provider, model: shown, effort: effort)) }) { EmptyView() }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.pTint)
        }
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: choice) { _, _ in viewed = nil; preview = nil }
        .driveID("model-grid")
    }

    var providerField: some View {
        Button { if models.providers.count > 1 { listing.toggle() } } label: {
            HStack(spacing: 8) {
                CSSText(entry.name, 12.5, 500, lh: 1.2).frame(maxWidth: .infinity, alignment: .leading)
                if models.providers.count > 1 { Caret(up: listing) }
            }
            .padding(.vertical, 7).padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.pTint))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(listing ? Color.pBd2 : Color.pBd, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Provider")
        .floatingPanel(isPresented: $listing, options: FloatingOptions(side: .below, gap: 4, card: false, rise: 0.12, takesKey: false, dismissible: false)) {
            VStack(spacing: 0) {
                ForEach(models.providers, id: \.key) { item in
                    GridRow(on: item.key == provider, lit: item.key == provider ? .wash : .none, name: item.provider.name,
                            onPick: { viewed = item.key; preview = item.provider.models.first?.key; listing = false }) { EmptyView() }
                }
            }
            .padding(4)
            .frame(width: (420 - 1) / 2 - 16)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.pBd, lineWidth: 1))
        }
    }
}
