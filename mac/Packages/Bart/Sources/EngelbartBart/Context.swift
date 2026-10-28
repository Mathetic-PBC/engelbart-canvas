import Foundation
import EngelbartDoc
import EngelbartCore

// context.cjs — what one @bart question carries (2026-09-19): the workspace document, the note the question was asked
// from, every mentioned note in full at the place it is mentioned, the library as Context.json with a `mentioned` flag
// per item, and where things are on disk so the agent's own file tools can open the rest. A follow-up carries all of that
// again, read again, and the earlier turns of its exchange as well. A question asked from a note on a pdf highlight
// (MATH-27) carries the passage as <highlight> (with the page's text around it), and the workspace the Stage was opened
// from as background. An @bart question also carries the person's highlights: <stage> (the paper or web page in front,
// with the page in view; a web page with its live selection and a picture, build 3a; an Overleaf editor in front as its
// own <stage>, MATH-65) and <highlights> (the mentioned papers and pages); `now` is the two again for a resumed session.
// A mentioned Zotero item's folder is granted; <engelbart> names the mirror of the connected library. A box (MATH-70)
// is read from the page's ink by its id. Chat sees each item's kept text and notes files (2026-10-22/23).

public struct HighlightInput: Equatable, Sendable {
    public var quote: String, note: String, paper: String?, pageText: String
    public init(quote: String = "", note: String = "", paper: String? = nil, pageText: String = "") { self.quote = quote; self.note = note; self.paper = paper; self.pageText = pageText }
}

/// What is in front in the Stage (ipc.cjs stageInput): a pdf { rowId, url, page } or a web page { url, title, tab }.
public struct StageInput: Equatable, Sendable {
    public var kind: String
    public var rowId: String?, url: String?, page: Int?, title: String?, tab: String?
    public init(kind: String, rowId: String? = nil, url: String? = nil, page: Int? = nil, title: String? = nil, tab: String? = nil) {
        self.kind = kind; self.rowId = rowId; self.url = url; self.page = page; self.title = title; self.tab = tab
    }
}

/// buildContext's result.
public struct BartContext: Sendable {
    public var project: ProjectRecord
    public var dirs: [String]
    public var head: String
    public var contextJson: String
    public var mentionedFiles: String
    public var files: [(path: String, folder: String, exists: Bool)]
    public var documents: String
    /// @bart's <stage> and <highlights> as they are now, what a resumed turn is sent ('' for the other agents).
    public var now: String
    public var entries: [CatalogEntryView]
    public var workspaceName: String
    /// @brainstorm's conversation topic, read from the document.
    public var topic: String?
}

public enum Context {
    public static let here = "<<< this is the question being asked now >>>"
    public static let noStage = "<stage>none</stage>"
    public static let noHighlights = "<highlights>none</highlights>"
    static let selectionWait: TimeInterval = 0.3
    static let shotWait: TimeInterval = 2
    static let turnAgents = ["bart": "Chat", "brainstorm": "Brainstorm", "discover": "Discover", "create": "Create"]
    /// The agents that read where the person is from this workspace alone (2026-09-30, round 3).
    public static let scoped: Set<String> = ["brainstorm"]
    /// The agents told where the Zotero mirror is (MATH-65 build 2).
    public static let zoteroReaders: Set<String> = ["bart", "discover", "create"]
    /// The agents that may open the library's own files (MB-06): their folders join the --add-dir list.
    public static let libraryReaders: Set<String> = ["bart", "brainstorm", "discover", "create"]
    static let maxLibraryDirs = 24

    /// What `ask()` gives within `seconds`, else nil.
    static func inTime<T: Sendable>(_ seconds: TimeInterval, _ ask: @escaping @Sendable () async -> T?) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { await ask() }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// The pending line of this question marks its place; the pending lines of other questions are noise.
    public static func markPlace(_ text: String?, askId: String?) -> String {
        (text ?? "").components(separatedBy: "\n").compactMap { line -> String? in
            guard let pending = Reply.pendingRE.match(line) else { return line }
            return pending[1] == askId ? here : nil
        }.joined(separator: "\n")
    }

    /// The earlier turns of the exchange, as the document holds them now; a conversation not all with `agent` has each
    /// turn labelled with the agent that answered it.
    public static func conversationBlock(_ turns: [AskTurn], agent: String? = nil) -> String {
        if turns.isEmpty { return "" }
        let mixed = turns.contains { t in t.agent.map { turnAgents[$0] != nil && $0 != agent } ?? false }
        let said = turns.enumerated().map { n, t -> String in
            let label = mixed ? (t.agent.flatMap { turnAgents[$0] }.map { " agent=\"\($0)\"" } ?? "") : ""
            return "<turn n=\"\(n + 1)\"\(label)>\n<asked>\n\(t.question)\n</asked>\n<answered>\n\(t.answer)\n</answered>\n</turn>"
        }
        return "<conversation>\n\(said.joined(separator: "\n"))\n</conversation>"
    }

    public static func block(_ tag: String, _ name: String, _ text: String) -> String {
        "<\(tag) name=\"\(JSRegex("[<>\"\\n\\r]", "g").replace(name, with: " ").jsSlice(0, 200))\">\n\(text)\n</\(tag)>"
    }

    struct Scope { var agent: String; var workspace: WorkspaceRecord?; var own: [String]; var madeIn: [String: String?] }

    /// The library's entries an agent may be shown: @brainstorm's this workspace's alone (its context and the notes made
    /// in it, less what was thrown away, and whatever the document mentions); everyone else's the whole project's.
    static func catalogFor(_ store: BartStore, _ project: ProjectRecord, _ rows: [LibraryRow], _ seen: Set<String>, _ scope: Scope) -> [CatalogEntry] {
        guard scoped.contains(scope.agent), let w = scope.workspace else {
            return Catalog.build(project, store.flattenWorkspaces(projectDir: project.dir), rows, generated: nil, madeIn: scope.madeIn).entries
        }
        let removed = Set(w.removed)
        var held = Set((w.context + scope.own).filter { !removed.contains($0) })
        held.formUnion(seen)
        let here = WorkspaceRecord(id: w.id, name: w.name, path: w.name, context: Array(held))
        return Catalog.build(project, [here], rows.filter { held.contains($0.id) }, generated: nil).entries
    }

    /// The library as the agent is shown it (Context.json): every item but pictures, `mentioned` when `seen` holds it.
    static func catalogEntries(_ store: BartStore, _ project: ProjectRecord, _ rows: [LibraryRow], _ seen: Set<String>, _ scope: Scope,
                               texts: [String: String] = [:], notes: [String: String] = [:]) -> [CatalogEntryView] {
        catalogFor(store, project, rows, seen, scope).filter { $0.type != "image" }.map { e in
            let path: String? = e.path.map { $0.hasPrefix("/") ? ($0 as NSString).standardizingPath : ((project.dir as NSString).appendingPathComponent($0) as NSString).standardizingPath }
                ?? e.folderPath.map { ($0 as NSString).standardizingPath }
            return CatalogEntryView(id: e.id, name: e.name, type: e.type, tags: e.tags, path: path, url: e.url, text: texts[e.id], notes: notes[e.id],
                                    summary: e.summaryStale ? nil : e.summary, lastEdited: e.lastEdited, mentioned: seen.contains(e.id))
        }
    }

    /// The files inside library folders the documents mention (MATH-22), from `seen`'s `file:<id>:<rel>` keys.
    static func mentionedFiles(_ store: BartStore, _ rows: [LibraryRow], _ seen: [String]) -> [(path: String, folder: String, exists: Bool)] {
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [(String, String, Bool)] = []
        for key in seen {
            guard let m = JSRegex("^file:([A-Za-z0-9_-]+):(.+)$", "s").match(key), let row = byId[m[1]!], !(row.folderPath ?? "").isEmpty,
                  let found = store.fileInRow(row, rel: m[2]!) else { continue }
            out.append((found.path, row.name, found.exists))
        }
        return out
    }

    /// <mentioned_files>, as JSON (one-space indent); '' when there are none.
    static func mentionedFilesBlock(_ files: [(path: String, folder: String, exists: Bool)]) -> String {
        if files.isEmpty { return "" }
        let json: OJ = .array(files.map { ["path": .string($0.path), "folder": .string($0.folder), "exists": .bool($0.exists)] })
        return "<mentioned_files>\n\(json.stringify(indent: 1))\n</mentioned_files>"
    }

    static func within(_ dir: String, _ root: String) -> Bool {
        let d = (dir as NSString).standardizingPath, r = (root as NSString).standardizingPath
        return d == r || d.hasPrefix(r.hasSuffix("/") ? r : r + "/")
    }

    static func isDirectory(_ path: String) -> Bool { var d: ObjCBool = false; return FileManager.default.fileExists(atPath: path, isDirectory: &d) && d.boolValue }

    /// The folders to grant so the library's files can be opened: each file's folder, and a folder item itself. Never the
    /// home folder or the disk's root, nothing already granted or inside another one, nothing that is gone; at most 24.
    static func libraryDirs(_ store: BartStore, _ project: ProjectRecord, _ rows: [LibraryRow], granted: [String], seen: Set<String>, scope: Scope) -> [String] {
        var wanted: [String] = []
        let home = (store.homeDir as NSString).standardizingPath
        for e in catalogFor(store, project, rows, seen, scope) where e.type != "image" {
            let dir: String?
            if let f = e.folderPath { dir = (f as NSString).standardizingPath }
            else if let p = e.path { dir = ((p.hasPrefix("/") ? p : (project.dir as NSString).appendingPathComponent(p)) as NSString).deletingLastPathComponent }
            else { dir = nil }
            guard let d = dir.map({ ($0 as NSString).standardizingPath }), d != "/", d != home, !granted.contains(where: { within(d, $0) }), isDirectory(d) else { continue }
            wanted.append(d)
        }
        var unique: [String] = []
        for d in wanted where !unique.contains(d) { unique.append(d) }
        var out: [String] = []
        for d in unique.enumerated().sorted(by: { $0.element.jsLength != $1.element.jsLength ? $0.element.jsLength < $1.element.jsLength : $0.offset < $1.offset }).map({ $0.element })
            where !out.contains(where: { within(d, $0) }) { out.append(d) }
        return Array(out.prefix(maxLibraryDirs))
    }

    /// The paper a highlight is on → its row's id, its name, its absolute path or address, and a folder to grant.
    static func paperOf(_ project: ProjectRecord, _ rows: [LibraryRow], rowId: String?, url: String?, given: String? = nil) -> InkedItem {
        let row = rowId.flatMap { id in rows.first { $0.id == id } } ?? (rowId == nil ? url.flatMap { u in rows.first { ($0.url ?? "") == u && !u.isEmpty } } : nil)
        var where_ = row.map { r in r.path.map { $0.hasPrefix("/") ? $0 : (project.dir as NSString).appendingPathComponent($0) } ?? (r.url ?? "") } ?? (url ?? "")
        if JSRegex("^file:", "i").test(where_), let u = URL(string: where_), u.isFileURL { where_ = u.path }
        let local: String? = where_.hasPrefix("/") ? where_ : nil
        let named: String
        if let row { named = row.name }
        else if let g = given, !g.isEmpty { named = g }
        else if let local { named = (local as NSString).lastPathComponent }
        else {
            let parts: [String] = JSRegex("[?#].*$").replace(where_, with: "").components(separatedBy: "/").filter { !$0.isEmpty }
            named = parts.last ?? "a pdf"
        }
        return InkedItem(source: nil, id: row?.id, name: named, where_: where_, dir: local.map { ($0 as NSString).deletingLastPathComponent })
    }

    /// <highlight paper="…" path="…" page="N"><quote>…</quote><note>…</note><page_text>…</page_text></highlight>; a web
    /// page's says source="web"; a box is <box crop="…"><text>…</text></box> where the quote would be.
    public static func highlightBlock(_ paper: InkedItem, page: Int?, quote: String = "", note: String = "", pageText: String = "", box: (crop: String, text: String)? = nil) -> String {
        let around = pageText.jsTrim
        let on = paper.source == "web"
            ? "source=\"web\" title=\"\(Highlights.attrOf(paper.name, 200))\" address=\"\(Highlights.attrOf(paper.address, 4096))\"\(paper.path.isEmpty ? "" : " path=\"\(Highlights.attrOf(paper.path, 4096))\"")"
            : "paper=\"\(Highlights.attrOf(paper.name, 200))\" path=\"\(Highlights.attrOf(paper.where_, 4096))\" page=\"\((page ?? 0) != 0 ? page! : 1)\""
        let what = box.map { "<box\($0.crop.isEmpty ? "" : " crop=\"\(Highlights.attrOf($0.crop, 4096))\"")>\n<text>\n\($0.text.jsTrim)\n</text>\n</box>" } ?? "<quote>\n\(quote.jsTrim)\n</quote>"
        return "<highlight \(on)>\n\(what)\n<note>\n\(note.jsTrim)\n</note>\n\(around.isEmpty ? "" : "<page_text>\n\(around)\n</page_text>\n")</highlight>"
    }

    /// The web page a highlight or the Stage is on → the library's row when it holds the page, named as the library names
    /// it, else `title`, else its address; `path` a copy on disk; `dir` the folder of a copy the library does not hold.
    static func webPageOf(_ store: BartStore, _ project: ProjectRecord, _ rows: [LibraryRow], rowId: String?, url: String?, title: String = "") async -> InkedItem {
        var row = rowId.flatMap { id in rows.first { $0.id == id } }
        if row == nil, let u = url, !u.isEmpty { row = await store.lookupItem(url: u) }
        let u = row.map { $0.url ?? "" } ?? (url ?? "")
        var file = row?.path.map { $0.hasPrefix("/") ? $0 : (project.dir as NSString).appendingPathComponent($0) } ?? ""
        if file.isEmpty, JSRegex("^file:", "i").test(u), let fu = URL(string: u), fu.isFileURL { file = fu.path }
        let address = JSRegex("^file:", "i").test(u) ? "" : u
        let named = row.flatMap { $0.name.isEmpty ? nil : $0.name } ?? title.jsTrim.nonEmpty ?? address.nonEmpty ?? (file.isEmpty ? "a web page" : (file as NSString).lastPathComponent)
        return InkedItem(source: "web", id: row?.id, name: named, address: address, path: file, dir: !file.isEmpty && row == nil ? (file as NSString).deletingLastPathComponent : nil)
    }

    /// The ink an item has, and the file it is read from; ink that cannot be read is none.
    static func inkOf(_ store: BartStore, rowId: String?, url: String?) async -> (ink: JSONValue?, annotations: String, inkRoot: String) {
        let inkRoot = (store.dataRoot as NSString).appendingPathComponent("annotations")
        do {
            let ink = try await (rowId != nil ? store.readAnnotations(rowId: rowId!) : store.readPageAnnotations(url: url ?? ""))
            return (ink, await store.annotationsFile(rowId: rowId, url: rowId == nil ? url : nil), inkRoot)
        } catch { return (nil, "", inkRoot) }
    }

    static func withInk(_ item: InkedItem, _ ink: (ink: JSONValue?, annotations: String, inkRoot: String)) -> InkedItem {
        var i = item; i.ink = ink.ink; i.annotations = ink.annotations; i.inkRoot = ink.inkRoot; return i
    }

    /// What `live` gives of the page in front → its selection (unless `selecting` is off) and its picture saved as the turn's.
    static func livePage(_ store: BartStore, _ live: LivePage?, askId: String, selecting: Bool = true) async -> (selection: JSONValue?, screenshot: String) {
        guard let live else { return (nil, "") }
        async let selection: JSONValue? = selecting && live.selection != nil ? inTime(selectionWait, live.selection!) : nil
        async let png: Data? = live.screenshot != nil ? inTime(shotWait, live.screenshot!) : nil
        let sel = await selection
        let quoted = sel.flatMap { s in s["quote"]?["exact"]?.string.map { $0.jsTrim.isEmpty ? nil : s } ?? nil }
        let shot = await png.flatMap { Shots.save(store.dataRoot, id: askId, png: $0) } ?? ""
        return (quoted, shot)
    }

    /// A library row that may be a pdf: one, or an address saved before the Stage kept a copy.
    static func mayBePdf(_ row: LibraryRow) -> Bool { row.type == "pdf" || (row.type == "website" && (row.tags.contains("paper") || JSRegex("\\.pdf(?:$|[?#])", "i").test(row.url ?? ""))) }
    /// A library row that is a web page (MATH-54): a page saved as itself (html), or one kept by its address; not a repository.
    static func isWebPage(_ row: LibraryRow) -> Bool { !mayBePdf(row) && !row.tags.contains("git") && (row.type == "html" || row.type == "website") }

    static func mentionedPapers(_ store: BartStore, _ project: ProjectRecord, _ rows: [LibraryRow], _ chosen: [LibraryRow]) async -> [InkedItem] {
        var out: [InkedItem] = []
        for row in chosen where mayBePdf(row) || isWebPage(row) {
            let item = mayBePdf(row) ? paperOf(project, rows, rowId: row.id, url: nil) : await webPageOf(store, project, rows, rowId: row.id, url: nil)
            out.append(withInk(item, await inkOf(store, rowId: row.id, url: nil)))
        }
        return out
    }

    /// "this workspace's document: <path>" and a line for each of the project's other workspaces.
    static func workspaceLines(_ store: BartStore, _ project: ProjectRecord, _ workspace: WorkspaceRecord, _ workspaceDir: String) -> [String] {
        func doc(_ dir: String) -> String { (dir as NSString).appendingPathComponent("workspace.md") }
        let others = store.flattenWorkspaces(projectDir: project.dir).filter { $0.id != workspace.id }
        return ["this workspace's document: \(doc(workspaceDir))"] + others.map { "other workspace \"\($0.path)\": \(doc((project.dir as NSString).appendingPathComponent($0.path)))" }
    }

    /// buildContext.
    public static func build(store: BartStore, projectId: String, ref: DocRef, workspaceId: String, askId: String, agent: String = "bart",
                             highlight: HighlightInput? = nil, stage: StageInput? = nil, live: LivePage? = nil, overleaf: OverleafTabs? = nil) async throws -> BartContext {
        let found = try store.findWorkspace(projectId: projectId, workspaceId: workspaceId)
        let project = found.project, workspace = found.workspace
        let rows = try await store.libraryDb.list()
        var seen = Set<String>()
        var seenOrder: [String] = [] // insertion order, as a JS Set iterates
        func see(_ id: String) { if seen.insert(id).inserted { seenOrder.append(id) } }
        var documents: [String] = []
        let isScoped = scoped.contains(agent)
        var topic: String? = nil
        func shown(_ body: String) -> String {
            if isScoped && topic == nil { topic = Strip.topicOf(body, askId: askId) }
            return markPlace(isScoped ? Strip.stripAgentReplies(body, agent: agent, show: true, askId: askId) : Strip.stripTitles(body), askId: askId)
        }
        func expand(_ r: DocRef) async throws -> (title: String, body: String) {
            let out = try await store.expandDoc(projectId: projectId, ref: r, seen: seenOrder)
            seenOrder = out.seen
            seen = Set(out.seen)
            return (out.title, out.body)
        }
        var from = "the workspace \"\(workspace.name)\""
        var paper: InkedItem? = nil
        var pointed: String? = nil
        if ref.kind == "mark" {
            let space = try await expand(.workspace(workspaceId))
            let web = ref.source == "web" // a highlight on a web page (MATH-54): no page
            paper = web ? await webPageOf(store, project, rows, rowId: ref.rowId, url: ref.url, title: highlight?.paper ?? "")
                : paperOf(project, rows, rowId: ref.rowId, url: ref.url, given: highlight?.paper)
            if let id = paper?.id, !seen.contains(id) { see(id); pointed = id } // the paper is what the person points at
            // a web mark is read from the page's ink, not taken from the renderer: a box is shown as one (MATH-70 build 2)
            let held = web ? await store.readWebMark(rowId: ref.rowId, url: ref.rowId == nil ? ref.url : nil, markId: ref.id ?? "") : nil
            let box: (crop: String, text: String)? = held.flatMap { Highlights.isBox($0) ? (Highlights.cropPath($0, (store.dataRoot as NSString).appendingPathComponent("annotations")), $0["text"]?.string ?? "") : nil }
            let note = box != nil ? ((highlight?.note).flatMap { $0.isEmpty ? nil : $0 } ?? held?["note"]?.string ?? "") : (highlight?.note ?? "")
            documents += [block("workspace", space.title, shown(space.body)),
                          highlightBlock(paper!, page: ref.page, quote: highlight?.quote ?? "", note: note, pageText: highlight?.pageText ?? "", box: box)]
            let name = Highlights.attrOf(paper!.name, 200)
            from = box != nil ? "a box on the web page \"\(name)\", opened from the workspace \"\(workspace.name)\""
                : web ? "a highlight on the web page \"\(name)\", opened from the workspace \"\(workspace.name)\""
                : "a highlight on page \((ref.page ?? 0) != 0 ? ref.page! : 1) of \"\(name)\", opened from the workspace \"\(workspace.name)\""
        } else if ref.kind == "note" {
            // The note is its own block: the workspace must not also carry it as a mention.
            if let id = ref.id { see(id) }
            let space = try await expand(.workspace(workspaceId))
            let note = try await expand(ref)
            documents += [block("workspace", space.title, shown(space.body)), block("note", note.title, shown(note.body))]
            from = "the note \"\(note.title)\", opened from the workspace \"\(workspace.name)\""
        } else if ref.kind == "project" {
            // The project page (2026-10-13), asked from: it is the document in front; the workspace it was opened in comes first.
            let space = try await expand(.workspace(workspaceId))
            let page = try await expand(ref)
            documents += [block("workspace", space.title, shown(space.body)), block("project_page", page.title, shown(page.body))]
            from = "the project page of \"\(project.name)\", opened from the workspace \"\(workspace.name)\""
        } else {
            let space = try await expand(ref)
            documents.append(block("workspace", space.title, shown(space.body)))
        }
        // @bart sees the person's highlights: the pdf or web page in front, then the ones the documents mention.
        let projectsOpen = agent == "bart" ? overleaf : nil
        let overleafFront = projectsOpen?.front
        var front: InkedItem? = nil
        if agent == "bart", let stage, overleafFront == nil {
            if stage.kind == "pdf", stage.rowId != nil || stage.url != nil {
                let p = paperOf(project, rows, rowId: stage.rowId, url: stage.url)
                front = withInk(p, await inkOf(store, rowId: p.id ?? (stage.url == nil ? stage.rowId : nil), url: p.id == nil ? stage.url : nil))
            } else if stage.kind == "web" {
                // A question asked from a highlight is about the highlight: the page's selection is not asked for, its picture is.
                async let page = webPageOf(store, project, rows, rowId: nil, url: stage.url, title: stage.title ?? "")
                async let now = livePage(store, live, askId: askId, selecting: ref.kind != "mark")
                var p = await page
                let n = await now
                if p.address.isEmpty && p.path.isEmpty { p.address = stage.url ?? "" }
                p = withInk(p, await inkOf(store, rowId: p.id, url: p.id == nil ? stage.url : nil))
                p.selection = n.selection; p.screenshot = n.screenshot
                front = p
            }
        }
        var now = ""
        if agent == "bart" {
            var staged: String
            if let overleafFront { staged = overleafFront(await livePage(store, live, askId: askId, selecting: false).screenshot) }
            else if let f = front { staged = f.source == "web" ? Highlights.webStageBlock(f, ink: f.ink) : Highlights.stageBlock(f, page: stage?.page, ink: f.ink) }
            else { staged = noStage }
            if let tabs = projectsOpen?.tabsBlock, !tabs.isEmpty { staged = "\(staged)\n\(tabs)" }
            let chosen = rows.filter { seen.contains($0.id) && $0.id != pointed && !(front?.id != nil && front?.id == $0.id) }
            let marked = Highlights.mentionedBlock(await mentionedPapers(store, project, rows, chosen))
            documents.append(staged)
            if !marked.isEmpty { documents.append(marked) }
            now = "\(staged)\n\n\(marked.isEmpty ? noHighlights : marked)"
        }
        let madeIn = await store.notesMadeIn(projectDir: project.dir, workspaces: nil)
        let own = isScoped ? madeIn.compactMap { id, at in at == workspace.id ? id : nil } : []
        let scope = Scope(agent: agent, workspace: workspace, own: own, madeIn: madeIn)
        let entries = agent == "bart"
            ? catalogEntries(store, project, rows, seen, scope, texts: await SourceText.sourceTexts(dataRoot: store.dataRoot, db: store.libraryDb, rows: rows),
                             notes: SourceText.noteTexts(dataRoot: store.dataRoot, store: store, rows: rows))
            : catalogEntries(store, project, rows, seen, scope)
        var headLines = ["<engelbart>", "project: \(project.name)"]
        if let d = project.description, !d.isEmpty { headLines.append("project description: \(JSRegex("\\s+", "g").replace(d, with: " "))") }
        headLines += ["code directory: \(project.directory.flatMap { $0.isEmpty ? nil : $0 } ?? "none set")", "notes and workspaces: \(project.dir)", "asked from: \(from)"]
        // Chat cites passages of workspaces by their documents' paths (2026-10-21): this one's, and the project's others.
        if agent == "bart" { headLines += workspaceLines(store, project, workspace, found.workspaceDir) }
        if zoteroReaders.contains(agent) && !store.dataRoot.isEmpty { let z = store.zoteroPointerLine(); if !z.isEmpty { headLines.append(z) } }
        headLines.append("</engelbart>")
        let head = (headLines + [store.instructionsBlock(), ref.kind == "project" ? "" : projectPageBlock(project), store.memoryBlock()]).filter { !$0.isEmpty }.joined(separator: "\n")
        let granted = [project.directory ?? "", store.dataRoot].filter { !$0.isEmpty }
        var dirs = libraryReaders.contains(agent) ? granted + libraryDirs(store, project, rows, granted: granted, seen: seen, scope: scope) : granted
        // A pdf opened from disk that the library does not hold (the highlight's, the Stage's): its folder too.
        let zoteroDirs = seenOrder.filter { $0.hasPrefix("zfile:") }.map { (String($0.dropFirst(6)) as NSString).deletingLastPathComponent }
        let home = (store.homeDir as NSString).standardizingPath
        for dir in [paper?.dir, front?.id == nil ? front?.dir : nil].compactMap({ $0 }) + zoteroDirs {
            let folder = (dir as NSString).standardizingPath
            if folder.isEmpty || folder == "/" || folder == home || dirs.contains(where: { within(folder, $0) }) { continue }
            if isDirectory(folder) { dirs.append(folder) }
        }
        let files = mentionedFiles(store, rows, seenOrder)
        return BartContext(project: project, dirs: dirs, head: head, contextJson: "<context_json>\n\(OJ.array(entries.map { $0.json }).stringify(indent: 1))\n</context_json>",
                           mentionedFiles: mentionedFilesBlock(files), files: files, documents: documents.joined(separator: "\n\n"), now: now,
                           entries: entries, workspaceName: workspace.name, topic: topic)
    }
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
