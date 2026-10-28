import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// What the panels share: the address lookup that waits for typing to stop (SidebarPanels.jsx, 120 ms), what things say
// (useBodies.js), an add's busy and error (useAddRun.js), fixed-place cards (the peek, the hover card, tooltips) and the
// peek itself (usePeek + PeekCard + Home.jsx ItemPeek).

/// The main process's answer for what is typed, asked 120 ms after typing stops; an answer for an older query is dropped.
@MainActor
final class LookupModel: ObservableObject {
    @Published private(set) var found: (query: String, result: Library.Lookup)? = nil
    private var task: Task<Void, Never>?
    let ask: (String) async throws -> Library.Lookup
    let delay: TimeInterval
    init(ask: @escaping (String) async throws -> Library.Lookup, delay: TimeInterval) { self.ask = ask; self.delay = delay }

    /// Typing changed: ask about `typed` when it looks addable.
    func typed(_ typed: String) {
        task?.cancel()
        guard RailModel.looksAddable(typed) else { return }
        let ask = self.ask, delay = self.delay
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if Task.isCancelled { return }
            let result: Library.Lookup
            do { result = try await ask(typed) } catch { result = StoreValues.lookup(error: error.localizedDescription) }
            if Task.isCancelled { return }
            self?.found = (typed, result)
        }
    }
    /// The answer for `typed` when it has come (nil while on its way or when it is not addable).
    func answer(_ typed: String) -> Library.Lookup? {
        guard RailModel.looksAddable(typed), let found, found.query == typed else { return nil }
        return found.result
    }
    func stop() { task?.cancel() }
}

/// What the project's things say, asked once when a search opens (useBodies).
@MainActor
final class BodiesModel: ObservableObject {
    @Published private(set) var bodies: Bodies? = nil
    private var task: Task<Void, Never>?
    func load(projectId: String?, all: Bool = false, ask: @escaping (String?) async throws -> Library.Bodies) {
        guard projectId != nil || all else { bodies = nil; return }
        task?.cancel()
        task = Task { [weak self] in
            guard let reply = try? await ask(all ? nil : projectId), !Task.isCancelled else { return }
            self?.bodies = RailModel.bodyMaps(reply)
        }
    }
    func stop() { task?.cancel(); task = nil }
}

/// An add's busy and error (useAddRun): `run(work)` waits on `work`, which may return problems; they are shown, joined
/// with " · ", else `done` is called. A throw is shown the same way.
@MainActor
public final class AddRun: ObservableObject {
    @Published public var busy = false
    @Published public var error = ""
    public var done: (() -> Void)?
    public init(done: (() -> Void)? = nil) { self.done = done }
    public func run(_ work: @escaping () async throws -> [String]) {
        guard !busy else { return }
        busy = true
        error = ""
        Task { @MainActor in
            do {
                let problems = try await work()
                if !problems.isEmpty { self.error = problems.joined(separator: " · ") } else { self.done?() }
            } catch {
                self.error = Self.message(error)
            }
            self.busy = false
        }
    }
    nonisolated static func message(_ error: Error) -> String { (error as? StoreError)?.message ?? error.localizedDescription }
}

/// A borderless child window at a fixed place over the parent window: the peek, the hover card, a tooltip. Not key, does
/// not close on presses (what owns it does).
@MainActor
final class CardWindow {
    private let panel: NSPanel
    private let host: NSHostingView<AnyView>
    private weak var parent: NSWindow?
    private(set) var isOpen = false
    /// Where it is, in the parent's content view (y down).
    private(set) var frameInContent: CGRect = .zero

    init(passive: Bool) {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false; panel.animationBehavior = .none
        panel.ignoresMouseEvents = passive
        host = NSHostingView(rootView: AnyView(EmptyView()))
        panel.contentView = host
    }

    /// Shows `content` with its top left at `origin` (content coordinates, y down), `width` wide (nil: its own).
    func show<V: View>(in window: NSWindow, origin: CGPoint, width: CGFloat?, maxHeight: CGFloat? = nil, _ content: V) {
        parent = window
        host.rootView = AnyView(content.frame(width: width))
        let natural = host.fittingSize
        let size = CGSize(width: width ?? natural.width, height: min(natural.height, maxHeight ?? .infinity))
        frameInContent = CGRect(origin: origin, size: size)
        if let view = window.contentView { panel.setFrame(FloatingPanel.screenRect(frameInContent, in: view), display: true) }
        if !isOpen { isOpen = true; window.addChildWindow(panel, ordered: .above); panel.orderFront(nil) }
    }
    func close() {
        guard isOpen else { return }
        isOpen = false
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }
    var window: NSWindow { panel }
}

/// What hovering a library row shows after a beat (usePeek): beside `edge` (the panel's or the sidebar's right), at the
/// row's height; the pointer may cross onto it; it goes 180 ms after the pointer leaves row and card.
@MainActor
final class PeekController: ObservableObject {
    struct Peek: Equatable { var row: LibraryRow; var rect: CGRect; var edge: CGFloat }
    @Published private(set) var peek: Peek? = nil
    @Published private(set) var previews: [String: Library.Preview] = [:]
    private var asked = Set<String>()
    private var timer: Timer?
    private let card = CardWindow(passive: false)
    weak var window: NSWindow?
    let timing: SidebarTiming
    let preview: (String) async throws -> Library.Preview
    /// A peek's "held by" project or one of its places clicked.
    var onOpenWorkspace: (String, String?) -> Void = { _, _ in }
    /// A peek came or went (the sidebar's Escape follows it).
    var onChange: () -> Void = {}

    init(timing: SidebarTiming, preview: @escaping (String) async throws -> Library.Preview) { self.timing = timing; self.preview = preview }

    func hold() { timer?.invalidate(); timer = nil }
    /// `rect`: the row's (content, y down); `edge`: the x the card starts at.
    func open(_ row: LibraryRow, rect: CGRect, edge: CGFloat, in window: NSWindow) {
        hold()
        self.window = window
        let wait = peek != nil ? timing.switchTo : timing.open
        timer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.peek?.row.id != row.id { self.peek = Peek(row: row, rect: rect, edge: edge) }
                self.fetch(row)
                self.draw()
            }
        }
    }
    func close() {
        hold()
        timer = Timer.scheduledTimer(withTimeInterval: timing.close, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.drop() } }
    }
    func drop() { hold(); let had = peek != nil; peek = nil; card.close(); if had { onChange() } }
    var isShowing: Bool { peek != nil }

    func more(for row: LibraryRow) -> Library.Preview? { previews["\(row.id):\(row.lastEdited)"] }

    private func fetch(_ row: LibraryRow) {
        guard row.type != "image" else { return }
        let key = "\(row.id):\(row.lastEdited)"
        guard !asked.contains(key) else { return }
        asked.insert(key)
        Task { [weak self] in
            let more = (try? await self?.preview(row.id)) ?? StoreValues.preview(id: row.id)
            self?.previews[key] = more
            self?.draw()
        }
    }

    /// The card's place (PeekCard): top = clamp(row top − 12, 12, height − 380); right of `edge` when 360 fits, else left of the row.
    static func place(rect: CGRect, edge: CGFloat, view: CGSize, width: CGFloat = 360) -> (origin: CGPoint, roomRight: Bool) {
        let top = max(12, min(rect.minY - 12, view.height - 380))
        let roomRight = edge + 8 + width <= view.width - 8
        let left = roomRight ? edge : max(8, rect.minX - width - 16)
        return (CGPoint(x: left, y: top), roomRight)
    }

    private func draw() {
        guard let peek, let window, let content = window.contentView else { card.close(); return }
        let (origin, roomRight) = Self.place(rect: peek.rect, edge: peek.edge, view: content.bounds.size)
        let top = origin.y
        let view = PeekCardView(row: peek.row, more: more(for: peek.row), maxHeight: min(440, content.bounds.height - top - 12),
                                onOpenWorkspace: { [weak self] pid, wid in self?.drop(); self?.onOpenWorkspace(pid, wid) })
            .padding(.leading, roomRight ? 8 : 0).padding(.trailing, roomRight ? 0 : 8)
            .onHover { [weak self] inside in if inside { self?.hold() } else { self?.close() } }
        card.show(in: window, origin: origin, width: 368, view)
        onChange()
    }
}

/// The peek's card (Home.jsx ItemPeek in the sidebar's frame: 360 wide, padding 14 16 16, 1px #c9c9c9, radius 8).
struct PeekCardView: View {
    let row: LibraryRow
    let more: Library.Preview?
    var maxHeight: CGFloat = 440
    var onOpenWorkspace: (String, String?) -> Void
    var body: some View {
        ScrollView {
            ItemPeekView(row: row, more: more, onOpenWorkspace: onOpenWorkspace)
                .padding(EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 360)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(Palette.bd2), lineWidth: 1))
        .compositingGroup().shadow(color: .black.opacity(0.06), radius: 16, x: 0, y: 12)
        .driveID("sb-peek")
    }
}

/// What a library item is (Home.jsx ItemPeek): its kind, its name, where it is, what it says, and which projects hold it.
struct ItemPeekView: View {
    let row: LibraryRow
    let more: Library.Preview?
    var onOpenWorkspace: (String, String?) -> Void

    var source: String {
        if let url = row.url, !url.isEmpty { return Rx(#"^https?:\/\/(www\.)?"#, "i").replace(url, with: "") }
        if let path = row.path, !path.isEmpty { return (path as NSString).lastPathComponent }
        return ""
    }
    var body: some View {
        let key = Kind.kindKey(row.lib)
        let kind = KindIcons.kind(key, label: Kind.kindLabel(row.lib))
        let local = more?.folder ?? ((row.url ?? "").isEmpty && (row.path ?? "").isEmpty ? row.folderPath : nil)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                KindGlyph(key, box: 14, color: Palette.gray700)
                Text(kind.label.uppercased()).font(sans(9, 500)).tracking(1.6).foregroundStyle(Color(Palette.fnt))
            }
            Text(row.name).font(sans(14.5, 500)).foregroundStyle(Color(Palette.ink)).fixedSize(horizontal: false, vertical: true).padding(.top, 9)
            if !row.hasTag("note") && !source.isEmpty {
                Text(more?.owner != nil && row.hasTag("git") ? "\(more!.owner!) · \(source)" : source).font(Fonts.swiftUIMono(11.5)).foregroundStyle(Color(Palette.fnt))
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            }
            if let local, more?.folderMissing == nil { Text(local).font(Fonts.swiftUIMono(11.5)).foregroundStyle(Color(Palette.fnt)).padding(.top, source.isEmpty ? 4 : 1).driveID("peek-local") }
            if let missing = more?.folderMissing { Text(missing).font(Fonts.swiftUIMono(11.5)).strikethrough().foregroundStyle(Color(Palette.bd2)).padding(.top, source.isEmpty ? 4 : 1).driveID("peek-missing") }
            if !row.hasTag("note"), let summary = row.summary, !summary.isEmpty {
                Text(summary).font(sans(12.5)).foregroundStyle(Color(Palette.gray700)).lineSpacing(12.5 * 0.7 - 4).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
            }
            if row.type == "md", let text = more?.text { DocPreviewText(text: text).padding(.top, 10) }
            if let files = more?.files, !files.isEmpty {
                VStack(alignment: .leading, spacing: 0) { ForEach(files, id: \.self) { Text($0).font(Fonts.swiftUIMono(12)).foregroundStyle(Color(Palette.gray700)).lineLimit(1).truncationMode(.tail) } }.padding(.top, 10)
            }
            if let lines = more?.lines, !lines.isEmpty {
                Text(lines.joined(separator: "\n")).font(Fonts.swiftUIMono(11.5)).foregroundStyle(Color(Palette.gray700))
                    .padding(EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(Palette.gray50)))
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(Palette.bd), lineWidth: 1)).padding(.top, 10)
            }
            if let held = more?.heldBy, !held.isEmpty {
                // Home.jsx keeps a 1px #eaeaea rule over "held by" (margin-top 12, padding-top 10): kept as the code at
                // 9413a56 has it (ledger row 153).
                Rectangle().fill(Color(Palette.bd)).frame(height: 1).padding(.top, 12)
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(held, id: \.id) { project in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            HoverText(text: project.name, weight: 500, color: Palette.gray700) { onOpenWorkspace(project.id, nil) }
                            ForEach(project.workspaces, id: \.id) { ws in HoverText(text: ws.path, weight: 400, color: Palette.fnt) { onOpenWorkspace(project.id, ws.id) } }
                        }
                    }
                }.font(sans(12)).padding(.top, 10)
            }
        }
    }
}

/// Text that turns ink on hover and does something when pressed (`.hov-ink` spans).
struct HoverText: View {
    let text: String
    var weight = 400
    var color: NSColor
    let action: () -> Void
    @State private var hovered = false
    var body: some View {
        Text(text).font(sans(12, weight)).foregroundStyle(Color(hovered ? Palette.ink : color)).onHover { hovered = $0 }.onTapGesture(perform: action)
    }
}

/// A note's start, as plain lines (ui/DocPreview.jsx reads markdown headings and lists; here the lines as written).
struct DocPreviewText: View {
    let text: String
    var tail: Int? = nil
    var body: some View {
        let all = text.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let lines = tail.map { Array(all.suffix($0)) } ?? Array(all.prefix(12))
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                let heading = line.hasPrefix("#")
                Text(heading ? Rx(#"^#+\s*"#).replace(line, with: "") : line).font(sans(12.5, heading ? 500 : 400))
                    .foregroundStyle(Color(heading ? Palette.ink : Palette.gray700)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
