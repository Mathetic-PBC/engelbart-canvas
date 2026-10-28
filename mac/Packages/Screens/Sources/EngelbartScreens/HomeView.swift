import AppKit
import EngelbartCore
import EngelbartDoc
import EngelbartStore
import EngelbartUI
import SwiftUI
import UniformTypeIdentifiers

// The all-projects screen drawn (Home.jsx's render). Values are the JSX's, 1 CSS px = 1 pt.

/// Where rows and tiles sit in the screen (y down), for the peeks that hang beside them.
struct HomeFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, b in b }) }
}

extension View {
    func homeFrame(_ key: String) -> some View {
        background(GeometryReader { g in Color.clear.preference(key: HomeFramesKey.self, value: [key: g.frame(in: .named(HomeScreen.space))]) })
    }
}

/// The frames, kept outside SwiftUI's state (they change on every scroll).
final class FrameBook { var frames: [String: CGRect] = [:] }

/// The all-projects screen. `model.update(...)` feeds it; the context's callbacks are what it asks for.
public struct HomeScreen: View {
    @ObservedObject var model: HomeModel
    static let space = "home"
    @State private var book = FrameBook()
    @State private var size: CGSize = .zero

    public init(model: HomeModel) { self.model = model }

    public var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                VStack(spacing: 0) {
                    HomeHeader()
                    HStack(spacing: 0) {
                        LibraryRail(model: model)
                        ProjectsColumn(model: model)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if let peek = model.peek {
                    PeekOverlay(model: model, peek: peek, window: geometry.size)
                }
                if let project = model.deleting {
                    DeleteProjectDialog(name: project.name, busy: model.deleteBusy,
                                        onConfirm: { Task { await model.confirmDelete() } }, onClose: { model.cancelDelete() })
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            .onAppear { size = geometry.size }
        }
        .coordinateSpace(name: Self.space)
        .background(Color(Palette.bg))
        .onPreferenceChange(HomeFramesKey.self) { frames in
            // The library list scrolled under an open item peek: the peek goes (Home.jsx onScroll).
            if let peek = model.peek, case .item = peek.kind, let now = frames[peek.key], abs(now.minY - peek.rect.minY) > 0.5 { model.dropPeek() }
            book.frames = frames
        }
        .environment(\.homeFrames, book)
        .accessibilityElement(children: .contain)
        .probe("screen=home")
    }
}

private struct HomeFramesEnvironmentKey: EnvironmentKey { static let defaultValue = FrameBook() }
extension EnvironmentValues {
    var homeFrames: FrameBook {
        get { self[HomeFramesEnvironmentKey.self] }
        set { self[HomeFramesEnvironmentKey.self] = newValue }
    }
}

/// The header: "Engelbart" over a hairline, dragging the window.
struct HomeHeader: View {
    var body: some View {
        HStack(spacing: 0) {
            Text("Engelbart").textStyle(.brand).foregroundStyle(Color(Palette.ink))
            Spacer(minLength: 0)
        }
        .padding(.trailing, 18)
        .titleLead(replacing: 18)
        .frame(height: TitleBarMetrics.header)
        .frame(maxWidth: .infinity)
        .titleBar()
        .overlay(alignment: .bottom) { Rectangle().fill(Color(Palette.bd)).frame(height: 1) }
    }
}

// MARK: - the library rail

struct LibraryRail: View {
    @ObservedObject var model: HomeModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Library").textStyle(TextStyle(14, weight: 500, lineHeight: 1.3)).foregroundStyle(Color(Palette.ink))
                .padding(EdgeInsets(top: 19, leading: 18, bottom: 0, trailing: 19))
            VStack(alignment: .leading, spacing: 0) {
                if let slot = model.context.addToLibrary { slot(model.addHandlers) } else { AddContextStandIn(model: model) }
                if !model.addError.isEmpty {
                    Text(model.addError).textStyle(TextStyle(12, lineHeight: 1.5)).foregroundStyle(Color(Palette.del))
                        .padding(EdgeInsets(top: 4, leading: 10, bottom: 0, trailing: 10))
                        .fixedSize(horizontal: false, vertical: true)
                        .probe("library-add-error")
                }
            }
            .padding(EdgeInsets(top: 10, leading: 8, bottom: 0, trailing: 8))
            .accessibilityElement(children: .contain)
            .probe("library-add")
            HomeSearchField(model: model)
                .padding(EdgeInsets(top: 12, leading: 12, bottom: 0, trailing: 12))
            ScrollViewReader { reader in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.shown, id: \.id) { row in
                            LibraryRowView(model: model, row: row).id(row.id)
                        }
                    }
                    .padding(.top, 15).padding(.bottom, 18)
                }
                .onChange(of: model.justAdded) { _, id in
                    if let id { withAnimation(nil) { reader.scrollTo(id) } }
                }
            }
        }
        .frame(width: Widths.rail)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(Palette.panel2))
        .overlay(alignment: .trailing) { Rectangle().fill(Color(Palette.bd)).frame(width: 1) }
        // A drop (MATH-19): an inset 2px #c9c9c9 ring while something the library can take is over the rail.
        .overlay { Rectangle().strokeBorder(Color(Palette.bd2), lineWidth: 2).opacity(model.dropping ? 1 : 0).allowsHitTesting(false)
            .animation(.easeOut(duration: Motion.fast), value: model.dropping) }
        .onDrop(of: DropReader.types, isTargeted: $model.dropping) { providers in
            DropReader.read(providers) { items in
                if !items.isEmpty { Task { @MainActor in await model.dropAll(items) } }
            }
            return true
        }
        .accessibilityElement(children: .contain)
        .probe("library-rail")
    }
}

/// The search: white, radius 8, the soft ring on hover and focus, a bold magnifier, "Search".
struct HomeSearchField: View {
    @ObservedObject var model: HomeModel
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 9) {
            IconView(KindIcons.search, size: 16).foregroundStyle(Color(Palette.ink))
            TextField("", text: $model.query, prompt: Text("Search").foregroundColor(Color(Palette.fnt)))
                .textFieldStyle(.plain)
                .font(Font(Fonts.sans(14)))
                .foregroundStyle(Color(Palette.ink))
                .disableAutocorrection(true)
                .focused($focused)
                .onExitCommand { if !model.escapeSearch() { focused = false } }
                .probe("home-search")
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.bg)))
        .ring(radius: Radius.sm, active: focused)
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }
}

struct LibraryRowView: View {
    @ObservedObject var model: HomeModel
    let row: LibraryRow
    @Environment(\.homeFrames) private var book
    @State private var hov = false

    var body: some View {
        let key = Kind.kindKey(row.lib)
        let peeking = model.peek?.key == row.id
        HStack(spacing: 10) {
            GlyphBox(16) { IconView(KindIcons.kind(key).icon, size: 16) }.foregroundStyle(Color(Palette.ink))
            Text(row.name).textStyle(TextStyle(14, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 18))
        .frame(height: 31.5)
        .background(Color(hov || peeking ? Palette.hov : .clear).animation(.easeOut(duration: Motion.fast), value: hov || peeking))
        .addedFlashOnce(model.justAdded == row.id)
        .contentShape(Rectangle())
        .homeFrame(row.id)
        .onTapGesture { Task { await model.openRow(row) } }
        .onHover { inside in
            hov = inside
            if inside { model.openPeek(HomePeek(key: row.id, kind: .item(row), rect: book.frames[row.id] ?? .zero)) } else { model.closePeek() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { Task { await model.openRow(row) } }
        .probe("library-row=\(row.id)", press: { Task { await model.openRow(row) } })
    }
}

extension View {
    /// `animation: added 1600ms ease-out` (#e6f0fd → transparent) on the row just added.
    func addedFlashOnce(_ on: Bool) -> some View { modifier(AddedFlash(on: on)) }
}

struct AddedFlash: ViewModifier {
    let on: Bool
    @State private var start: Date?
    func body(content: Content) -> some View {
        content.background {
            if let start {
                TimelineView(.animation) { context in
                    let p = min(1, context.date.timeIntervalSince(start) / 1.6)
                    Color(Palette.accHovBg).opacity(1 - Keyframe.bezier(p, 0, 0, 0.58, 1))
                }
            }
        }
        .onChange(of: on) { _, now in if now { start = Date(); DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { start = nil } } }
        .onAppear { if on { start = Date(); DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { start = nil } } }
    }
}

/// Add context until the Sidebar package's AddToLibrary is plugged in: the same row (circled plus, "Add context"), which
/// opens a link-or-path field and Choose from disk….
struct AddContextStandIn: View {
    @ObservedObject var model: HomeModel
    @State private var open = false
    @State private var text = ""
    @State private var problem = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { open.toggle() } label: {
                HStack(spacing: 9) {
                    CirclePlus().frame(width: 18, height: 18)
                    Text("Add context").textStyle(TextStyle(14, lineHeight: 1.5))
                    Spacer(minLength: 0)
                }
                .padding(EdgeInsets(top: 6, leading: 10, bottom: 8, trailing: 10))
                .foregroundStyle(Color(open ? Palette.ink : Palette.fnt))
                .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(open ? Palette.hov : .clear)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hover(.wash)
            .accessibilityLabel("Add context")
            .probe("rail-add", press: { open.toggle() })
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        TextField("", text: $text, prompt: Text("a link or a path…").italic().foregroundColor(Color(Palette.fnt)))
                            .textFieldStyle(.plain).font(Font(Fonts.sans(13.5))).disableAutocorrection(true)
                            .onSubmit(add)
                            .probe("rail-add-field")
                        Button(busy ? "Adding…" : "Add", action: add).buttonStyle(.plain).textStyle(TextStyle(12.5, weight: 500, lineHeight: 1))
                            .foregroundStyle(Color(text.trimmed.isEmpty || busy ? Palette.bd2 : Palette.ink)).disabled(text.trimmed.isEmpty || busy)
                    }
                    .padding(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 6))
                    .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(Palette.bg)))
                    .hoverBorder(radius: Radius.xs)
                    Button("Choose from disk…") { Task { await model.addHandlers.onPickDisk() } }.buttonStyle(.plain)
                        .textStyle(TextStyle(13, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                    if !problem.isEmpty { Text(problem).textStyle(TextStyle(12, lineHeight: 1.5)).foregroundStyle(Color(Palette.del)) }
                }
                .padding(.horizontal, 2)
                .rise(0.16)
            }
        }
    }

    private func add() {
        let value = text.trimmed
        guard !value.isEmpty, !busy else { return }
        busy = true; problem = ""
        Task { @MainActor in
            do { try await model.addHandlers.onAdd(value); text = ""; open = false } catch { problem = errorMessage(error) }
            busy = false
        }
    }
}

/// Rail.jsx CIRCLE_PLUS: 18px, stroke 1.3.
struct CirclePlus: View {
    var body: some View {
        Canvas { ctx, size in
            let s = size.width / 18
            var path = Path(ellipseIn: CGRect(x: 1.5 * s, y: 1.5 * s, width: 15 * s, height: 15 * s))
            path.move(to: CGPoint(x: 9 * s, y: 5.5 * s)); path.addLine(to: CGPoint(x: 9 * s, y: 12.5 * s))
            path.move(to: CGPoint(x: 5.5 * s, y: 9 * s)); path.addLine(to: CGPoint(x: 12.5 * s, y: 9 * s))
            ctx.stroke(path, with: .foreground, style: StrokeStyle(lineWidth: 1.3 * s, lineCap: .round))
        }
    }
}

/// Rail.jsx TRASH_MARK: a small can, 15px, drawn in the minus's line (stroke 1.3).
struct TrashMark: View {
    static let icon = Icon("Trash", grid: 16, stroke: 1.3, size: 15, [
        IconShape(.path("M2.5 4h11 M6.25 4V2.75a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75V4 M3.75 4l.7 9.1a1 1 0 0 0 1 .9h5.1a1 1 0 0 0 1-.9l.7-9.1 M6.75 6.75v4.5 M9.25 6.75v4.5")),
    ])
    var body: some View { IconView(Self.icon, size: 15) }
}

// MARK: - the projects column

struct ProjectsColumn: View {
    @ObservedObject var model: HomeModel

    var body: some View {
        GeometryReader { g in
            ScrollView([.vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("Projects").textStyle(TextStyle(14, weight: 500, lineHeight: 1.3)).foregroundStyle(Color(Palette.ink))
                        if !model.projects.isEmpty {
                            Text("\(model.projects.count)").textStyle(TextStyle(12, lineHeight: 1)).foregroundStyle(Color(Palette.fnt))
                        }
                    }
                    if !model.error.isEmpty {
                        Text(model.error).textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.del))
                            .padding(.top, 8).probe("home-error")
                    }
                    FlowLayout(spacing: 14, minItem: 0) {
                        ForEach(model.projects, id: \.id) { project in
                            ProjectCard(model: model, project: project)
                        }
                        NewProjectCard { model.context.onCreateScreen() }
                    }
                    .padding(.top, 14)
                    if !model.trashed.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("Recently deleted").textStyle(TextStyle(14, weight: 500, lineHeight: 1.3)).foregroundStyle(Color(Palette.ink))
                                Text("\(model.trashed.count)").textStyle(TextStyle(12, lineHeight: 1)).foregroundStyle(Color(Palette.fnt))
                            }
                            FlowLayout(spacing: 10, minItem: 336, stretch: false) {
                                ForEach(model.trashed, id: \.id) { project in TrashedCard(model: model, project: project) }
                            }
                            .padding(.top, 12)
                        }
                        .padding(.top, 30)
                        .accessibilityElement(children: .contain)
                        .probe("recently-deleted")
                    }
                }
                .padding(EdgeInsets(top: 19, leading: 20, bottom: 24, trailing: 20))
                .frame(width: g.size.width, alignment: .leading)
            }
            .onAppear { model.tiles = HomeLogic.tiles(columnWidth: g.size.width) }
            .onChange(of: g.size.width) { _, width in model.tiles = HomeLogic.tiles(columnWidth: width) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ProjectCard: View {
    @ObservedObject var model: HomeModel
    let project: PublicProject
    @State private var hov = false

    var body: some View {
        let held = model.held(project)
        let recent = Array((project.recent ?? []).prefix(model.tiles))
        let rest = (project.workspaceCount ?? 0) - recent.count
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center, spacing: 24) {
                VStack(alignment: .leading, spacing: 3) {
                    if model.renaming == project.id {
                        RenameField(initial: project.name, onCommit: { model.commitRename(project, $0) }, onCancel: { model.cancelRename() })
                    } else {
                        Text(project.name).textStyle(TextStyle(16, weight: 500, lineHeight: 1.4, tracking: -0.1)).foregroundStyle(Color(Palette.ink))
                            .lineLimit(1).truncationMode(.tail)
                            .help("Click to rename")
                            .onTapGesture { model.startRename(project.id) }
                            .onHover { inside in if inside { NSCursor.iBeam.push() } else { NSCursor.pop() } }
                            .probe("project-name=\(project.id)", press: { model.startRename(project.id) })
                    }
                    Text(HomeLogic.cardMeta(workspaceCount: project.workspaceCount ?? 0, lastEdited: project.lastEdited))
                        .textStyle(TextStyle(12, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).fixedSize()
                }
                Spacer(minLength: 0)
                HStack(spacing: 12) {
                    if let icons = HomeLogic.heldIcons(held) { HeldIconsView(held: icons) }
                    if model.context.onDelete != nil {
                        Button { model.askDelete(project) } label: {
                            TrashMark().padding(2).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .padding(-2)
                        .foregroundStyle(Color(Palette.fnt))
                        .hover(.ink)
                        .opacity(hov ? 1 : 0)
                        .animation(.easeOut(duration: Motion.fast), value: hov)
                        .help("Move to the trash")
                        .accessibilityLabel("Delete \(project.name)")
                        .probe("delete-project=\(project.id)", press: { model.askDelete(project) })
                    }
                }
                .fixedSize()
            }
            if !recent.isEmpty {
                HStack(alignment: .bottom, spacing: 12) {
                    ForEach(recent, id: \.id) { workspace in
                        WorkspaceTile(model: model, project: project, workspace: workspace)
                    }
                    if rest > 0 {
                        Spacer(minLength: 0)
                        Text("+ \(rest) more").textStyle(TextStyle(12, lineHeight: 1)).foregroundStyle(Color(Palette.fnt))
                            .lineLimit(1).fixedSize().padding(.bottom, 12)
                    }
                }
            }
        }
        .padding(18)
        .frame(minWidth: 336, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(Color(Palette.bg)))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Color(Palette.bd), lineWidth: 1))
        .ring(radius: Radius.md)
        .contentShape(Rectangle())
        .onHover { hov = $0 }
        .onTapGesture { model.openCard(project) }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.openCard(project) }
        .probe("project-card=\(project.id)", press: { model.openCard(project) })
    }
}

/// InlineField with the card's padding (4 8): Enter or leaving commits a changed name, Escape or empty cancels.
struct RenameField: View {
    let initial: String
    let onCommit: (String) -> Void
    let onCancel: () -> Void
    @State private var focused = false
    var body: some View {
        InlineTextField(placeholder: "project name…", initial: initial, autoFocus: true, focused: $focused) { outcome in
            switch outcome {
            case .commit(let text): onCommit(text)
            case .cancel: onCancel()
            case .none: break
            }
        }
        .frame(height: 14 * 1.4)
        .padding(EdgeInsets(top: 5, leading: 9, bottom: 5, trailing: 9))
        .frame(width: 220)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.tint)))
        .hoverBorder(radius: Radius.sm, rest: Palette.bd, focused: focused)
        .probe("rename-project")
    }
}

/// The kinds a project holds, once each, in the rail's order; then how many items they stand for.
struct HeldIconsView: View {
    let held: HomeLogic.Held
    var body: some View {
        HStack(spacing: 7) {
            ForEach(held.kinds, id: \.self) { key in
                GlyphBox(14) { IconView(KindIcons.kind(key).icon, size: 14) }.help(KindIcons.kind(key).label)
            }
            Text(held.caption).textStyle(TextStyle(12, lineHeight: 1)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).fixedSize()
                .padding(.leading, 1)
        }
        .foregroundStyle(Color(Palette.ink))
        .accessibilityElement(children: .combine)
        .probe("held-icons")
    }
}

/// A recent workspace as a page: 168×200, its name and its document, fading out at the foot.
struct WorkspaceTile: View {
    @ObservedObject var model: HomeModel
    let project: PublicProject
    let workspace: RecentWorkspace
    @Environment(\.homeFrames) private var book

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(workspace.name).textStyle(TextStyle(12.5, weight: 600, lineHeight: 1.3)).foregroundStyle(Color(Palette.ink))
                .padding(.bottom, 5)
            DocPreview(text: workspace.text, maxLines: 24)
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: 14, leading: 14, bottom: 0, trailing: 14))
        .frame(width: 168, height: 200, alignment: .topLeading)
        .overlay(alignment: .bottom) {
            LinearGradient(stops: [.init(color: Color.white.opacity(0), location: 0), .init(color: .white, location: 0.85)], startPoint: .top, endPoint: .bottom)
                .frame(height: 44).allowsHitTesting(false)
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.xs))
        .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(Palette.bg)))
        .hoverBorder(radius: Radius.xs)
        .contentShape(Rectangle())
        .homeFrame("ws:\(workspace.id)")
        .onTapGesture { model.openTile(project, workspace) }
        .onHover { inside in
            if inside { model.openPeek(HomePeek(key: workspace.id, kind: .workspace(workspace, project: project), rect: book.frames["ws:\(workspace.id)"] ?? .zero)) }
            else { model.closePeek() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.openTile(project, workspace) }
        .probe("workspace-tile=\(workspace.id)", press: { model.openTile(project, workspace) })
    }
}

/// The dashed "+ Project" card.
struct NewProjectCard: View {
    let action: () -> Void
    @State private var hov = false
    @FocusState private var focused: Bool
    var body: some View {
        Text("+ Project").textStyle(TextStyle(14, weight: 500, lineHeight: 1.5))
            .foregroundStyle(Color(hov ? Palette.ink : Palette.fnt))
            .frame(width: 320)
            .frame(minHeight: 96, maxHeight: .infinity)
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Color(Palette.bd2), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
            .ring(radius: Radius.md, active: focused)
            .contentShape(Rectangle())
            .onHover { hov = $0 }
            .onTapGesture(perform: action)
            .focusable().focused($focused).focusEffectDisabled()
            .onKeyPress(.return) { action(); return .handled }
            .onKeyPress(.space) { action(); return .handled }
            .animation(.easeOut(duration: Motion.fast), value: hov)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { action() }
            .probe("new-project", press: action)
    }
}

/// A project in the trash: its name, when it went and when it is gone, Restore.
struct TrashedCard: View {
    @ObservedObject var model: HomeModel
    let project: TrashedProject
    var body: some View {
        let restoring = model.restoring == project.id
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).textStyle(TextStyle(14, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.mut)).lineLimit(1).truncationMode(.tail)
                Text("deleted \(HomeLogic.relative(project.deleted)) · gone \(HomeLogic.day(project.expires))")
                    .textStyle(TextStyle(12, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).lineLimit(1).fixedSize()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { Task { await model.restore(project.id) } } label: {
                Text(restoring ? "Restoring…" : "Restore").textStyle(TextStyle(12.5, weight: 500, lineHeight: 1)).foregroundStyle(Color(Palette.ink))
                    .padding(EdgeInsets(top: 8, leading: 13, bottom: 8, trailing: 13))
                    .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(Palette.bg)))
                    .hoverBorder(radius: Radius.xs)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(restoring)
            .opacity(restoring ? 0.6 : 1)
            .probe("restore-project=\(project.id)", press: restoring ? nil : { Task { await model.restore(project.id) } })
        }
        .padding(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 10))
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(Color(Palette.panel2)))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Color(Palette.bd), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .probe("trashed-project=\(project.id)")
    }
}

// MARK: - peeks

struct PeekOverlay: View {
    @ObservedObject var model: HomeModel
    let peek: HomePeek
    let window: CGSize

    var body: some View {
        let frame = HomeLogic.peekFrame(row: peek.rect, workspace: peek.isWorkspace, window: window)
        // The wrapper reaches back over the gap to the row, so crossing the gap still counts as hovering.
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                switch peek.kind {
                case .item(let row):
                    ItemPeek(row: row, more: model.preview(for: row)) { projectId, workspaceId in model.openHolder(projectId, workspaceId) }
                        .onAppear { model.loadPreview(for: row) }
                case .workspace(let workspace, let project):
                    Text(HomeLogic.workspaceTrail(project: project.name, path: workspace.path, name: workspace.name))
                        .textStyle(TextStyle(12, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt))
                    Text(workspace.name).textStyle(TextStyle(15, weight: 600, lineHeight: 1.35)).foregroundStyle(Color(Palette.ink))
                        .padding(.top, 4).padding(.bottom, 8)
                    DocPreview(text: workspace.text, size: 13)
                }
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16))
            .frame(width: frame.width, alignment: .leading)
        }
        .frame(width: frame.width)
        .frame(maxHeight: frame.maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.panel)))
        .overlay(RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(Color(Palette.bd2), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
        .shadow(color: Color.black.opacity(0.06), radius: 16, x: 0, y: 12)
        .padding(frame.onRight ? .leading : .trailing, HomeLogic.PEEK_GAP)
        .contentShape(Rectangle())
        .onHover { inside in if inside { model.hold() } else { model.closePeek() } }
        .rise(0.16)
        .accessibilityElement(children: .contain)
        .probe("peek=\(peek.isWorkspace ? "workspace" : "item")")
        .padding(.leading, frame.left)
        .padding(.top, frame.top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// What hovering a library row adds to the row: by kind, then the projects and workspaces that hold it.
public struct ItemPeek: View {
    let row: LibraryRow
    let more: Library.Preview?
    let onOpenWorkspace: (String, String?) -> Void

    public init(row: LibraryRow, more: Library.Preview?, onOpenWorkspace: @escaping (String, String?) -> Void) {
        self.row = row; self.more = more; self.onOpenWorkspace = onOpenWorkspace
    }

    public var body: some View {
        let key = Kind.kindKey(row.lib)
        let isNote = row.hasTag("note")
        let source = HomeLogic.source(row)
        // Where it is on disk: a repository's clone (whether or not it also has an address), any other folder.
        let local = more?.folder ?? ((row.url ?? "").isEmpty && (row.path ?? "").isEmpty ? row.folderPath : nil)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                GlyphBox(14) { IconView(KindIcons.kind(key).icon, size: 14) }.foregroundStyle(Color(Palette.mut))
                Text(HomeLogic.kindLabel(row)).textStyle(.microcap).foregroundStyle(Color(Palette.fnt))
            }
            Text(row.name).textStyle(TextStyle(14.5, weight: 500, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                .padding(.top, 9).fixedSize(horizontal: false, vertical: true)
            if !isNote && !source.isEmpty {
                Text(more?.owner != nil && !(more?.owner ?? "").isEmpty && row.hasTag("git") ? "\(more!.owner!) · \(source)" : source)
                    .font(Font(Fonts.mono(11.5))).lineSpacing(11.5 * 0.3).foregroundStyle(Color(Palette.fnt)).padding(.top, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let local, !local.isEmpty, (more?.folderMissing ?? "").isEmpty {
                Text(local).font(Font(Fonts.mono(11.5))).foregroundStyle(Color(Palette.fnt)).padding(.top, source.isEmpty ? 4 : 1)
                    .fixedSize(horizontal: false, vertical: true).probe("peek-local")
            }
            if let missing = more?.folderMissing, !missing.isEmpty {
                Text(missing).font(Font(Fonts.mono(11.5))).strikethrough(true, color: Color(Palette.bd2)).foregroundStyle(Color(Palette.bd2))
                    .padding(.top, source.isEmpty ? 4 : 1).fixedSize(horizontal: false, vertical: true).probe("peek-missing")
            }
            if !isNote, let summary = row.summary, !summary.isEmpty {
                Text(summary).textStyle(TextStyle(12.5, lineHeight: 1.7)).foregroundStyle(Color(Palette.mut)).padding(.top, 8)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if row.type == "md", let text = more?.text {
                DocPreview(text: text, size: 12.5).padding(.top, 10)
            }
            if let files = more?.files, !files.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(files, id: \.self) { name in
                        Text(name).font(Font(Fonts.mono(12))).lineSpacing(12 * 0.55).foregroundStyle(Color(Palette.mut)).lineLimit(1).truncationMode(.tail)
                    }
                }
                .padding(.top, 10)
            }
            if let lines = more?.lines, !lines.isEmpty {
                ScrollView(.horizontal) {
                    Text(lines.joined(separator: "\n")).font(Font(Fonts.mono(11.5))).lineSpacing(11.5 * 0.4).foregroundStyle(Color(Palette.mut))
                        .fixedSize().padding(EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10))
                }
                .background(RoundedRectangle(cornerRadius: Radius.xs).fill(Color(Palette.panel2)))
                .overlay(RoundedRectangle(cornerRadius: Radius.xs).strokeBorder(Color(Palette.bd), lineWidth: 1))
                .padding(.top, 10)
            }
            if let heldBy = more?.heldBy, !heldBy.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(heldBy, id: \.id) { project in
                        HolderLine(project: project, onOpen: onOpenWorkspace)
                    }
                }
                .padding(.top, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                // The code at 9413a56 separates the foot with a top border; kept as it is there.
                .overlay(alignment: .top) { Rectangle().fill(Color(Palette.bd)).frame(height: 1) }
                .padding(.top, 12)
            }
        }
    }
}

struct HolderLine: View {
    let project: Library.Holder
    let onOpen: (String, String?) -> Void
    var body: some View {
        FlowLayout(spacing: 8, stretch: false) {
            Button(project.name) { onOpen(project.id, nil) }.buttonStyle(.plain)
                .font(Font(Fonts.sans(12, weight: 500))).foregroundStyle(Color(Palette.mut)).hover(.ink)
                .probe("holder=\(project.id)", press: { onOpen(project.id, nil) })
            ForEach(project.workspaces, id: \.id) { workspace in
                Button(workspace.path) { onOpen(project.id, workspace.id) }.buttonStyle(.plain)
                    .font(Font(Fonts.sans(12))).foregroundStyle(Color(Palette.fnt)).hover(.ink)
                    .probe("holder=\(project.id)/\(workspace.id)", press: { onOpen(project.id, workspace.id) })
            }
        }
    }
}

// MARK: - drops

/// What a drop holds (model/drop.js readDrop): files first and alone (a path when on disk, else its bytes), else one
/// link (the uri list's first http(s) line, else the first <img>'s src).
enum DropReader {
    static let imageTypes: [UTType] = [.png, .jpeg, .gif, .webP]
    static let types: [UTType] = [.fileURL, .url] + imageTypes + [.html]

    static func read(_ providers: [NSItemProvider], done: @escaping ([Drop.Item]) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var files: [(Int, Drop.Item)] = []
        var uris: [(Int, String)] = []
        var html: String?
        for (index, provider) in providers.enumerated() {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url, url.isFileURL { lock.lock(); files.append((index, .path(url.path))); lock.unlock() }
                    group.leave()
                }
            } else if let type = imageTypes.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) }), !provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                    if let data { lock.lock(); files.append((index, .bytes(data, mime: type.preferredMIMEType ?? "", name: provider.suggestedName))); lock.unlock() }
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url { lock.lock(); uris.append((index, url.absoluteString)); lock.unlock() }
                    group.leave()
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.html.identifier) {
                group.enter()
                provider.loadDataRepresentation(forTypeIdentifier: UTType.html.identifier) { data, _ in
                    if let data { lock.lock(); html = String(decoding: data, as: UTF8.self); lock.unlock() }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) {
            let fileItems = files.sorted { $0.0 < $1.0 }.map(\.1)
            let uriList = uris.sorted { $0.0 < $1.0 }.map(\.1).joined(separator: "\n")
            done(Drop.readDrop(files: fileItems, uriList: uriList, html: html))
        }
    }
}

/// The all-projects screen as an AppKit controller (an NSHostingController of `HomeScreen`).
@MainActor
public final class HomeViewController: NSHostingController<AnyView> {
    public let model: HomeModel
    public init(context: HomeContext, chrome: WindowChrome = WindowChrome()) {
        let model = HomeModel(context: context)
        self.model = model
        super.init(rootView: AnyView(HomeScreen(model: model).environmentObject(chrome)))
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not from a coder") }
}
