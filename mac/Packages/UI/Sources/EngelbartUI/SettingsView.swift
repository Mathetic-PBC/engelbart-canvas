import SwiftUI

// Settings (ui/Settings.jsx, 2026-10-06, MATH-53): the gear in the top-right controls on every screen opens the settings
// window, laid out as Linear's settings are: pages on the left (a registry, so more can be added), and on the right the
// open page's groups. Pages: Models (what Quick, Standard and Deep run on for each provider; ModelsPage.swift), Connections
// (the app's accounts, from the Integrations package), Import context (an action: it closes Settings and starts Import
// your context, 2026-10-23), and in test mode Test data. A search field tops the column and narrows it to the pages whose
// title or keywords hold the query (2026-10-07).

/// What the window was given: the Test data actions (a developer's copy, else nil) and how to close it.
public struct SettingsContext {
    public var test: TestDataActions?
    public var close: () -> Void
    public init(test: TestDataActions?, close: @escaping () -> Void) { self.test = test; self.close = close }
}

/// Test data (test mode only): the test library's folder, and starting it over.
public struct TestDataActions {
    public var testMode: Bool
    public var onReveal: () -> Void
    public var onStartNew: () -> Void
    public var onReset: () -> Void
    /// The test root as the person reads it (`~/.engelbart-swift/test`).
    public var testRootShown: String
    public init(testMode: Bool, testRootShown: String = "~/.engelbart-swift/test", onReveal: @escaping () -> Void,
                onStartNew: @escaping () -> Void, onReset: @escaping () -> Void) {
        self.testMode = testMode; self.testRootShown = testRootShown; self.onReveal = onReveal; self.onStartNew = onStartNew; self.onReset = onReset
    }
}

/// One page of the window. `body` draws it; a page with `run` instead is an action (opening it runs it, and the page open
/// stays as it was). `shown` decides from the context whether it is there.
public struct SettingsPage: Identifiable {
    public let id: String
    public let section: String
    public let title: String
    public let icon: Icon
    public let keywords: [String]
    public let shown: (SettingsContext) -> Bool
    public let body: ((SettingsContext) -> AnyView)?
    public let run: ((SettingsContext) -> Void)?

    public init(id: String, section: String, title: String, icon: Icon, keywords: [String] = [], shown: @escaping (SettingsContext) -> Bool = { _ in true },
                body: ((SettingsContext) -> AnyView)? = nil, run: ((SettingsContext) -> Void)? = nil) {
        self.id = id; self.section = section; self.title = title; self.icon = icon; self.keywords = keywords; self.shown = shown
        self.body = body; self.run = run
    }
}

/// The three @discover levels, in order, with what each is for (their hints are search keywords only: no subtext).
public enum DiscoverLevels {
    public static let all: [(id: String, name: String, hint: String)] = [
        ("quick", "Quick", "Used by @discover --quick"),
        ("standard", "Standard", "Used by a plain @discover line"),
        ("deep", "Deep", "Used by @discover --deep"),
    ]
}

public enum SettingsPages {
    /// Connections' tool rows, as its keywords name them (workspace/Connections.jsx TOOL_CONNECTIONS / TOOL_NAME).
    public static let toolNames = ["Claude Code", "Codex"]

    /// The standard pages in their order. `models` and `connections` draw those pages (wave 2 gives Connections; until then
    /// `connections` may be nil and the page says so); `startImport` starts Import your context.
    public static func standard(models: @escaping (SettingsContext) -> AnyView,
                                connections: ((SettingsContext) -> AnyView)?,
                                startImport: @escaping () -> Void) -> [SettingsPage] {
        [
            SettingsPage(id: "model", section: "Settings", title: "Models", icon: SettingsIcons.model,
                         keywords: DiscoverLevels.all.flatMap { [$0.name, $0.hint] } + ["model", "effort", "intelligence", "discover", "Claude", "Codex"],
                         body: models),
            SettingsPage(id: "connections", section: "Settings", title: "Connections", icon: SettingsIcons.blocks,
                         keywords: ["GitHub", "Zotero", "accounts", "sign in", "sign out"] + toolNames,
                         body: connections ?? { _ in AnyView(SlotPlaceholder("Connections")) }),
            SettingsPage(id: "guided-setup", section: "Settings", title: "Import context", icon: SettingsIcons.add,
                         keywords: ["onboarding", "setup", "guided setup", "import", "context", "walkthrough", "getting started", "welcome", "library"],
                         run: { context in context.close(); startImport() }),
            SettingsPage(id: "test-data", section: "Developer", title: "Test data", icon: SettingsIcons.flask,
                         keywords: ["reveal", "reset", "start over", "test library"],
                         shown: { $0.test?.testMode == true },
                         body: { context in AnyView(TestDataPage(test: context.test, close: context.close)) }),
        ]
    }

    /// Whether a page answers a search: case-insensitive, its title or a keyword holding the trimmed query. Empty: every page.
    public static func matches(_ page: SettingsPage, _ query: String) -> Bool {
        let want = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return want.isEmpty || ([page.title] + page.keywords).contains { $0.lowercased().contains(want) }
    }

    /// The pages listed in the column for `query`, under their headings (a heading only over a page listed).
    public static func sections(_ pages: [SettingsPage], query: String) -> [(title: String, pages: [SettingsPage])] {
        var out: [(title: String, pages: [SettingsPage])] = []
        for page in pages where matches(page, query) {
            if let last = out.indices.last, out[last].title == page.section { out[last].pages.append(page) }
            else { out.append((page.section, [page])) }
        }
        return out
    }

    /// The page it opens on: the one asked for when it is shown and is not an action, else the first.
    public static func initial(_ pages: [SettingsPage], requested: String?) -> String? {
        if let requested, let page = pages.first(where: { $0.id == requested }), page.run == nil { return page.id }
        return pages.first?.id
    }
}

/// What Escape does where it was pressed: an open "…" menu on a page takes it, then a search field with text is cleared,
/// else the window closes.
public enum SettingsEscape: Equatable {
    case menu, clear, close
    public static func action(menuOpen: Bool, inSearch: Bool, searchText: String) -> SettingsEscape {
        if menuOpen { return .menu }
        if inSearch && !searchText.isEmpty { return .clear }
        return .close
    }
}

/// The left column: the search field (not focused on open), then the pages that answer it under their headings; Enter in
/// the field opens the first page listed; "No results" when none do. The open page stays open when the search hides it.
public struct SettingsNav: View {
    let pages: [SettingsPage]
    let open: String
    @Binding var query: String
    var searchFocused: FocusState<Bool>.Binding
    let onOpen: (String) -> Void

    public var body: some View {
        let sections = SettingsPages.sections(pages, query: query)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .leading) {
                    TextField("", text: $query)
                        .textFieldStyle(.plain)
                        .font(Fonts.swiftUISans(13))
                        .foregroundStyle(Color(Palette.ink))
                        .focused(searchFocused)
                        .onSubmit { if let first = sections.first?.pages.first { onOpen(first.id) } }
                        .padding(.leading, 30).padding(.trailing, 9)
                        .frame(height: 30)
                        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white))
                        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(Palette.fieldBorder), lineWidth: 1))
                        .accessibilityLabel("Search settings").driveID("settings-search")
                    IconView(SettingsIcons.search).foregroundStyle(Color(Palette.fnt)).padding(.leading, 10).allowsHitTesting(false)
                    // The placeholder, upright and grey (macOS draws a TextField prompt in its own colour).
                    if query.isEmpty {
                        Text("Search…").font(Fonts.swiftUISans(13)).foregroundStyle(Color(Palette.fnt)).padding(.leading, 30).allowsHitTesting(false)
                    }
                }
                .padding(.bottom, 12)
                if sections.isEmpty {
                    Text("No results").textStyle(TextStyle(13, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)).padding(.horizontal, 9).driveID("settings-no-results")
                }
                ForEach(Array(sections.enumerated()), id: \.offset) { index, section in
                    Text(section.title)
                        .textStyle(TextStyle(12.5, weight: 500, lineHeight: 1.4))
                        .foregroundStyle(Color(Palette.fnt))
                        .padding(.horizontal, 9)
                        .padding(.top, index == 0 ? 0 : 16).padding(.bottom, 4)
                    VStack(spacing: 2) {
                        ForEach(section.pages) { page in NavItem(page: page, on: page.id == open) { onOpen(page.id) } }
                    }
                }
            }
            .padding(.vertical, 16).padding(.horizontal, 10)
        }
        .frame(width: 200)
        .background(Color(Palette.gray100))
        .overlay(alignment: .trailing) { Rectangle().fill(Color(Palette.settingsLine)).frame(width: 1) }
        .accessibilityLabel("Settings pages")
    }

    struct NavItem: View {
        let page: SettingsPage
        let on: Bool
        let action: () -> Void
        @State private var hov = false
        var body: some View {
            Button(action: action) {
                HStack(spacing: 9) {
                    IconView(page.icon).foregroundStyle(Color(on ? Palette.ink : Palette.navIdleIcon))
                    Text(page.title).textStyle(TextStyle(13.5, weight: on ? 500 : 400, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 9)
                .frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(on ? Palette.navOn : hov ? Palette.wash2 : .clear)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hov = $0 }
            .accessibilityAddTraits(on ? .isSelected : []).driveID("settings-page=\(page.id)")
        }
    }
}

/// The settings window, over a veil: pages listed on the left, the open one on the right; Escape, × or a press on the
/// veil closes it. Escape in the search field while it holds text clears the text instead.
public struct SettingsDialog: View {
    let pages: [SettingsPage]
    let context: SettingsContext
    @State private var page: String
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// Set by a page while one of its "…" menus is open (Connections' Sign out / Disconnect): Escape is that menu's.
    @State private var menuOpen = false

    public init(pages: [SettingsPage], context: SettingsContext, initialPage: String? = nil) {
        let shown = pages.filter { $0.shown(context) }
        self.pages = shown
        self.context = context
        _page = State(initialValue: SettingsPages.initial(shown, requested: initialPage) ?? "")
    }

    public var body: some View {
        GeometryReader { geo in
            ZStack {
                Color(Palette.veil).ignoresSafeArea().onTapGesture { context.close() }
                dialog
                    .frame(width: min(780, geo.size.width - 32), height: min(540, geo.size.height - 80))
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        // Taken before the workspace's own Escape (which leaves the workspace) can see it, as BuildReject does.
        .background(KeyMonitor(keyCode: 53) {
            switch SettingsEscape.action(menuOpen: menuOpen, inSearch: searchFocused, searchText: query) {
            case .menu: return false
            case .clear: query = ""; return true
            case .close: context.close(); return true
            }
        })
        .environment(\.settingsMenuOpen, $menuOpen)
    }

    private var openPage: SettingsPage? { pages.first { $0.id == page } ?? pages.first }

    private var dialog: some View {
        HStack(spacing: 0) {
            SettingsNav(pages: pages, open: openPage?.id ?? "", query: $query, searchFocused: $searchFocused) { id in
                guard let target = pages.first(where: { $0.id == id }) else { return }
                if let run = target.run { run(context) } else { page = id }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let open = openPage {
                        Text(open.title).font(Fonts.swiftUISans(22, weight: 500)).tracking(-0.22).foregroundStyle(Color(Palette.ink))
                        open.body?(context)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(EdgeInsets(top: 30, leading: 40, bottom: 36, trailing: 40))
            }
        }
        .background(Color(Palette.settingsPanel))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(Palette.settingsBorder), lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            Button(action: context.close) {
                Text("×").font(Fonts.swiftUISans(18)).frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color(Palette.fnt))
            .hover(.ink)
            .accessibilityLabel("Close").driveID("settings-close")
            .padding(.top, 14).padding(.trailing, 16)
        }
        .compositingGroup().shadow(color: .black.opacity(0x24 / 255.0), radius: 24, x: 0, y: 16)
        .rise(0.16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Settings").driveID("settings-dialog")
        .onTapGesture {} // a press inside never reaches the veil
    }
}

private struct SettingsMenuOpenKey: EnvironmentKey { static let defaultValue: Binding<Bool> = .constant(false) }
public extension EnvironmentValues {
    /// A page sets this while one of its "…" menus is open, so Escape closes the menu rather than Settings.
    var settingsMenuOpen: Binding<Bool> {
        get { self[SettingsMenuOpenKey.self] }
        set { self[SettingsMenuOpenKey.self] = newValue }
    }
}

/// The Test data page: Reveal in Finder, Start as a new user (closes Settings first), Reset everything (red; closes first).
public struct TestDataPage: View {
    let test: TestDataActions?
    let close: () -> Void
    public init(test: TestDataActions?, close: @escaping () -> Void) { self.test = test; self.close = close }
    public var body: some View {
        SettingsGroup("Test library") {
            SettingsRow("Reveal in Finder", hint: "Open \(test?.testRootShown ?? "the test folder"), where test mode keeps everything") {
                Button("Reveal") { test?.onReveal() }.buttonStyle(SettingsButtonStyle()).driveID("settings-item=reveal")
            }
            SettingsRow("Start as a new user", hint: "An empty library and onboarding from its first screen") {
                Button("Start over…") { close(); test?.onStartNew() }.buttonStyle(SettingsButtonStyle()).driveID("settings-item=start-new")
            }
            SettingsRow("Reset everything", hint: "Delete the test library and seed it again") {
                Button("Reset…") { close(); test?.onReset() }.buttonStyle(SettingsButtonStyle(color: Palette.del)).driveID("settings-item=reset")
            }
        }
    }
}

/// The Settings gear (styles.css .settings-gear): 32×32, radius 5, the gear in ink; under the pointer or while its window
/// is open #ededed. A press opens the window (no menu).
public struct SettingsGearButton: View {
    let expanded: Bool
    let action: () -> Void
    @State private var hov = false
    public init(expanded: Bool, action: @escaping () -> Void) { self.expanded = expanded; self.action = action }
    public var body: some View {
        Button(action: action) {
            IconView(SettingsIcons.gear)
                .foregroundStyle(Color(Palette.ink))
                .frame(width: 32, height: 32)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color(hov || expanded ? Palette.gearHover : .clear)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hov = $0 }
        .help("Settings")
        .accessibilityLabel("Settings").driveID("settings-gear")
    }
}

/// What a slot shows until its package is wired in (wave 2): the slot's name, faint, centred.
public struct SlotPlaceholder: View {
    let name: String
    public init(_ name: String) { self.name = name }
    public var body: some View {
        Text(name).textStyle(.microcapLarge).foregroundStyle(Color(Palette.fnt)).frame(maxWidth: .infinity, minHeight: 80)
    }
}
