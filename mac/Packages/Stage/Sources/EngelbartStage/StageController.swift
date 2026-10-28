import AppKit
import EngelbartDoc
import EngelbartCore
import EngelbartUI

// The Stage (Claude Design "Add - Mention Stage.dc.html", 2026-09-23; src/renderer/workspace/Stage.jsx): the right pane
// that opens anything. A tab shows whatever it was given — a library row, a link, a file on disk — in the way its format
// asks: a page (the web, a local server, an html file) in its WKWebView; a pdf (from the web, from disk or from the
// library) in the host's pdf viewer, with its ink; a docx (textutil) as a page made from it; markdown drawn as text, a csv
// or tsv as a table, a picture as itself, other text as it is. At most 15 tabs: what is opened comes forward if it is open
// already, takes a blank tab in front, else gets its own (at 15 it takes the place of the tab in front). The tabs are kept
// per project across relaunches. ⌘T and ⌘W work from anywhere but the terminal and bring the Stage forward; ⌘F finds in
// whatever is in front. The address field opens anything; a link may name a passage (#find=), found once the tab is ready.

@MainActor
public final class StageController: NSViewController {
    public weak var host: StageHost?
    public let browser: BrowserViews

    // what the host gives (RightPane / Workspace props)
    /// Whether the Stage is the right pane's mode now (Stage | Terminal).
    public var visible = true { didSet { if visible != oldValue { render() } } }
    /// Full screen (the arrows at the strip's right): `onFull` toggles it.
    public var full = false { didSet { strip.full = full; render() } }
    public var onFull: (() -> Void)? { didSet { strip.showsFull = onFull != nil } }
    /// The address field's save button, as the workspace decides it from `stagePageChanged`.
    public var save: StageSave? { didSet { renderAddress() } }
    /// The workspace's answers being written (each with its rowId/url, askId, markId, source).
    public var pendingAsks: [JSONValue] = [] { didSet { pendingAsksChanged() } }
    /// "Import sign-ins…" (⋮): the app's picker (ImportSigninsWindow by default).
    public var onImportSignins: (() -> Void)?

    // state (Stage.jsx useState)
    var tabs: [StageTab] = [StageTab.blank()]
    var activeId: String?
    var draft = ""
    var typing = false
    var pick = 0
    var found: (input: String, row: StageRow?)?
    var lookupTask: Task<Void, Never>?
    var arrowed = false
    var finding = false
    var findText = ""
    var matches: (matches: Int, active: Int)?
    var device = "fit"
    var customW = "390"
    var waits: [String: Double] = [:]
    var now = Date().timeIntervalSince1970 * 1000
    var boxing: String?
    var boxRemoved: (id: String, markId: String)?
    var boxTimer: Timer?
    var pdfSeq = 0
    var jumped: (tabId: String, text: String)?
    var restored = false
    var stageSent = ""
    var stageTimer: Timer?
    var waitTimer: Timer?
    var retryTimer: Timer?
    var lastBoxAsks = ""
    var lastHost = ""
    var hubToken: EventHub.Token?
    var outsideMonitor: Any?
    var lastWakeRetry: Double = 0

    // views
    let root = FlippedView()
    let strip = TabStripView()
    let address = AddressBarView()
    let list = AddressListView()
    let content = FlippedView()
    let findCard = FindCardView()
    let sectionsMenu = SectionsMenuView()
    var saveCard: SaveCardView?
    var pdfView: (key: String, viewer: StagePDFViewing)?
    var fileView: (key: String, viewer: StageFileView)?
    var plain: (key: String, view: NSView)?

    static let maxTabs = StageModel.maxTabs
    static let devices: [(id: String, name: String, w: CGFloat, h: CGFloat)] = [
        ("fit", "Fit panel", 0, 0), ("se", "iPhone SE", 375, 667), ("12", "iPhone 12 Pro", 390, 844),
        ("15", "iPhone 15 Pro Max", 430, 932), ("px8", "Pixel 8", 412, 915), ("ipad", "iPad mini", 768, 1024),
    ]
    static let retryLocalSeconds: TimeInterval = 2
    static let stageSaveSeconds: TimeInterval = 0.15
    static let removedSeconds: TimeInterval = 5
    /// The window's resize strips: a page stops this short of the window's right and bottom edges.
    public static let windowEdge: CGFloat = 6
    static let errConnectionRefused = -102

    /// `pageMarks`: the library's web marks for the pages' highlights and boxes; nil files none.
    public init(host: StageHost, pageMarks: StagePageMarks? = nil, browser: BrowserViews? = nil) {
        self.host = host
        self.browser = browser ?? BrowserViews(pageMarks: pageMarks)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    public override func loadView() {
        view = root
        root.fill = Palette.panel
        content.fill = Palette.panel2
        for v in [content, address, strip] { root.addSubview(v) }
        browser.container = content
        browser.onEvent = { [weak self] event in self?.handle(event) }
        wireViews()
        // a link clicked in the terminal asks for a page in a new tab (address.js OPEN_IN_BROWSER)
        hubToken = EventHub.shared.on(StageAddress.openInBrowserEvent) { [weak self] payload in
            MainActor.assumeIsolated { if let url = payload["url"]?.string { self?.openInput(url) } }
        }
        if activeId == nil { activeId = tabs[0].id }
        restore()
        render()
    }

    public override func viewDidLayout() {
        super.viewDidLayout()
        layoutAll()
    }

    // --------------------------------------------------------------------------------------------- what is in front

    var tab: StageTab { tabs.first { $0.id == activeId } ?? tabs[0] }
    var activeIndex: Int { tabs.firstIndex { $0.id == tab.id } ?? 0 }

    static func isPage(_ k: AddressKind) -> Bool { k.kind == .web || k.kind == .local || k.kind == .disk }
    static let viewKinds: Set<StageFile.Kind> = [.md, .table, .text, .image, .folder, .unsupported, .error, .loading]
    static func fileUrl(_ file: String) -> String { StageModel.fileAddress(file) }
    static func basename(_ value: String) -> String { value.components(separatedBy: "/").last ?? value }

    var pdf: StagePDF? { tab.pdf }
    /// A file drawn here.
    var drawnFile: StageFile? { tab.pdf == nil && tab.file.map { Self.viewKinds.contains($0.kind) } == true ? tab.file : nil }
    var kind: AddressKind { StageAddress.kindOf(tab.url) }
    var isPageTab: Bool { pdf == nil && drawnFile == nil && (Self.isPage(kind) || tab.opened) }
    var isBlank: Bool { pdf == nil && drawnFile == nil && !isPageTab && kind.kind == .blank && tab.restore == nil }
    var failed: PageError? { isPageTab ? tab.web?.error : nil }
    var previewRow: StageRow? { isPageTab ? host?.previewRow(for: failed?.url ?? tab.web?.url ?? tab.url) : nil }
    var wait: StageModel.PreviewWait? {
        let since = waits[tab.id] ?? 0
        return StageModel.previewWait(preview: previewRow != nil, drawn: tab.web?.drawn ?? false, since: since, now: max(now, since))
    }
    var showing: Bool { visible && isPageTab && failed == nil && wait == nil }

    /// Where the tab is, as the address field shows it: a file by its path (a docx too).
    var shownUrl: String { pdf.map { $0.input.isEmpty ? $0.url : $0.input } ?? tab.file?.path ?? tab.restore?.address ?? tab.url }
    var shownDraft: String { StageAddress.stripScheme(shownUrl) }

    /// The thing in front for the library: its address or path, and for a pdf from the web its bytes.
    var pageInput: String? {
        if let pdf { return pdf.error.isEmpty ? (pdf.input.isEmpty ? (BrowserRules.isFileUrl(pdf.url) ? StageAddress.stripScheme(pdf.url) : pdf.url) : pdf.input) : nil }
        if let v = drawnFile { return v.kind != .error && v.kind != .loading && !v.path.isEmpty ? v.path : nil }
        if tab.file?.kind == .doc { return tab.file?.path }
        if isPageTab { return tab.web?.url.isEmpty == false ? tab.web?.url : tab.url }
        return nil
    }
    var pageTitle: String {
        if let row = tab.row { return row.name }
        if let pdf { return pdf.name }
        if drawnFile != nil || tab.file?.kind == .doc { return tab.file?.name.isEmpty == false ? tab.file!.name : Self.basename(pageInput ?? "") }
        if isPageTab { return tab.web?.title.isEmpty == false ? tab.web!.title : StageAddress.stripScheme(pageInput ?? "") }
        return ""
    }
    var savable: Bool {
        guard let input = pageInput, !SRx("^about:", "i").test(input) else { return false }
        return StageAddress.kindOf(pdf?.url ?? tab.url).kind != .local
    }

    func update(_ id: String, _ change: (inout StageTab) -> Void) {
        guard let i = tabs.firstIndex(where: { $0.id == id }) else { return }
        change(&tabs[i])
    }

    // ------------------------------------------------------------------------------------------------------ tabs

    func dropTab(_ id: String) {
        guard let at = tabs.firstIndex(where: { $0.id == id }) else { return }
        let gone = tabs[at]
        let rest = tabs.filter { $0.id != id }
        if rest.isEmpty { let fresh = StageTab.blank(); tabs = [fresh]; activeId = fresh.id; render(); return }
        let front = tabs.firstIndex { $0.id == (activeId ?? tabs[0].id) } ?? 0
        if front == at {
            // back to the tab that opened it, as a sign-in expects
            if let back = rest.first(where: { $0.id == gone.from }) { activeId = back.id }
            else { activeId = rest[StageModel.afterClose(count: tabs.count, activeIndex: front, closedIndex: at)].id }
        }
        tabs = rest
        render()
    }

    func adoptTab(_ url: String, _ id: String, _ from: String?) {
        var next = StageTab(id: id)
        next.url = url.isEmpty ? "about:blank" : url
        next.from = from
        next.opened = true
        tabs.append(next)
        activeId = id
        render()
    }

    /// Where something being opened goes (StageModel.placeTab): the new tab's id, or nil when it was open already.
    @discardableResult
    func claim(_ key: String, find: String = "", to: String = "", newTab: Bool = false, sections: [GuideSection]? = nil, also: String = "", page: Int? = nil) -> String? {
        let front = max(0, tabs.firstIndex { $0.id == (activeId ?? tabs[0].id) } ?? 0)
        switch StageModel.placeTab(tabs, front, key, newTab: newTab, also: also) {
        case .focus(let i):
            let id = tabs[i].id
            activeId = id
            if !find.isEmpty { update(id) { $0 = StageModel.withPassage($0, find, to, sections, page: page) } }
            render()
            return nil
        case .replace(let i):
            var fresh = StageTab.blank(); fresh.claimed = true
            fresh = StageModel.withPassage(fresh, find, to, sections, page: page)
            browser.close(tabs[i].id)
            tabs[i] = fresh
            activeId = fresh.id
            render()
            return fresh.id
        case .append:
            var fresh = StageTab.blank(); fresh.claimed = true
            fresh = StageModel.withPassage(fresh, find, to, sections, page: page)
            tabs.append(fresh)
            activeId = fresh.id
            render()
            return fresh.id
        }
    }

    // --------------------------------------------------------------------------------------------------- loading

    /// A page the browser refuses (a file outside the home folder) fails like one that did not load.
    func load(_ id: String, _ url: String) {
        do { try browser.open(id, url) } catch {
            update(id) { t in
                var web = t.web ?? PageState(id: id, url: url)
                web.url = url
                web.error = PageError(code: 0, description: error.localizedDescription, url: url)
                t.web = web
            }
            render()
        }
    }

    /// A pdf's ink: a library row's own, else kept by the pdf's address.
    func readInk(_ id: String, bytes: Data, rowId: String?, url: String?) {
        Task { @MainActor in
            let marks = rowId != nil ? await host?.readAnnotations(rowId: rowId!) : await host?.readPageAnnotations(url: url ?? "")
            update(id) { t in if t.pdf?.bytes == bytes { t.pdf?.marks = marks ?? .object([:]) } }
            render()
        }
    }

    /// What the host read at a path goes into the tab: a pdf to the viewer, a page (or a docx made one) to the view,
    /// anything else drawn here.
    func apply(_ id: String, _ result: StageFile, rowId: String?) {
        switch result.kind {
        case .pdf:
            pdfSeq += 1
            let seq = pdfSeq
            update(id) { t in
                t.url = "about:blank"; t.file = nil; t.pdfForward = nil
                t.pdf = StagePDF(url: result.url ?? "", input: t.row.map { $0.url ?? $0.path ?? "" } ?? result.path, name: t.row?.name ?? result.name, seq: seq, bytes: result.bytes, rowId: rowId)
            }
            if let bytes = result.bytes { readInk(id, bytes: bytes, rowId: rowId, url: result.url) }
        case .page, .doc:
            update(id) { t in t.url = result.url ?? ""; t.pdf = nil; t.pdfForward = nil; t.opened = false; t.file = result.kind == .doc ? result : nil; t.web?.error = nil }
            load(id, result.url ?? "")
        default:
            update(id) { t in t.url = "about:blank"; t.pdf = nil; t.pdfForward = nil; t.file = result }
        }
        render()
    }

    func readPath(_ id: String, _ input: String, rowId: String?) {
        update(id) { t in t.url = "about:blank"; t.pdf = nil; t.pdfForward = nil; t.file = StageFile(kind: .loading, path: input, name: Self.basename(input)) }
        render()
        Task { @MainActor in
            do {
                guard let result = try await host?.readStageFile(input) else { return }
                apply(id, result, rowId: rowId)
            } catch {
                update(id) { t in t.file = StageFile(kind: .error, path: input, name: Self.basename(input), message: error.localizedDescription) }
                render()
            }
        }
    }

    /// A library row in a tab of its own: its file when it has one, else its address, else its folder.
    func showRow(_ id: String, _ row: StageRow) {
        if GitHubPages.isSignIn(row.url) && row.path == nil { host?.openExternal(row.url ?? ""); return }
        update(id) { $0.item = row.id; $0.row = row }
        if row.type == "pdf", let path = row.path {
            pdfSeq += 1
            let seq = pdfSeq
            update(id) { t in t.url = "about:blank"; t.file = nil; t.pdf = StagePDF(url: row.url ?? Self.fileUrl(path), input: row.url ?? path, name: row.name, seq: seq, loading: true, rowId: row.id) }
            render()
            Task { @MainActor in
                do {
                    guard let bytes = try await host?.readLibraryFile(row.id) else { return }
                    update(id) { t in if t.pdf?.seq == seq { t.pdf?.loading = false; t.pdf?.bytes = bytes } }
                    readInk(id, bytes: bytes, rowId: row.id, url: nil)
                } catch {
                    update(id) { t in if t.pdf?.seq == seq { t.pdf?.loading = false; t.pdf?.error = error.localizedDescription } }
                }
                render()
            }
            return
        }
        // a picture kept with the address it was dragged from shows its copy, as a saved pdf does (MATH-19)
        if let url = row.url, !(row.path != nil && (row.type == "html" || row.type == "image")) {
            update(id) { t in t.url = url; t.file = nil; t.pdf = nil }
            load(id, url)
            render()
            return
        }
        if let path = row.path { readPath(id, path, rowId: row.id) } else if let folder = row.folderPath { readPath(id, folder, rowId: row.id) }
    }

    static let tldRx = SRx(#"\.(com|org|net|io|dev|ai|app|edu|gov|co|xyz|me)(?:[/:#?].*)?$"#, "i")

    /// Typed (or picked) into the tab in front: a path is read, anything else is where the page goes.
    func navigate(_ id: String, _ input: String) async {
        if let url = StageAddress.kindOf(input).url, GitHubPages.isSignIn(url) { host?.openExternal(url); typing = false; draft = StageAddress.stripScheme(tab.url); render(); return }
        update(id) { $0.pdf = nil; $0.pdfForward = nil; $0.item = nil; $0.row = nil }
        var next = StageAddress.kindOf(input)
        let hasScheme = SRx(#"^https?:\/\/"#, "i").test(input)
        let path = next.kind == .disk || next.kind == .file || (!hasScheme && next.kind != .local && next.kind != .sandbox && next.kind != .blank
            && StageModel.looksLikePlace(input) && SRx(#"^[.~/]|\.[a-z0-9]{1,8}(?:[#?].*)?$"#, "i").test(input) && !Self.tldRx.test(input))
        if path {
            let place = next.kind == .disk ? (next.url ?? input) : input
            do {
                if let result = try await host?.readStageFile(place) {
                    apply(id, result, rowId: nil)
                    draft = StageAddress.stripScheme(result.path.isEmpty ? place : result.path)
                    render()
                    return
                }
            } catch {
                if next.kind == .file || next.kind == .disk {
                    update(id) { t in t.url = "about:blank"; t.file = StageFile(kind: .error, path: input, name: Self.basename(input), message: error.localizedDescription) }
                    draft = input
                    render()
                    return
                }
                next = StageAddress.kindOf("https://\(input)") // `report.html` that is no file here: a site after all
            }
        }
        if Self.isPage(next), let url = next.url { load(id, url) }
        update(id) { t in t.opened = false; t.file = nil; t.url = next.url ?? input; if Self.isPage(next) { t.web?.error = nil } }
        draft = StageAddress.stripScheme(next.url ?? input)
        render()
    }

    // ------------------------------------------------------------------------------------------ opened from elsewhere

    /// A library row: the sidebar, an @mention, the all-projects screen. Open already: its tab comes to the front as it
    /// was left; `newTab` (a ⌘-click) opens another.
    public func openRow(_ row: StageRow, find: String = "", to: String = "", newTab: Bool = false, page: Int? = nil) {
        if GitHubPages.isSignIn(row.url) && row.path == nil { host?.openExternal(row.url ?? ""); return }
        let where_ = row.path.map(Self.fileUrl) ?? row.url ?? ""
        let also = !where_.isEmpty && !AddressKey.addressKey(where_).isEmpty ? "l:\(AddressKey.addressKey(where_))" : ""
        if let id = claim("i:\(row.id)", find: find, to: to, newTab: newTab, also: also, page: page) { showRow(id, row) }
    }

    /// A link (a document's, the terminal's, an answer's): a passage to a library row opens the row; any other link its
    /// address. `newTab`: a ⌘-click, in a tab of its own. `sections`: an @discover guide's for the paper.
    public func openInput(_ input: String, newTab: Bool = false, sections: [GuideSection]? = nil) {
        let plan = StageModel.linkPlan(input, host?.library() ?? [])
        if let row = plan.row { openRow(row, find: plan.find, to: plan.to, newTab: newTab, page: plan.page); return }
        if let url = StageAddress.kindOf(plan.address).url, GitHubPages.isSignIn(url) { host?.openExternal(url); return }
        if let id = claim(plan.key, find: plan.find, to: plan.to, newTab: newTab, sections: sections, page: plan.page) {
            Task { @MainActor in await navigate(id, plan.address) }
        }
    }

    /// A file inside a library folder, mentioned (MATH-22): its tab, unless one is open already.
    public func openFile(_ file: String, newTab: Bool = false) {
        if let id = claim("l:\(AddressKey.addressKey(Self.fileUrl(file)))", newTab: newTab) { readPath(id, file, rowId: nil) }
    }

    /// Files from the computer open as tabs of their own; past 15 the rest are left.
    public func openPaths(_ paths: [String]) {
        var room = Self.maxTabs - tabs.filter { !StageModel.tabKey($0).isEmpty || $0.pdf != nil || $0.file != nil }.count
        for file in paths {
            if room <= 0 { break }
            if let id = claim("l:\(AddressKey.addressKey(Self.fileUrl(file)))") { readPath(id, file, rowId: nil); room -= 1 }
        }
    }

    func chooseFiles() {
        typing = false
        view.window?.makeFirstResponder(nil)
        Task { @MainActor in
            if let paths = try? await host?.pickPaths(), !paths.isEmpty { openPaths(paths) }
        }
    }

    /// ⌘T: a blank tab in front with the caret in the address (nothing at 15).
    public func newTab() {
        guard tabs.count < Self.maxTabs else { return }
        let fresh = StageTab.blank()
        tabs.append(fresh)
        activeId = fresh.id
        draft = ""
        finding = false
        render()
        DispatchQueue.main.async { [weak self] in self?.focusAddress() }
    }

    public func closeTab(_ id: String? = nil) {
        let target = id ?? tab.id
        browser.close(target)
        dropTab(target)
        strip.hideCard()
    }

    func select(_ id: String) {
        activeId = id
        typing = false
        strip.hideCard()
        render()
    }

    /// ⌘1–9: the Stage's n-th tab (when the Stage was clicked last). → whether there is one.
    @discardableResult
    public func tabAt(_ index: Int) -> Bool {
        guard index >= 0, index < tabs.count else { return false }
        select(tabs[index].id)
        return true
    }

    /// What is in front, for @bart's <stage>: a web page { kind: web, url, title, tab }; a pdf { rowId, url, page, kind: pdf };
    /// else { kind: file | page }; nil past what the host takes (an address over 4096).
    public func front() -> JSONValue? {
        let t = tab
        if t.pdf == nil && t.file == nil && (Self.isPage(StageAddress.kindOf(t.url)) || t.opened) {
            let url = t.web?.url.isEmpty == false ? t.web!.url : t.url
            if !url.isEmpty && url != "about:blank" {
                return url.utf16.count > 4096 ? nil : ["kind": "web", "url": .string(url), "title": .string(t.web?.title.isEmpty == false ? t.web!.title : t.row?.name ?? ""), "tab": .string(t.id)]
            }
        }
        guard let p = t.pdf, p.error.isEmpty, p.rowId != nil || !p.url.isEmpty else { return ["rowId": .null, "url": .null, "page": 1, "kind": .string(t.file != nil ? "file" : "page")] }
        if p.rowId == nil && p.url.utf16.count > 4096 { return nil }
        let page = pdfView?.viewer.currentPage() ?? 0
        return ["rowId": p.rowId.map(JSONValue.string) ?? .null, "url": p.rowId == nil ? .string(p.url) : .null, "page": .number(Double(page > 0 ? page : 1)), "kind": "pdf"]
    }

    // -------------------------------------------------------------------------------------- what the pages say

    func handle(_ event: BrowserEvent) {
        EventHub.shared.post(event.channel, eventPayload(event))
        switch event {
        case .state(let state): pageState(state)
        case .pdf(let id, let url, let name, let under, let loading, let bytes, let error): receivePdf(id: id, url: url, name: name, under: under, loading: loading, bytes: bytes, error: error)
        case .found(let id, let n, let active): if finding && id == tab.id { matches = (n, active); renderFind() }
        case .openTab(let id, let url, let from): adoptTab(url, id, from)
        case .openLinkInNewTab(let url, let from):
            if let id = claim("", newTab: true) { update(id) { $0.from = from }; Task { @MainActor in await navigate(id, url) } }
        case .closed(let id): dropTab(id)
        case .login(let request):
            LoginPrompt.ask(request, window: view.window) { [weak self] answer in self?.browser.answerLogin(request.requestId, answer) }
        case .focusAddress: focusAddress()
        case .shortcut(let name, let tab): shortcut(name, from: tab)
        case .focused, .nextWorkspace: break // the host's (EventHub)
        case .boxing(let id, let on): boxing = on ? id : (boxing == id ? nil : boxing); renderAddress()
        case .boxRemoved(let id, let markId):
            boxTimer?.invalidate()
            boxRemoved = (id, markId)
            boxTimer = Timer.scheduledTimer(withTimeInterval: Self.removedSeconds, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.boxRemoved = nil; self?.renderAddress() } }
            renderAddress()
        case .boxRestored(let id, _): if boxRemoved?.id == id { boxRemoved = nil; renderAddress() }
        case .boxAsk(let payload): boxAsk(payload)
        case .boxStop(let askId):
            if let held = pendingAsks.first(where: { $0["askId"]?.string == askId }), held["error"] != nil, held["error"] != .null { host?.dismissAsk(askId) } else { host?.stopAsk(askId) }
        }
    }

    func eventPayload(_ event: BrowserEvent) -> JSONValue {
        switch event {
        case .focused(let id): return ["id": id.map(JSONValue.string) ?? .null]
        case .shortcut(let name, let tab): return ["name": .string(name), "tab": tab.map(JSONValue.string) ?? .null]
        case .boxing(let id, let on): return ["id": .string(id), "on": .bool(on)]
        case .boxAsk(let payload): return payload
        default: return .null
        }
    }

    /// The page reports where it is; a tab showing a file keeps its own address. When the page under a pdf goes somewhere
    /// else, the pdf is gone, and so is Forward to one; a row's page gone elsewhere by a link is no longer that row.
    func pageState(_ state: PageState) {
        update(state.id) { t in
            let wasPage = t.opened || Self.isPage(StageAddress.kindOf(t.url))
            t.web = state
            if wasPage && !state.url.isEmpty { t.url = state.url }
            func moved(_ under: String) -> Bool { !state.loading && (state.url.isEmpty ? "about:blank" : state.url) != (under.isEmpty ? "about:blank" : under) }
            if let pdf = t.pdf, !pdf.loading, pdf.under != "about:blank", moved(pdf.under) { t.pdf = nil }
            if let fwd = t.pdfForward, moved(fwd.under) { t.pdfForward = nil }
            if let rowUrl = t.row?.url, !state.url.isEmpty, !state.loading, t.pdf == nil, AddressKey.addressKey(state.url) != AddressKey.addressKey(rowUrl), t.file?.kind != .doc { t.item = nil; t.row = nil }
            if t.file?.kind == .doc, !state.url.isEmpty, !state.loading, !BrowserRules.isFileUrl(state.url) { t.file = nil }
        }
        render()
    }

    /// A tab's pdf from a page: loading, then its bytes (and the ink kept for its address) or why not.
    func receivePdf(id: String, url: String, name: String, under: String, loading: Bool, bytes: Data?, error: String?) {
        pdfSeq += 1
        let fresh = pdfSeq
        update(id) { t in
            let seq = (t.pdf?.loading == true && t.pdf?.url == url) ? t.pdf!.seq : fresh
            let rowId = (t.row?.url).flatMap { AddressKey.addressKey($0) == AddressKey.addressKey(url) ? t.row?.id : nil }
            let next = StagePDF(url: url, input: url, name: rowId != nil ? (t.row?.name ?? name) : name, under: under.isEmpty ? "about:blank" : under, seq: seq, loading: loading, bytes: bytes, error: error ?? "", rowId: rowId)
            let was = t.pdf ?? t.pdfForward
            let same = t.pendingFind != nil || (was.map { AddressKey.addressKey($0.url) == AddressKey.addressKey(url) } ?? false)
            if !same && !(t.sections ?? []).isEmpty { t.sections = nil; t.activeSection = -1 }
            t.url = next.under; t.pdf = next; t.pdfForward = nil; t.file = nil
        }
        render()
        guard let bytes else { return }
        Task { @MainActor in
            let marks = await host?.readPageAnnotations(url: url)
            update(id) { t in if t.pdf?.bytes == bytes { t.pdf?.marks = marks ?? .object([:]) } }
            render()
        }
    }

    // --------------------------------------------------------------------------------------- @bart on a highlight

    /// A box's or a highlight's card asked @bart (MATH-70 build 2, 2026-10-18): asked through the host as from a highlight.
    func boxAsk(_ p: JSONValue) {
        guard let markId = p["markId"]?.string, let url = p["url"]?.string, let question = p["question"]?.string else { return }
        let ask = StageAsk(markId: markId, source: "web", rowId: nil, url: url, page: nil, question: question, note: p["note"]?.string ?? "",
                           turns: p["turns"]?.array ?? [], quote: p["quote"]?.string ?? "", pageText: p["pageText"]?.string ?? "", paper: p["title"]?.string ?? "", extra: p)
        Task { @MainActor in _ = await host?.ask(ask) }
    }

    /// What is running from boxes goes back for the card to show.
    func pendingAsksChanged() {
        let boxAsks = pendingAsks.filter { $0["source"]?.string == "web" && $0["askId"] != nil && $0["markId"] != nil }
        let text = JSONValue.array(boxAsks).text()
        if text != lastBoxAsks { lastBoxAsks = text; browser.setBoxAsks(boxAsks) }
        renderContent(force: false)
    }

    /// A finished answer onto its mark: the viewer in front adds it when it shows that pdf, and every tab holding it takes it.
    public func landAnswer(rowId: String?, url: String?, page: Int, markId: String, entry: JSONValue) {
        func same(_ p: StagePDF?) -> Bool { guard let p else { return false }; return rowId != nil ? p.rowId == rowId : (p.rowId == nil && url != nil && p.url == url) }
        if same(tab.pdf) { pdfView?.viewer.addAsk(page: page, markId: markId, entry: entry) }
        for i in tabs.indices where same(tabs[i].pdf) && tabs[i].pdf?.marks != nil {
            let marks = tabs[i].pdf!.marks!
            tabs[i].pdf?.marks = MarkAnswers.withAsk(marks, page: String(page), markId: markId, entry: entry)
        }
    }

    // --------------------------------------------------------------------------- kept across relaunches (MATH-10)

    func restore() {
        Task { @MainActor in
            let saved = await host?.stage()
            restored = true
            var made: [KeptTab: StageTab] = [:]
            let plan = StageModel.restoreTabs(tabs, saved, host?.library() ?? []) { entry in
                if let t = made[entry] { return t }
                var t = StageTab.blank(); t.restore = entry; made[entry] = t; return t
            }
            let was = activeId
            tabs = plan.tabs
            activeId = plan.front ?? was ?? tabs.first?.id
            render()
        }
    }

    /// The tabs as the host keeps them, written 150 ms after they last changed (and at once when asked: flushStage).
    func keepStage() {
        guard restored else { return }
        let value = StageModel.stageSnapshot(tabs, activeId: activeId)
        let text = value.json.text()
        if text == stageSent { return }
        stageSent = text
        stageTimer?.invalidate()
        stageTimer = Timer.scheduledTimer(withTimeInterval: Self.stageSaveSeconds, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.flushStage(value) } }
    }

    var queued: StageSnapshot?
    func flushStage(_ value: StageSnapshot? = nil) {
        stageTimer?.invalidate()
        let v = value ?? (restored ? StageModel.stageSnapshot(tabs, activeId: activeId) : nil)
        if let v { host?.setStage(v) }
    }

    /// The project closes or the window goes: the tabs are kept now, and every page is closed.
    public func teardown() {
        if let hubToken { EventHub.shared.off(hubToken) }
        flushStage()
        browser.closeAll()
    }

    /// A tab given back opens when it comes forward: a library row as the sidebar opens it (one gone closes), a place
    /// as if typed.
    func openRestored() {
        guard let entry = tab.restore, !tab.restoreOpening else { return }
        let id = tab.id
        if let item = entry.item {
            let row = host?.library().first { $0.id == item }
            update(id) { $0.restore = nil }
            if let row, StageModel.onStage(row) { showRow(id, row) } else { dropTab(id) }
            return
        }
        update(id) { $0.restoreOpening = true }
        Task { @MainActor in
            await navigate(id, entry.address ?? "")
            update(id) { $0.restore = nil; $0.restoreOpening = false }
            render()
        }
    }
}

extension KeptTab: Hashable {
    public func hash(into h: inout Hasher) { h.combine(item); h.combine(address); h.combine(title) }
}
