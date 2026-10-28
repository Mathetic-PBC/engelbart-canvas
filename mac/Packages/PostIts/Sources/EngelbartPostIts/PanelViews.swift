import SwiftUI
import Combine
import EngelbartUI
import EngelbartDoc

/// The white card the popups draw themselves (no shadow: the CSS has none).
struct PlainCard: ViewModifier {
    var radius: CGFloat = 10
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius).fill(Color.white))
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Color.pBd, lineWidth: 1))
    }
}

/// The 30 px round send (PostItBuild.jsx sendStyle): blue with a white ↑ when ready, grey otherwise.
struct SendButton: View {
    let ready: Bool
    let label: String
    let action: () -> Void
    @State private var over = false
    var body: some View {
        Button(action: { if ready { action() } }) {
            Text("↑").font(Font(Fonts.sans(14, weight: 500))).foregroundColor(ready ? .white : .pFnt)
                .offset(y: -0.5)
                .frame(width: 30, height: 30)
                .background(Circle().fill(ready ? Color.pBlue : Color.pBd))
                .opacity(ready && over ? Motion.hoverOpacity : 1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!ready)
        .onHover { over = $0 }
        .animation(.easeInOut(duration: 0.16), value: ready)
        .accessibilityLabel(label)
    }
}

/// A row that washes #f2f2f2 under the pointer (`hov-wash`).
struct WashRow<Label: View>: View {
    var radius: CGFloat = 6
    let action: () -> Void
    @ViewBuilder var label: () -> Label
    @State private var over = false
    var body: some View {
        Button(action: action) {
            label().contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(RoundedRectangle(cornerRadius: radius).fill(over ? Color.pHov : Color.clear))
        .onHover { over = $0 }
        .animation(.easeInOut(duration: 0.12), value: over)
    }
}

/// A word that goes to ink under the pointer (`hov-ink`): the task card's Stop, Discard and ×.
struct QuietButton: View {
    let text: String
    var size: CGFloat = 13
    var color: Color = .pFnt
    let action: () -> Void
    @State private var over = false
    var body: some View {
        Button(action: action) {
            CSSText(text, size, 500, lh: 1.4, color: over ? .pInk : color)
                .padding(.vertical, 4).padding(.horizontal, 8)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over = $0 }
    }
}

// MARK: - the Build popup

/// A post-it's Build popup (PostItBuild.jsx, 420 wide): the model grid, a rule, the problem if any, and its foot — what is
/// chosen, ⊕ Context, the send.
struct PostItBuildView: View {
    static let WIDTH: CGFloat = 420
    @ObservedObject var model: PostItBuildModel
    @State private var ctxOver = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let models = model.models, let choice = model.choice {
                ModelGridView(models: models, choice: choice, efforts: model.efforts, onChoose: { model.choose($0) })
            } else {
                Color.clear.frame(height: 180)
            }
            Rectangle().fill(Color.pBd).frame(height: 1)
            if !model.problem.isEmpty {
                CSSText(model.problem, 12.5, color: .pRed, lines: nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EdgeInsets(top: 8, leading: 18, bottom: 0, trailing: 18))
                    .driveID("build-note")
            }
            HStack(spacing: 6) {
                CSSText(model.footLabel, 12, lh: 1.3, color: .pMut)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .driveID("build-choice")
                Button { model.ctxOpen.toggle() } label: {
                    HStack(spacing: 5) {
                        IconView(PostItLook.circlePlus, size: 16)
                        Text("Context").font(Font(Fonts.sans(12, weight: 500)))
                        if !model.picked.isEmpty { Text("· \(model.picked.count)").font(Font(Fonts.sans(12, weight: 500))).foregroundColor(.pFnt) }
                    }
                    .foregroundColor(model.ctxOpen || !model.picked.isEmpty ? .pInk : .pMut)
                    .padding(.leading, 8).padding(.trailing, 10)
                    .frame(minWidth: 30, minHeight: 30)
                    .background(Capsule().fill(model.ctxOpen || ctxOver ? Color.pHov : Color.clear))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .onHover { ctxOver = $0 }
                .help("Add context from the library")
                .accessibilityLabel("Add context from the library")
                .driveID("build-context")
                SendButton(ready: model.ready, label: "Build") { Task { await model.send() } }
                    .driveID("build-send")
            }
            .padding(EdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 8))
        }
        .frame(width: Self.WIDTH)
        .modifier(PlainCard(radius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Build")
        .driveID("post-it-build=\(model.postItId)")
    }
}

/// Context (the design's popout, 290 wide beside the popup): the library search with ✓ rows, then Upload URL or path,
/// Choose from disk…, Add from GitHub….
struct ContextPopoutView: View {
    static let WIDTH: CGFloat = 290
    @ObservedObject var model: ContextModel
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if model.view == "github", let pane = model.context.githubPane {
                pane(model.busy, { model.view = "menu"; model.error = "" }, { url, row in Task { await model.github(url: url, row: row) } })
            } else {
                menu
            }
            if !model.error.isEmpty {
                CSSText(model.error, 12, color: .pRed, lines: nil).padding(EdgeInsets(top: 6, leading: 2, bottom: 0, trailing: 2))
            }
        }
        .padding(10)
        .frame(width: Self.WIDTH)
        .modifier(PlainCard(radius: 8))
        .driveID("ctx-pop")
    }

    @ViewBuilder var menu: some View {
        HStack(spacing: 8) {
            IconView(PostItLook.search, size: 16).foregroundStyle(Color.pInk)
            TextField("Search", text: $model.query)
                .textFieldStyle(.plain)
                .font(Font(Fonts.sans(14)))
                .focused($searchFocused)
                .padding(.vertical, 7)
                .accessibilityLabel("Search the library")
                .driveID("ctx-search")
        }
        .padding(.horizontal, 10)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.pBd, lineWidth: 1))
        .padding(.bottom, 4)
        .onAppear { DispatchQueue.main.async { searchFocused = true } }
        let rows = model.rows
        ScrollView {
            VStack(spacing: 1) {
                ForEach(rows) { item in
                    let on = model.build.picked.contains { $0.id == item.id }
                    WashRow(action: { model.build.toggle(item) }) {
                        HStack(spacing: 10) {
                            CSSText(item.name, 14, on ? 500 : 400).frame(maxWidth: .infinity, alignment: .leading)
                            Text(on ? "✓" : "").font(Font(Fonts.sans(12, weight: 500))).foregroundColor(.pInk).frame(width: 14)
                        }
                        .padding(.vertical, 7).padding(.horizontal, 10)
                    }
                    .driveID("ctx-row=\(item.id)")
                }
                if rows.isEmpty {
                    CSSText("Nothing in the library matches.", 13, color: .pFnt).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 7).padding(.horizontal, 10)
                }
            }
        }
        .frame(maxHeight: 180)
        .fixedSize(horizontal: false, vertical: rows.count < 6)
        Rectangle().fill(Color.pBd).frame(height: 1).padding(EdgeInsets(top: 6, leading: 0, bottom: 8, trailing: 0))
        HStack {
            TextField("Upload URL or path", text: Binding(get: { model.value }, set: { model.value = $0; model.error = "" }))
                .textFieldStyle(.plain)
                .font(Font(Fonts.sans(14)))
                .disabled(model.busy)
                .opacity(model.busy ? 0.5 : 1)
                .padding(.vertical, 6)
                .onSubmit { Task { await model.add() } }
                .accessibilityLabel("Upload URL or path")
        }
        .padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.pTint))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(model.error.isEmpty ? Color.pBd : Color.pRed, lineWidth: 1))
        .padding(.bottom, 4)
        WashRow(action: { Task { await model.disk() } }) {
            HStack(spacing: 12) {
                IconView(PostItLook.folder, size: 16).foregroundStyle(Color.pInk)
                CSSText("Choose from disk…", 14).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, 7).padding(.horizontal, 10)
        }.disabled(model.busy)
        WashRow(action: { model.error = ""; model.view = "github" }) {
            HStack(spacing: 12) {
                IconView(PostItLook.git, size: 13).foregroundStyle(Color.pInk).frame(width: 16, height: 16)
                CSSText("Add from GitHub…", 14).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, 7).padding(.horizontal, 10)
        }.disabled(model.busy)
    }
}

// MARK: - the quick task's card

/// Building's dots in SwiftUI (PostItTask.jsx Dots): three 4 px circles rising in turn.
struct DotsView: View {
    @State private var phase = false
    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<3) { i in
                    let p = Self.pulse(t - Double(i) * 0.15)
                    Circle().frame(width: 4, height: 4).opacity(0.25 + 0.75 * p).offset(y: -2 * p)
                }
            }
        }
        .accessibilityHidden(true)
    }
    /// 0 → 1 at 40% → 0 at 80% of 1.1 s, eased.
    static func pulse(_ t: Double) -> Double {
        let f = (t.truncatingRemainder(dividingBy: 1.1) + 1.1).truncatingRemainder(dividingBy: 1.1) / 1.1
        let x = f < 0.4 ? f / 0.4 : f < 0.8 ? 1 - (f - 0.4) / 0.4 : 0
        return x * x * (3 - 2 * x)
    }
}

/// A post-it's quick task (PostItTask.jsx, 420 wide): Building with what it is doing and Stop; Needs you / Stopped with
/// what it needs, the project to continue it in, Discard, the model and the send.
struct PostItTaskView: View {
    static let WIDTH: CGFloat = 420
    @ObservedObject var model: PostItTaskModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        CSSText(model.word, 13, 500, lh: 1.4)
                        if model.working { DotsView().foregroundColor(.pInk) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .driveID("post-it-task-word")
                    QuietButton(text: "×", size: 16) { model.onClose() }.accessibilityLabel("Close")
                }
                if model.working {
                    CSSText(model.activity, 13, color: .pMut).driveID("post-it-activity")
                } else {
                    CSSText(model.message, 13.5, lh: 1.6, lines: nil).fixedSize(horizontal: false, vertical: true)
                }
                if !model.error.isEmpty { CSSText(model.error, 12.5, color: .pRed, lines: nil) }
            }
            .padding(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 10))
            Rectangle().fill(Color.pBd).frame(height: 1)
            if model.working {
                HStack {
                    if model.status != "accepting" { QuietButton(text: "Stop") { model.onAction("stop") }.driveID("quick-act=stop") }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 30)
                .padding(.vertical, 6).padding(.horizontal, 8)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    CSSText("Continue building this task in a project.", 12.5, 500, lh: 1.3, color: .pMut).padding(.horizontal, 8)
                    WorkspacePickView(model: model)
                }
                .padding(EdgeInsets(top: 10, leading: 8, bottom: 0, trailing: 8))
                HStack(spacing: 6) {
                    QuietButton(text: model.confirm ? "Discard for good?" : "Discard", color: model.confirm ? .pRed : .pFnt) { model.discard() }
                        .driveID("quick-act=discard")
                    Spacer(minLength: 0)
                    ModelChip(model: model)
                    SendButton(ready: model.ready, label: model.target.map { "Continue in \($0.name)" } ?? "Continue in a project") { Task { await model.promote() } }
                        .help(model.target.map { "Continue in \($0.name)" } ?? "")
                        .driveID("quick-act=promote")
                }
                .padding(EdgeInsets(top: 10, leading: 8, bottom: 8, trailing: 8))
            }
        }
        .frame(width: Self.WIDTH)
        .modifier(PlainCard(radius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quick task")
        .driveID("post-it-task=\(model.taskId)")
    }
}

/// The model chip on the task card: the task's model until another is picked; its grid opens beside the card.
struct ModelChip: View {
    @ObservedObject var model: PostItTaskModel
    var body: some View {
        Button { model.modelOpen.toggle() } label: {
            HStack(spacing: 6) {
                Text(model.chipLabel).font(Font(Fonts.sans(12))).foregroundColor(.pMut).lineLimit(1)
                Caret(up: model.modelOpen)
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Capsule().fill(Color.white))
            .overlay(Capsule().strokeBorder(model.modelOpen ? Color.pBd2 : Color.pBd, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(model.models == nil)
        .driveID("post-it-model")
    }
}

/// The task card's model grid, beside it (data-ny-model): the grid alone, starting on the task's model.
struct TaskModelGridView: View {
    @ObservedObject var model: PostItTaskModel
    var body: some View {
        Group {
            if let models = model.models { ModelGridView(models: models, choice: model.choice, onChoose: { model.choice = $0 }) }
        }
        .frame(width: PostItTaskView.WIDTH)
        .modifier(PlainCard(radius: 10))
        .driveID("ny-model")
    }
}

/// The project field and its search (every workspace, nested ones under their parent; typed, "in <parent>").
struct WorkspacePickView: View {
    @ObservedObject var model: PostItTaskModel
    @State private var width: CGFloat = 388
    @FocusState private var searchFocused: Bool

    var body: some View {
        Button { model.wsOpen.toggle(); model.wsQuery = "" } label: {
            HStack(spacing: 10) {
                IconView(PostItLook.taskWorkspace, size: 14).foregroundStyle(Color.pInk)
                CSSText(model.target?.name ?? "Choose a project", 13, 500, lh: 1.4).frame(maxWidth: .infinity, alignment: .leading)
                Caret(up: model.wsOpen)
            }
            .padding(.vertical, 8).padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.pTint))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(model.wsOpen ? Color.pBd2 : Color.pBd, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(GeometryReader { g in Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { _, w in width = w } })
        .driveID("post-it-ws=\(model.workspaceId ?? "")")
        .floatingPanel(isPresented: $model.wsOpen, options: FloatingOptions(side: .below, gap: 4, width: width, card: false, rise: 0.12, takesKey: true, dismissible: false)) {
            list
        }
    }

    var list: some View {
        let typed = !model.wsQuery.trimmingCharacters(in: .whitespaces).isEmpty
        let rows = model.wsRows
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                IconView(PostItLook.search, size: 13).foregroundStyle(Color.pInk)
                TextField("Search", text: $model.wsQuery)
                    .textFieldStyle(.plain)
                    .font(Font(Fonts.sans(13)))
                    .focused($searchFocused)
                    .padding(.vertical, 6)
                    .onSubmit { if let first = rows.first { model.pick(first.id) } }
                    .accessibilityLabel("Search projects")
                    .driveID("post-it-ws-search")
            }
            .padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.pHov))
            .padding(.bottom, 2)
            .onAppear { DispatchQueue.main.async { searchFocused = true } }
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(rows) { held in
                        let on = held.id == model.workspaceId
                        WashRow(action: { model.pick(held.id) }) {
                            HStack(spacing: 10) {
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    CSSText(held.name, 13, on ? 500 : 400)
                                    if typed, let parent = held.above.last { CSSText("in \(parent)", 12, color: .pFnt) }
                                }
                                .padding(.leading, typed ? 0 : 16 * CGFloat(held.above.count))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                Text(on ? "✓" : "").font(Font(Fonts.sans(12, weight: 500))).foregroundColor(.pInk).frame(width: 14)
                            }
                            .padding(.vertical, 8).padding(.horizontal, 10)
                        }
                        .driveID("post-it-ws-row=\(held.id)")
                    }
                    if rows.isEmpty {
                        CSSText("No project matches.", 13, color: .pFnt).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8).padding(.horizontal, 10)
                    }
                }
            }
            .frame(maxHeight: 200)
            .fixedSize(horizontal: false, vertical: rows.count < 5)
        }
        .padding(4)
        .frame(width: width)
        .modifier(PlainCard(radius: 8))
    }
}

// MARK: - the trash

/// The trash, opened (TrashPanel.jsx, 2026-09-22): the projects deleted in the switcher and the post-its thrown into it,
/// newest first, each restorable until it is purged a week after it went in. The Sidebar shows it from its foot's trash
/// button: `PostItsTrashPanel.present(in:anchor:model:ignore:)`.
public struct TrashPanelView: View {
    @ObservedObject var model: TrashPanelModel
    public init(model: TrashPanelModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CSSText(model.heading, 12, color: .pFnt, lines: nil)
                .fixedSize(horizontal: false, vertical: true)
                .padding(EdgeInsets(top: 8, leading: 10, bottom: 6, trailing: 10))
            ForEach(model.projects) { row in
                HStack(spacing: 10) {
                    IconView(PostItLook.trashedProject, size: 14).foregroundStyle(Color.pMut)
                    VStack(alignment: .leading, spacing: 0) {
                        CSSText(row.name, 13, lh: 1.4)
                        CSSText("\(row.nested > 0 ? "Project and \(row.nested) inside it · " : "Project · ")\(PostItWords.timeLeft(row.expires, now: model.now()))", 11, lh: 1.4, color: .pFnt)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    RestoreButton { Task { await model.bringBack(row.id) } }.driveID("restore-workspace=\(row.id)")
                }
                .padding(EdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 6))
                .driveID("trashed-workspace=\(row.id)")
            }
            if let rows = model.rows, rows.isEmpty, model.projects.isEmpty {
                CSSText("No stickies in the trash.", 13, color: .pMut).padding(EdgeInsets(top: 6, leading: 10, bottom: 10, trailing: 10))
            }
            ForEach(model.rows ?? []) { row in
                let words = PostItWords.preview(row.text)
                HStack(spacing: 10) {
                    Rectangle().fill(Color(PostItLook.face)).frame(width: 14, height: 14).overlay(Rectangle().strokeBorder(Color(PostItLook.swatchBorder), lineWidth: 1))
                    VStack(alignment: .leading, spacing: 0) {
                        CSSText(words.isEmpty ? "Empty sticky" : words, 13, lh: 1.4, color: words.isEmpty ? .pFnt : .pInk)
                        CSSText(PostItWords.timeLeft(row.expires, now: model.now()), 11, lh: 1.4, color: .pFnt)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    RestoreButton { Task { await model.restore(row.id) } }.driveID("restore-post-it=\(row.id)")
                }
                .padding(EdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 6))
                .driveID("trashed-post-it=\(row.id)")
            }
            if !model.problem.isEmpty {
                CSSText(model.problem, 12, color: .pRed, lines: nil).padding(.vertical, 6).padding(.horizontal, 10)
            }
        }
        .padding(4)
        .frame(width: 320)
        .modifier(PlainCard(radius: 8))
        .task { await model.load() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Trash")
        .driveID("trash-panel")
    }
}

/// Restore: outlined, its border darker under the pointer (`hov-bd2`).
struct RestoreButton: View {
    let action: () -> Void
    @State private var over = false
    var body: some View {
        Button(action: action) {
            Text("Restore").font(Font(Fonts.sans(12, weight: 500))).foregroundColor(.pInk)
                .padding(.vertical, 6).padding(.horizontal, 10)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(over ? Color.pBd2 : Color.pBd, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over = $0 }
    }
}

/// Showing the trash panel (Rail.jsx: `panel.kind === 'trash'`): hung from the trash button, 8 below, at most 420 high;
/// Escape closes it (the workspace's Escape never sees it); a press outside closes it except on `ignore` (the sidebar's
/// foot, Electron's `[data-trash]`).
@MainActor
public enum PostItsTrashPanel {
    @discardableResult
    public static func present(in window: NSWindow, anchor: CGRect, model: TrashPanelModel, ignore: CGRect? = nil, onClose: (() -> Void)? = nil) -> FloatingPanel {
        let panel = FloatingPanel()
        let key = ObjectIdentifier(panel)
        panel.onClose = { watches[key] = nil; onClose?() }
        panel.show(in: window, anchor: anchor, options: FloatingOptions(side: .below, gap: 8, cap: 420, width: 320, card: false, rise: 0.16, takesKey: true, dismissible: true, ignore: ignore ?? anchor)) {
            TrashPanelView(model: model)
        }
        // The list arrives after it opens and changes with every restore: measured again each time.
        watches[key] = model.objectWillChange.receive(on: DispatchQueue.main).sink { [weak panel] _ in MainActor.assumeIsolated { panel?.relayout() } }
        return panel
    }
    static var watches: [ObjectIdentifier: AnyCancellable] = [:]
}
