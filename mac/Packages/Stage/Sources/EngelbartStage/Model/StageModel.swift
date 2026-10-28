import Foundation
import EngelbartDoc
import CoreGraphics

// The Stage (Claude Design "Add - Mention Stage.dc.html", 2026-09-23), pure (src/renderer/model/stage.js): which tab a
// thing lands in, what the address field suggests, how a table is read. The controller does the loading.

public enum StageModel {
    /// The most tabs the Stage holds; past it, what is opened takes the place of the tab in front (Hudson, 2026-09-23).
    public static let maxTabs = 15

    private static let guideLinkRx = SRx(#"\[([^\]\n]+)\]\(([^)\s]+)\)"#)

    /// The sections an @discover guide suggests for one paper: every link with a passage to `address`, in order, each once.
    public static func guideSections(_ replyLines: [String], _ address: String?) -> [GuideSection] {
        let where_ = JSStr.trim(address ?? "")
        var out: [GuideSection] = []
        var seen = Set<String>()
        if where_.isEmpty { return out }
        for line in replyLines {
            let text = SRx("`[^`\n]+`").replace(line, with: "")
            for m in guideLinkRx.matchAll(text) {
                let target = PassageLink.splitTarget(m[2])
                if target.find.isEmpty || target.address != where_ { continue }
                let key = "\(target.find)\n\(target.to)"
                if seen.contains(key) { continue }
                seen.insert(key)
                out.append(GuideSection(label: JSStr.trim(SRx(#"\s+"#).replace(m[1] ?? "", with: " ")), find: target.find, to: target.to))
            }
        }
        return out
    }

    public static func sectionAt(_ sections: [GuideSection]?, _ find: String?, _ to: String?) -> Int {
        (sections ?? []).firstIndex { $0.find == find && $0.to == (to ?? "") } ?? -1
    }

    /// A tab a link's passage goes to: it waits there until what the tab shows is ready.
    public static func withPassage(_ tab: StageTab, _ find: String?, _ to: String?, _ sections: [GuideSection]?, page: Int? = nil) -> StageTab {
        guard let find, !find.isEmpty else { return tab }
        var t = tab
        let list = sections ?? []
        t.pendingFind = find; t.pendingTo = (to?.isEmpty == false) ? to : nil; t.pendingPage = page
        t.sections = list; t.activeSection = sectionAt(list, find, to)
        return t
    }

    /// A tab whose passage was found: it waits no longer, and the section it starts is the one in front.
    public static func landTab(_ tab: StageTab, _ find: String) -> StageTab {
        guard tab.pendingFind == find else { return tab }
        var t = tab
        let sections = t.sections ?? []
        t.activeSection = sections.isEmpty ? -1 : sectionAt(sections, find, t.pendingTo)
        t.pendingFind = nil; t.pendingTo = nil; t.pendingPage = nil
        return t
    }

    /// Whether a link's passage found in a pdf opens the find card: not in one an @discover guide's sections came with.
    public static func landingFinds(_ tab: StageTab?) -> Bool { !(tab?.pdf != nil && !(tab?.sections ?? []).isEmpty) }

    /// The library row a link's address is: one the Stage shows whose path (or file: address) or url is that address.
    public static func rowForAddress(_ library: [StageRow], _ address: String?) -> StageRow? {
        let where_ = JSStr.trim(address ?? "")
        if where_.isEmpty { return nil }
        var path: String?
        if SRx(#"^file:\/\/"#, "i").test(where_) { path = JSURL(where_).flatMap { JSStr.decodeURIComponent($0.pathname) } }
        else if where_.hasPrefix("/") { path = where_ }
        let key = SRx(#"^https?:\/\/"#, "i").test(where_) ? AddressKey.addressKey(where_) : ""
        return library.first { row in
            onStage(row) && ((path != nil && row.path == path) || (!key.isEmpty && row.url != nil && AddressKey.addressKey(row.url) == key))
        }
    }

    private static let arxivRx = SRx(#"^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$"#, "i")
    private static let doiRx = SRx(#"^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$"#, "i")

    /// A paper's address as the library spells it: an arXiv pdf is its abstract page, a DOI is doi.org's.
    public static func libraryAddress(_ address: String?) -> String {
        let where_ = JSStr.trim(address ?? "")
        if let m = arxivRx.match(where_) { return "https://arxiv.org/abs/\(m[1] ?? "")" }
        if let m = doiRx.match(where_) { return "https://doi.org/\(m[1] ?? "")" }
        return where_
    }

    public static func paperRow(_ library: [StageRow], _ address: String?) -> StageRow? {
        let spelled = libraryAddress(address)
        return rowForAddress(library, address) ?? (spelled != JSStr.trim(address ?? "") ? rowForAddress(library, spelled) : nil)
    }

    /// A page's save button, by where the page is: not in the library, in it but not this workspace, here.
    public enum SaveState: String, Sendable { case none, lib, here, made, madeSaved = "made-saved" }
    public static let saveLabel: [SaveState: String] = [.none: "+ Save", .lib: "+ Workspace", .here: "✓"]

    /// Whether Save keeps the page in front as a copy (MATH-17): a web page in a tab whose address the library takes for a
    /// plain page (a website with no tags).
    public static func savesPageCopy(webPage: Bool, tabId: String?, hasBytes: Bool, foundType: String?, foundTags: [String]?) -> Bool {
        webPage && tabId != nil && !hasBytes && foundType == "website" && (foundTags?.isEmpty ?? false)
    }

    static func fileAddress(_ file: String) -> String {
        "file://" + file.components(separatedBy: "/").map(JSStr.encodeURIComponent).joined(separator: "/")
    }

    public struct LinkPlan: Equatable, Sendable {
        public var address: String
        public var find: String
        public var to: String
        public var page: Int?
        public var row: StageRow?
        public var key: String
    }

    /// Where a link opens (Stage.openInput).
    public static func linkPlan(_ href: String, _ library: [StageRow]) -> LinkPlan {
        let target = PassageLink.splitTarget(href)
        let passage = !target.find.isEmpty || !(target.cite ?? "").isEmpty
        let kept = passage ? paperRow(library, target.address) : nil
        let row = passage ? (rowForAddress(library, target.address) ?? ((kept?.type == "pdf" && kept?.path != nil) ? kept : nil)) : nil
        if let row { return LinkPlan(address: target.address, find: target.find, to: target.to, page: target.page, row: row, key: "i:\(row.id)") }
        let k = StageAddress.kindOf(target.address)
        let page = k.kind == .web || k.kind == .local || k.kind == .disk
        var key = page && !SRx("^file:", "i").test(target.address) ? "l:\(AddressKey.addressKey(k.url))" : ""
        if key.isEmpty && !target.find.isEmpty && target.address.hasPrefix("/") { key = "l:\(AddressKey.addressKey(fileAddress(target.address)))" }
        return LinkPlan(address: target.address, find: target.find, to: target.to, page: target.page, row: nil, key: key)
    }

    static func keptKey(_ entry: KeptTab?) -> String {
        guard let entry else { return "" }
        if let item = entry.item { return "i:\(item)" }
        let where_ = entry.address ?? ""
        let key = AddressKey.addressKey(where_.hasPrefix("/") ? "file://\(where_)" : where_)
        return key.isEmpty ? "" : "l:\(key)"
    }

    /// What a tab is for "is it open already": the library row it shows, else where it is; a blank tab is nothing.
    public static func tabKey(_ tab: StageTab?) -> String {
        guard let tab else { return "" }
        if let restore = tab.restore { return keptKey(restore) }
        if let item = tab.item { return "i:\(item)" }
        let where_: String
        if let path = tab.file?.path, !path.isEmpty { where_ = "file://\(path)" } else if let pdf = tab.pdf { where_ = pdf.url } else { where_ = tab.url }
        let key = AddressKey.addressKey(where_)
        return key.isEmpty ? "" : "l:\(key)"
    }

    public enum Placement: Equatable, Sendable { case focus(Int), replace(Int), append }

    /// Where something being opened goes (the design's openInStage).
    public static func placeTab(_ tabs: [StageTab], _ activeIndex: Int, _ key: String, newTab: Bool = false, also: String = "") -> Placement {
        if !key.isEmpty && !newTab, let at = tabs.firstIndex(where: { tabKey($0) == key || (!also.isEmpty && tabKey($0) == also) }) { return .focus(at) }
        if activeIndex >= 0 && activeIndex < tabs.count {
            let front = tabs[activeIndex]
            if tabKey(front).isEmpty && front.pdf == nil && front.file == nil && !front.claimed { return .replace(activeIndex) }
        }
        if tabs.count >= maxTabs { return .replace(activeIndex) }
        return .append
    }

    static let reopenKinds: Set<AddressKind.Kind> = [.web, .local, .disk, .file]
    static func reopens(_ address: String) -> Bool {
        !address.isEmpty && JSStr.len(address) <= 2048 && !SRx("^about:", "i").test(address)
            && (SRx(#"^(https?|file):"#, "i").test(address) || address.hasPrefix("/")) && reopenKinds.contains(StageAddress.kindOf(address).kind)
    }

    static func keptTab(_ tab: StageTab) -> KeptTab? {
        if tab.from != nil { return nil }
        if let r = tab.restore { return r.item != nil ? KeptTab(item: r.item, title: r.title) : KeptTab(address: r.address, title: r.title) }
        if let item = tab.item { return KeptTab(item: item, title: tab.row?.name ?? "") }
        if let file = tab.file, file.kind == .loading || file.kind == .error { return nil }
        let raw: String
        if let pdf = tab.pdf { raw = pdf.input.isEmpty ? pdf.url : pdf.input } else if let p = tab.file?.path, !p.isEmpty { raw = p } else { raw = tab.url }
        let address = JSStr.trim(raw)
        guard reopens(address) else { return nil }
        let title = tab.pdf?.name ?? ((tab.file?.name).flatMap { $0.isEmpty ? nil : $0 } ?? (tab.web?.title ?? ""))
        return KeptTab(address: address, title: JSStr.slice(title, 0, 200))
    }

    /// The Stage's tabs as the host keeps them (MATH-10).
    public static func stageSnapshot(_ tabs: [StageTab], activeId: String?) -> StageSnapshot {
        let front = tabs.first { $0.id == activeId } ?? tabs.first
        var out: [KeptTab] = []
        var active = 0
        for tab in tabs {
            guard let kept = keptTab(tab) else { continue }
            if tab.id == front?.id { active = out.count }
            out.append(kept)
        }
        return StageSnapshot(active: active, tabs: out)
    }

    static func untouched(_ tab: StageTab) -> Bool {
        tabKey(tab).isEmpty && tab.pdf == nil && tab.file == nil && !tab.claimed && !tab.opened && tab.pendingFind == nil
    }

    /// The kept tabs given back to the tabs open now. → (tabs, front): front nil leaves the one in front as it is.
    public static func restoreTabs(_ open: [StageTab], _ saved: StageSnapshot?, _ library: [StageRow], make: (KeptTab) -> StageTab) -> (tabs: [StageTab], front: String?) {
        let entries = saved?.tabs ?? []
        let lone = open.count == 1 && untouched(open[0])
        let kept = lone ? [] : open
        let rows = Set(library.filter(onStage).map(\.id))
        var used = Set<String>(), keys = Set<String>()
        var out: [StageTab] = []
        var made: [(Int, StageTab)] = []
        for (i, entry) in entries.enumerated() {
            if let item = entry.item, !rows.contains(item) { continue }
            let key = keptKey(entry)
            if key.isEmpty || keys.contains(key) { continue }
            keys.insert(key)
            if let same = kept.first(where: { !used.contains($0.id) && tabKey($0) == key }) { used.insert(same.id); out.append(same); continue }
            let tab = make(entry)
            out.append(tab)
            made.append((i, tab))
        }
        for t in kept where !used.contains(t.id) { out.append(t) }
        while out.count > maxTabs {
            guard let last = made.popLast() else { break }
            out.removeAll { $0.id == last.1.id }
        }
        if made.isEmpty { return (open, nil) }
        if !kept.isEmpty { return (out, nil) }
        let want = saved?.active ?? 0
        let pick = made.first { $0.0 >= want } ?? made[made.count - 1]
        return (out, pick.1.id)
    }

    /// How long a preview's first page is waited for, retried every wakeRetry while it fails.
    public static let wakeMs: Double = 60_000
    public static let wakeRetryMs: Double = 3_000

    public enum PreviewWait: String, Sendable { case waking, failed }
    public static func previewWait(preview: Bool, drawn: Bool, since: Double, now: Double) -> PreviewWait? {
        if !preview || drawn { return nil }
        return since > 0 && now - since >= wakeMs ? .failed : .waking
    }

    /// A sandbox preview's repository in a few words: "manifund" for manifund/manifund.
    public static func previewName(_ name: String?) -> String { (name ?? "").split(separator: "/").last.map(String.init) ?? "" }

    /// Where a tab is closed from, which tab is in front afterwards (the one to its right, else to its left).
    public static func afterClose(count: Int, activeIndex: Int, closedIndex: Int) -> Int {
        let left = count - 1
        if left <= 0 { return -1 }
        if closedIndex < activeIndex { return activeIndex - 1 }
        return min(activeIndex, left - 1)
    }

    // The tab strip's widths, as Chrome's (2026-10-18).
    public static let tabMaxW: CGFloat = 220
    public static let tabMinW: CGFloat = 36
    public static let tabNarrowW: CGFloat = 90
    public static let tabIconXW: CGFloat = 56
    public static let tabIconSideW: CGFloat = 50

    public static func tabWidth(room: CGFloat, count: Int) -> CGFloat {
        guard count > 0 else { return tabMaxW }
        let share = (room / CGFloat(count)).rounded(.down)
        return max(tabMinW, min(tabMaxW, share))
    }

    public enum TabLook: String, Sendable { case full, icon, iconX = "icon-x", x }
    public static func tabLook(width: CGFloat, active: Bool) -> TabLook {
        if width >= tabNarrowW { return .full }
        if !active { return .icon }
        return width >= tabIconXW ? .iconX : .x
    }

    /// What the tab's hover card says under its title: the site for a page, the path for a file.
    public static func tabPlace(_ value: String?) -> String {
        let v = value ?? ""
        if v.isEmpty || v == "about:blank" { return "" }
        if SRx("^[~/]").test(v) { return v }
        if SRx(#"^file:\/\/"#, "i").test(v) { return JSURL(v).flatMap { JSStr.decodeURIComponent($0.pathname) } ?? v }
        let host = SRx(#"^https?:\/\/(www\.)?"#, "i").replace(v, with: "", global: false).components(separatedBy: CharacterSet(charactersIn: "/?#")).first ?? ""
        return host.isEmpty ? v : host
    }

    /// A library row the Stage can show: anything but a note (notes open in the middle), a workspace or a child.
    public static func onStage(_ row: StageRow?) -> Bool {
        guard let row, !Kind.isNote(row), row.type != "workspace", row.type != "child" else { return false }
        if row.type == "folder" { return (row.url?.isEmpty == false) || (row.folderPath?.isEmpty == false) }
        return (row.url?.isEmpty == false) || (row.path?.isEmpty == false)
    }

    // rail.js
    static let bareHostRx = SRx(#"^(?:www\.)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$"#, "i")
    static let fileNameRx = SRx(#"^[^./]+\.(?:md|markdown|txt|pdf|html?|png|jpe?g|gif|webp|svg|docx?|pptx?|xlsx?|csv|json|ya?ml|py|js|ts|ipynb|tex|bib|zip)$"#, "i")

    /// Something the library could add, by its spelling alone (rail.js looksAddable).
    public static func looksAddable(_ value: String?) -> Bool {
        let v = JSStr.trim(SRx(#"^["'](.*)["']$"#).replace(JSStr.trim(value ?? ""), with: "$1", global: false))
        if v.isEmpty || SRx(#"\s"#).test(v) { return false }
        return SRx(#"^https?:\/\/\S+\.\S*"#, "i").test(v) || SRx(#"^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$"#, "i").test(v) || SRx(#"^(doi:\s*)?10\.\d{4,9}\/\S+$"#, "i").test(v)
            || SRx(#"^(?:ssh|git):\/\/"#, "i").test(v) || SRx(#"^[\w.-]+@[\w.-]+:\S+"#).test(v) || SRx(#"^(~\/|\/|file:\/\/)\S"#).test(v)
            || (bareHostRx.test(v) && !fileNameRx.test(v))
    }

    static func bareHost(_ v: String) -> Bool {
        !SRx(#"\s"#).test(v) && SRx(#"^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$"#).test(v) && !SRx(#"^\d{4}\.\d{4,5}$"#).test(v)
    }
    static func pathLike(_ v: String) -> Bool {
        SRx(#"^(\.{0,2}\/|~\/|file:\/\/)"#, "i").test(v) || (SRx(#"^[\w.-]+(\/[\w.-]+)*\.[a-z0-9]{1,8}$"#, "i").test(v) && !bareHost(v))
    }

    /// Something to go to rather than to search for.
    public static func looksLikePlace(_ value: String?) -> Bool {
        let v = JSStr.trim(value ?? "")
        if v.isEmpty || SRx(#"\s"#).test(v) { return false }
        return looksAddable(v) || SRx(#"^https?:\/\/"#, "i").test(v) || SRx(#"^:?\d{2,5}(\/.*)?$"#).test(v)
            || SRx(#"^localhost(:\d+)?(\/.*)?$"#, "i").test(v) || bareHost(v) || pathLike(v)
    }

    public enum AddressRow: Equatable, Sendable {
        case item(row: StageRow, here: Bool)
        case place(String)
        case search(String)
        case disk
        public var key: String {
            switch self {
            case .item(let row, _): return row.id
            case .place(let s): return "place:\(s)"
            case .search(let s): return "search:\(s)"
            case .disk: return "disk"
            }
        }
    }

    static let shown = 6

    /// The address field's list (the design's stageRows).
    public static func stageRows(query: String, library: [StageRow], inRail: (String) -> Bool, found: StageRow?? = nil) -> [AddressRow] {
        let typed = JSStr.trim(query)
        var rows: [AddressRow] = []
        if !typed.isEmpty && looksLikePlace(typed) {
            if let found = found, let row = found, onStage(row) { rows.append(.item(row: row, here: inRail(row.id))) } else { rows.append(.place(typed)) }
        } else {
            let needle = typed.lowercased()
            func hay(_ row: StageRow) -> String { [row.name, row.url ?? "", row.path ?? "", Kind.kindLabel(row)].joined(separator: " ").lowercased() }
            func hit(_ row: StageRow) -> Bool { onStage(row) && (needle.isEmpty || hay(row).contains(needle)) }
            let here = library.filter { inRail($0.id) && hit($0) }.prefix(shown)
            let rest = library.filter { !inRail($0.id) && hit($0) }.prefix(shown)
            rows += here.map { .item(row: $0, here: true) }
            rows += rest.map { .item(row: $0, here: false) }
            if !typed.isEmpty { rows.append(.search(typed)) }
        }
        rows.append(.disk)
        return rows
    }

    /// A csv or tsv as rows of cells: quoted fields may hold the delimiter, doubled quotes and line breaks.
    public static func parseTable(_ text: String, delimiter: Character = ",", limit: Int = 5000) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var cell = ""
        var quoted = false
        let s = Array(text.unicodeScalars)
        var i = 0
        let quote: Unicode.Scalar = "\""
        let delim = delimiter.unicodeScalars.first!
        while i < s.count {
            let c = s[i]
            if quoted {
                if c == quote && i + 1 < s.count && s[i + 1] == quote { cell.unicodeScalars.append(quote); i += 2; continue }
                if c == quote { quoted = false } else { cell.unicodeScalars.append(c) }
                i += 1; continue
            }
            if c == quote && cell.isEmpty { quoted = true }
            else if c == delim { row.append(cell); cell = "" }
            else if c == "\n" || c == "\r" {
                if c == "\r" && i + 1 < s.count && s[i + 1] == "\n" { i += 1 }
                row.append(cell); rows.append(row); row = []; cell = ""
                if rows.count >= limit { return rows }
            } else { cell.unicodeScalars.append(c) }
            i += 1
        }
        if !cell.isEmpty || !row.isEmpty { row.append(cell); rows.append(row) }
        return rows
    }
}
