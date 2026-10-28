import AppKit
import SwiftUI
import EngelbartDoc
import EngelbartStore
import EngelbartUI

// The Welcome walkthrough (GettingStarted.jsx, 2026-10-09) and the sidebar tour (SidebarTour.jsx, 2026-10-14), plus the
// clock's button (RecentPages.jsx). The Workspace places them: Get started under the Welcome project's title, the tour over
// the whole window, the clock beside the sidebar's toggle in the title bar.

// MARK: - Get started

/// Under the title of a new user's "Welcome" project, above its document and never written into it, "Get started" in
/// the look of design/onboarding-brainstorm/6-workspace.dc.html: each step a row of its circle, number, title and what is
/// under it (its hint the title's tooltip); a click on the row shows or hides what is under it; a thin line runs from each
/// step's circle down to the next. 1 (open to begin with) lists the Library's tabs with how many each holds; 2 is
/// @brainstorm; 3 is @discover, then the papers its guides found. A circle clicked ticks or unticks it. Hide takes it away
/// for good.
public struct GettingStartedView: View {
    let state: WalkState
    let steps: [WalkStep]
    let library: [LibraryRow]
    let papers: [DiscoverPaper]
    var onTick: (Int, Bool) -> Void
    var onHide: () -> Void
    var onOpenLibrary: (String) -> Void
    var onWrite: () -> Void
    var onBrainstorm: (() -> Void)?
    var onDiscover: (() -> Void)?
    var onOpenPaper: (DiscoverPaper) -> Void
    @State private var open: Set<Int>
    @State private var active: String? = nil

    static let GREY = Color(hex: "#8A8F98"), INK = Color(hex: "#1F2633"), BLUE = Color(Palette.acc)

    public init(state: WalkState, steps: [WalkStep], library: [LibraryRow] = [], papers: [DiscoverPaper] = [], onTick: @escaping (Int, Bool) -> Void, onHide: @escaping () -> Void,
                onOpenLibrary: @escaping (String) -> Void, onWrite: @escaping () -> Void, onBrainstorm: (() -> Void)? = nil, onDiscover: (() -> Void)? = nil,
                onOpenPaper: @escaping (DiscoverPaper) -> Void) {
        self.state = state; self.steps = steps; self.library = library; self.papers = papers; self.onTick = onTick; self.onHide = onHide
        self.onOpenLibrary = onOpenLibrary; self.onWrite = onWrite; self.onBrainstorm = onBrainstorm; self.onDiscover = onDiscover; self.onOpenPaper = onOpenPaper
        // The first step is open to begin with, and so is the first not done.
        _open = State(initialValue: Set([steps.first?.n, GettingStartedModel.firstOpen(steps, state.ticked)].compactMap { $0 }))
    }

    public var body: some View {
        let first = GettingStartedModel.firstOpen(steps, state.ticked)
        let (tabs, total) = GettingStartedModel.libraryTabs(library)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Get started").font(sans(12.5, 500)).foregroundStyle(Self.GREY)
                Spacer()
                Button(action: onHide) { Text("Hide").font(sans(12)).foregroundStyle(Self.GREY) }.buttonStyle(.plain).help("Hide these steps for good").driveID("getting-started-hide")
            }.padding(EdgeInsets(top: 0, leading: 8, bottom: 4, trailing: 4)).frame(minHeight: 24)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(steps.enumerated()), id: \.element.n) { i, step in
                    let done = state.ticked.contains(step.n)
                    let isOpen = open.contains(step.n)
                    let last = i == steps.count - 1
                    let meta = GettingStartedModel.stepMeta(step.n, items: total, papers: papers.count)
                    HStack(alignment: .top, spacing: 8) {
                        VStack(spacing: 4) {
                            Circle(done: done) { onTick(step.n, !done) }.padding(.top, 11).driveID("getting-started-tick=\(step.n)")
                            if !last { Rectangle().fill(Color(hex: "#E4E2DD")).frame(width: 1).frame(minHeight: 12, maxHeight: .infinity) }
                        }.frame(width: 16).padding(.leading, 6)
                        VStack(alignment: .leading, spacing: 0) {
                            Button { toggle(step.n) } label: {
                                HStack(spacing: 10) {
                                    Text("\(step.shown)").font(sans(13).monospacedDigit()).foregroundStyle(Self.GREY).frame(width: 12, alignment: .leading)
                                    Text(step.title).font(sans(14)).foregroundStyle(Self.INK).help(step.hint)
                                    Spacer(minLength: 0)
                                    if !meta.isEmpty { Text(meta).font(sans(12.5)).foregroundStyle(Self.GREY).lineLimit(1).driveID("getting-started-meta=\(step.n)") }
                                    SBIcon(SidebarIcons.chevronRight, size: 12, stroke: 2).foregroundStyle(Self.GREY).rotationEffect(.degrees(isOpen ? 90 : 0))
                                }.padding(.horizontal, 10).frame(minHeight: 38).contentShape(Rectangle())
                            }.buttonStyle(.plain).hover(.wash, radius: 8).driveID("getting-started-title=\(step.n)")
                            if isOpen {
                                VStack(alignment: .leading, spacing: 1) { body(step.n, tabs: tabs) }.padding(.leading, 22).driveID("getting-started-body=\(step.n)")
                            }
                        }.padding(.bottom, isOpen && !last ? 6 : 0)
                    }
                    .driveID("getting-started-step=\(step.n)")
                }
            }.padding(.leading, 4)
        }
        .padding(EdgeInsets(top: 22, leading: 0, bottom: 10, trailing: 0))
        .overlay(alignment: .bottom) { Rectangle().fill(Color(hex: "#EFEDE8")).frame(height: 1) }
        .padding(.bottom, 18)
        .onChange(of: first) { _, next in if let next { open.insert(next) } }
        .driveID("getting-started")
    }

    func toggle(_ n: Int) { if open.contains(n) { open.remove(n) } else { open.insert(n) } }

    @ViewBuilder func body(_ n: Int, tabs: [LibraryTab]) -> some View {
        if n == 1 {
            if tabs.isEmpty { Entry(glyph: SidebarIcons.folder, title: "Library", aside: "Nothing yet", active: active == "1:all") { choose("1:all") { onOpenLibrary("all") } }.driveID("getting-started-row=1:all") }
            ForEach(tabs, id: \.id) { tab in
                Entry(glyph: tab.id == "repos" || tab.id == "files" ? SidebarIcons.folder : tab.id == "web" ? SidebarIcons.globe : SidebarIcons.file, title: tab.label, aside: String(tab.count), active: active == "1:\(tab.id)") {
                    choose("1:\(tab.id)") { onOpenLibrary(tab.id) }
                }.driveID("getting-started-row=1:\(tab.id)")
            }
        } else if n == 2 {
            Entry(glyph: nil, at: true, title: "@brainstorm", note: "Click to start. Bart asks three quick questions about your work, then finds papers on your next steps.", active: active == "2") {
                choose("2") { (onBrainstorm ?? onWrite)() }
            }.driveID("getting-started-row=2:brainstorm")
        } else {
            Entry(glyph: nil, at: true, title: "@discover", note: "Starts by itself after Brainstorm, or click to start it now. Bart finds papers and a guide to reading them.", active: active == "3") {
                choose("3") { (onDiscover ?? onWrite)() }
            }.driveID("getting-started-row=3:discover")
            ForEach(papers, id: \.key) { paper in
                Entry(glyph: SidebarIcons.file, title: paper.title, sub: paper.byline, note: paper.why, active: active == "3:\(paper.key)") { choose("3:\(paper.key)") { onOpenPaper(paper) } }
                    .driveID("getting-started-row=3:\(paper.key)")
            }
        }
    }
    func choose(_ key: String, _ run: () -> Void) { active = key; run() }

    struct Circle: View {
        let done: Bool
        let action: () -> Void
        var body: some View {
            Button(action: action) {
                ZStack {
                    if done { SwiftUI.Circle().fill(GettingStartedView.BLUE); SBIcon(SidebarIcons.check, size: 9, stroke: 4).foregroundStyle(Color.white) }
                    else { SwiftUI.Circle().strokeBorder(Color(hex: "#b4b8bf"), style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])) }
                }.frame(width: 16, height: 16)
            }.buttonStyle(.plain).help(done ? "Mark as not done" : "Mark as done").accessibilityAddTraits(done ? .isSelected : [])
        }
    }

    struct Entry: View {
        let glyph: Icon?
        var at = false
        let title: String
        var sub: String? = nil
        var note: String? = nil
        var aside: String? = nil
        let active: Bool
        let action: () -> Void
        var body: some View {
            Button(action: action) {
                HStack(alignment: .top, spacing: 10) {
                    if at { Text("@").font(sans(13, 500)).foregroundStyle(Color(hex: "#6B6F76")).frame(width: 14) }
                    else if let glyph { SBIcon(glyph, size: 14, stroke: 1.8).foregroundStyle(Color(hex: "#6B6F76")).padding(.top, 2) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(sans(13, 500)).foregroundStyle(GettingStartedView.INK).fixedSize(horizontal: false, vertical: true)
                        if let sub { Text(sub).font(sans(12)).foregroundStyle(GettingStartedView.GREY) }
                        if let note { Text(note).font(sans(13)).foregroundStyle(Color(hex: "#77746E")).fixedSize(horizontal: false, vertical: true) }
                    }
                    Spacer(minLength: 0)
                    if let aside { Text(aside).font(sans(12)).foregroundStyle(GettingStartedView.GREY).padding(.top, 1) }
                }
                .padding(EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color(hex: "#EFEEEA").opacity(active ? 1 : 0)))
                .contentShape(Rectangle())
            }.buttonStyle(.plain).hover(.wash, radius: 7)
        }
    }
}

// MARK: - The sidebar tour

/// Three coach marks after an import's "Open library", on the project's Welcome page (2026-10-14): each card spotlights
/// part of the sidebar (the rest of the window dimmed, the parts cut out of the veil, no ring: 2026-10-15) and sits beside
/// it; → goes on, Finish ends it, × ends it early. Shown once (engelbart.sidebarTour.seen).
public enum SidebarTour {
    public struct Step: Equatable { public let key: String; public let title: String; public let body: String }
    public static let STEPS = [
        Step(key: "library", title: "Engelbart library", body: "All of your sources are saved inside your Engelbart library, which you can attach to any of your projects."),
        Step(key: "sources", title: "Project-specific sources", body: "Each project gets its own folder that holds its notes, code, URLs, and any other project-specific sources from your library."),
        Step(key: "folders", title: "Create folders for your sources", body: "Folders allow you to organize frequently-visited sources so you can easily find them when working between projects."),
    ]
    public static let CARD: CGFloat = 304, GAP: CGFloat = 16, EDGE: CGFloat = 16, TOP: CGFloat = 52

    /// Where the card goes beside the last hole: to its right, else its left, else under it; kept in the window.
    public static func placeCard(_ hole: CGRect?, height: CGFloat, view: CGSize) -> (origin: CGPoint, side: String) {
        guard let hole else { return (CGPoint(x: ((view.width - CARD) / 2).rounded(), y: (view.height * 0.3).rounded()), "none") }
        let top = max(TOP, min(hole.minY, view.height - height - EDGE))
        if hole.maxX + GAP + CARD <= view.width - EDGE { return (CGPoint(x: hole.maxX + GAP, y: top), "right") }
        if hole.minX - GAP - CARD >= EDGE { return (CGPoint(x: hole.minX - GAP - CARD, y: top), "left") }
        return (CGPoint(x: max(EDGE, min(hole.minX, view.width - CARD - EDGE)), y: min(hole.maxY + GAP, view.height - height - EDGE)), "below")
    }
}

/// The tour over the window: a veil rgba(23,23,23,.26) with the holes cut out (radius 10), and the card. It follows the
/// holes every frame while it shows (the Library panel rising, the sidebar scrolling, the window resizing).
@MainActor
public final class SidebarTourOverlay {
    private let panel: CenteredDialog.KeyPanel
    private let host: NSHostingView<AnyView>
    private weak var parent: NSWindow?
    private var timer: Timer?
    private var monitor: Any?
    public private(set) var step: Int?
    public var holes: (Int) -> [CGRect] = { _ in [] }
    public var onNext: () -> Void = {}
    public var onClose: () -> Void = {}

    public init() {
        panel = CenteredDialog.KeyPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false; panel.animationBehavior = .none
        host = NSHostingView(rootView: AnyView(EmptyView()))
        panel.contentView = host
    }

    /// `step` 0–2 shows that card; nil (or `paused`) shows nothing and keeps the step.
    public func show(step: Int?, paused: Bool = false, in window: NSWindow) {
        self.step = step
        guard let step, !paused, step < SidebarTour.STEPS.count else { hide(); return }
        parent = window
        if !panel.isVisible || panel.parent == nil {
            window.addChildWindow(panel, ordered: .above)
            panel.makeKey()
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.step != nil else { return event }
                // Escape ends the tour before the sidebar's popup or the workspace sees it; → and Enter go on.
                if event.keyCode == 53 { self.onClose(); return nil }
                if event.keyCode == 124 || event.keyCode == 36 { self.onNext(); return nil }
                return event
            }
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.draw() } }
        }
        draw()
    }

    public func hide() {
        timer?.invalidate(); timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }

    private var lastKey = ""
    private func draw() {
        guard let step, let window = parent, let content = window.contentView else { return }
        let size = content.bounds.size
        let holes = self.holes(step)
        let key = "\(step) \(holes) \(size)"
        guard key != lastKey else { return }
        lastKey = key
        panel.setFrame(FloatingPanel.screenRect(CGRect(origin: .zero, size: size), in: content), display: true)
        host.rootView = AnyView(TourView(step: step, holes: holes, size: size, onNext: { [weak self] in self?.onNext() }, onClose: { [weak self] in self?.onClose() }))
    }
}

struct TourView: View {
    let step: Int
    let holes: [CGRect]
    let size: CGSize
    var onNext: () -> Void
    var onClose: () -> Void
    @State private var cardHeight: CGFloat = 176
    var body: some View {
        let spec = SidebarTour.STEPS[step]
        let (origin, side) = SidebarTour.placeCard(holes.last, height: cardHeight, view: size)
        let last = step == SidebarTour.STEPS.count - 1
        ZStack(alignment: .topLeading) {
            Canvas { ctx, _ in
                var veil = Path(CGRect(origin: .zero, size: size))
                for hole in holes { veil.addRoundedRect(in: hole, cornerSize: CGSize(width: 10, height: 10)) }
                ctx.fill(veil, with: .color(Color(red: 23 / 255, green: 23 / 255, blue: 23 / 255).opacity(0.26)), style: FillStyle(eoFill: true))
            }
            .frame(width: size.width, height: size.height)
            .allowsHitTesting(true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 12) {
                    Text(spec.title).font(sans(15, 600)).foregroundStyle(Color(Palette.ink)).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    RowActionButton(label: "Close the tour", action: onClose) { SBIcon(SidebarIcons.close, size: 14) }.driveID("tour-close")
                }
                Text(spec.body).font(sans(13.5)).foregroundStyle(Color(Palette.gray700)).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
                HStack {
                    HStack(spacing: 5) {
                        ForEach(0..<SidebarTour.STEPS.count, id: \.self) { i in Capsule().fill(Color(hex: i == step ? "#171717" : "#dcdcdc")).frame(width: i == step ? 14 : 6, height: 6) }
                    }.accessibilityLabel("\(step + 1) of \(SidebarTour.STEPS.count)")
                    Spacer()
                    Button(action: onNext) {
                        if last { Text("Finish").font(sans(13, 500)).foregroundStyle(Color.white).padding(.horizontal, 16).frame(height: 32).background(RoundedRectangle(cornerRadius: 8).fill(Color(Palette.ink))) }
                        else { SBIcon(SidebarIcons.arrowOut, size: 16).rotationEffect(.degrees(45)).foregroundStyle(Color.white).frame(width: 32, height: 32).background(RoundedRectangle(cornerRadius: 8).fill(Color(Palette.ink))) }
                    }.buttonStyle(.plain).hover(.dim, radius: 8).driveID(last ? "tour-finish" : "tour-next")
                }.padding(.top, 16)
            }
            .padding(EdgeInsets(top: 18, leading: 20, bottom: 16, trailing: 18))
            .frame(width: SidebarTour.CARD, alignment: .leading)
            .background(GeometryReader { geo in Color.clear.onAppear { cardHeight = geo.size.height }.onChange(of: geo.size.height) { _, h in cardHeight = h } })
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.white))
            .compositingGroup().shadow(color: .black.opacity(0.18), radius: 24, x: 0, y: 16).shadow(color: .black.opacity(0.06), radius: 3, x: 0, y: 2)
            .offset(x: origin.x, y: origin.y)
            .driveID("tour-card=\(spec.key)")
            .accessibilityLabel(side)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .driveID("sidebar-tour=\(spec.key)")
    }
}

// MARK: - The clock

/// The clock right of the sidebar's toggle (2026-10-13: "a small clock that shows the last ten (or less) opened notes or
/// projects"): its list opens below it, 330 wide.
@MainActor
public final class RecentPagesButton {
    public let button: NSView
    private let icon: SBIconButton
    private let host = FloatingPanel()
    public var pages: () -> (visits: [Visit], project: SidebarProject, roots: [ProjectNode], notes: [String: String], counts: [String: AgentSummary]) = { ([], SidebarProject(id: "", name: ""), [], [:], [:]) }
    public var onOpen: (RecentPage) -> Void = { _ in }

    public init() {
        icon = SBIconButton(icon: SidebarIcons.clock, size: 18, box: CGSize(width: 28, height: 28), color: SB.icon, hoverColor: Palette.ink, hoverFill: SB.headOpen, radius: 6, label: "Recent pages", id: "recent-pages")
        icon.toolTip = "Recent pages"
        button = icon
        icon.action = { [weak self] _ in self?.toggle() }
    }

    public var isOpen: Bool { host.isOpen }

    public func toggle() {
        if host.isOpen { host.close(); icon.on = false; return }
        guard let window = icon.window else { return }
        let data = pages()
        let tree = SidebarModel.indexTree(data.roots)
        let list = SidebarModel.recentPages(visits: data.visits, index: tree, notes: Set(data.notes.keys))
        icon.on = true
        host.onClose = { [weak self] in self?.icon.on = false }
        let anchor = FloatingPanel.anchorRect(of: icon)
        host.show(in: window, anchor: anchor, options: FloatingOptions(side: .below, gap: 4, cap: 520, width: 330, ignore: anchor)) {
            RecentPagesView(pages: list, project: data.project, tree: tree, notes: data.notes, counts: SidebarModel.rollUp(tree, []).merging(data.counts) { $1 },
                            onOpen: { [weak self] page in self?.host.close(); self?.onOpen(page) })
        }
    }
}
