import Foundation
import EngelbartCore

// context/catalog.cjs — <project>/.context/catalog.json: what the project holds, for anything that reads files rather
// than the database (an agent in a terminal, a script). A projection of the library table joined with the workspaces on
// disk, regenerable at any time, written only by the app, and rewritten only when its content changes. Deleting
// .context loses nothing. With shared/project-holds.cjs (holder, letGo) and projects.cjs referencedBy, ported here as
// the pure rules they are (Store owns the same rules for its own screens).

/// A library row as the Store keeps it (`library` table), the fields Bart reads.
public struct LibraryRow: Sendable, Equatable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public var path: String?
    public var url: String?
    public var folderPath: String?
    public var githubId: String?
    public var charCount: Int?
    /// ISO-8601 with milliseconds.
    public var lastEdited: String?
    public var summary: String?
    public var summaryEdited: String?
    public var created: String?
    public var projectId: String?
    public init(id: String, name: String, type: String, tags: [String] = [], path: String? = nil, url: String? = nil, folderPath: String? = nil,
                githubId: String? = nil, charCount: Int? = nil, lastEdited: String? = nil, summary: String? = nil, summaryEdited: String? = nil,
                created: String? = nil, projectId: String? = nil) {
        self.id = id; self.name = name; self.type = type; self.tags = tags; self.path = path; self.url = url; self.folderPath = folderPath
        self.githubId = githubId; self.charCount = charCount; self.lastEdited = lastEdited; self.summary = summary; self.summaryEdited = summaryEdited
        self.created = created; self.projectId = projectId
    }
}

/// A project as project.json and the Store describe it.
public struct ProjectRecord: Sendable, Equatable {
    public var id: String
    public var name: String
    public var description: String?
    /// The code directory (`directory`), or nil when none is set.
    public var directory: String?
    /// The project's own folder under the data root.
    public var dir: String
    /// project.json `library` and `removed`.
    public var library: [String]
    public var removed: [String]
    public init(id: String, name: String, description: String? = nil, directory: String? = nil, dir: String, library: [String] = [], removed: [String] = []) {
        self.id = id; self.name = name; self.description = description; self.directory = directory; self.dir = dir; self.library = library; self.removed = removed
    }
}

/// A workspace, flat (projects.cjs flattenWorkspaces): its path from the project folder ("Agents/Inline chat agent").
public struct WorkspaceRecord: Sendable, Equatable {
    public var id: String
    public var name: String
    public var path: String
    public var context: [String]
    public var removed: [String]
    public var chars: Int?
    public init(id: String, name: String, path: String, context: [String] = [], removed: [String] = [], chars: Int? = nil) {
        self.id = id; self.name = name; self.path = path; self.context = context; self.removed = removed; self.chars = chars
    }
    /// Its folder, from the project's.
    public func dir(in projectDir: String) -> String { (projectDir as NSString).appendingPathComponent(path) }
}

/// One entry of Context.json, as an agent is shown the library (context.cjs catalogEntries).
public struct CatalogEntryView: Sendable, Equatable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public var path: String?
    public var url: String?
    public var text: String?
    public var notes: String?
    public var summary: String?
    public var lastEdited: String?
    public var mentioned: Bool
    public init(id: String = "", name: String, type: String, tags: [String] = [], path: String? = nil, url: String? = nil, text: String? = nil,
                notes: String? = nil, summary: String? = nil, lastEdited: String? = nil, mentioned: Bool = false) {
        self.id = id; self.name = name; self.type = type; self.tags = tags; self.path = path; self.url = url; self.text = text; self.notes = notes
        self.summary = summary; self.lastEdited = lastEdited; self.mentioned = mentioned
    }

    /// The entry as Context.json writes it (keys in catalogEntries' order; `text`/`notes` only when present).
    public var json: OJ {
        var o: [(String, OJ)] = [("name", .string(name)), ("type", .string(type)), ("tags", .array(tags.map { .string($0) })),
                                 ("path", path.map { .string($0) } ?? .null), ("url", url.map { .string($0) } ?? .null)]
        if let text { o.append(("text", .string(text))) }
        if let notes { o.append(("notes", .string(notes))) }
        o += [("summary", summary.map { .string($0) } ?? .null), ("lastEdited", lastEdited.map { .string($0) } ?? .null), ("mentioned", .bool(mentioned))]
        return .object(o)
    }
}

public struct CatalogEntry: Sendable, Equatable {
    public var id, name, type: String
    public var tags: [String]
    public var path, url, folderPath, githubId: String?
    public var workspaces: [String]
    public var chars: Int?
    public var lastEdited, summary, summaryEdited: String?
    public var summaryStale: Bool

    public var json: OJ {
        func s(_ v: String?) -> OJ { v.map { .string($0) } ?? .null }
        return ["id": .string(id), "name": .string(name), "type": .string(type), "tags": .array(tags.map { .string($0) }), "path": s(path), "url": s(url),
                "folderPath": s(folderPath), "githubId": s(githubId), "workspaces": .array(workspaces.map { .string($0) }),
                "chars": chars.map { .number(Double($0)) } ?? .null, "lastEdited": s(lastEdited), "summary": s(summary),
                "summaryEdited": s(summaryEdited), "summaryStale": .bool(summaryStale)]
    }
}

public enum Catalog {
    public static let about = "Everything this project holds. `type` is what an item is and is never a guess: a file's format (md, pdf, html, csv, tsv, json, jsonl, parquet, xlsx), or folder, website, image. `tags` is what was inferred about it: `paper` (an arXiv or DOI address, or a pdf that reads like a paper), `git` (a repository: its address, or a folder with a .git), `note` (written in Engelbart). `path` is relative to `project.root` unless absolute. `summary` says why an item matters and what is in it: for a PDF with an Abstract section it is that abstract; for a page or repository added by its address it is the description the page gives of itself; otherwise it is a model-written blurb, which exists only for notes (and PDFs without an abstract) longer than 1000 characters that have been left alone for 30 minutes. `chars` is the length of a note file, and of a workspace document. When `summary` is null or `summaryStale` is true, read the file itself. `workspaces` lists the workspaces whose context includes the item."

    /// Library id → the paths of the workspaces that have it in context (projects.cjs referencedBy).
    public static func referencedBy(_ workspaces: [WorkspaceRecord]) -> [String: [String]] {
        var refs: [String: [String]] = [:]
        for w in workspaces { for id in w.context { refs[id, default: []].append(w.path) } }
        return refs
    }

    /// The notes let go of (MATH-58): trashed from a workspace and held by none of the project's workspaces any more,
    /// neither in its context nor made in it, unless that one threw it away too. Only notes (`madeIn` holds them).
    public static func letGo(_ workspaces: [WorkspaceRecord], _ madeIn: [String: String?]) -> Set<String> {
        var trashed = Set<String>(), held = Set<String>()
        for w in workspaces {
            let removed = Set(w.removed)
            trashed.formUnion(removed)
            for id in w.context where !removed.contains(id) { held.insert(id) }
            for (id, at) in madeIn { if let at, at == w.id, !removed.contains(id) { held.insert(id) } }
        }
        return trashed.filter { madeIn.keys.contains($0) && !held.contains($0) }
    }

    /// What a project holds (shared/project-holds.cjs): not removed, not let go, and made there, listed, or in a context.
    public static func holder(_ project: ProjectRecord, _ workspaces: [WorkspaceRecord], _ madeIn: [String: String?] = [:]) -> (LibraryRow) -> Bool {
        let removed = Set(project.removed), listed = Set(project.library)
        var inContext = Set<String>()
        for w in workspaces { let thrown = Set(w.removed); for id in w.context where !thrown.contains(id) { inContext.insert(id) } }
        let gone = letGo(workspaces, madeIn)
        return { row in !removed.contains(row.id) && !gone.contains(row.id) && (row.projectId == project.id || listed.contains(row.id) || inContext.contains(row.id)) }
    }

    /// A note is edited through the app (last_edited); a PDF is "edited" when its file changes.
    static func changedAt(_ row: LibraryRow) -> String? {
        if row.type == "pdf", let p = row.path {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: p), let m = attrs[.modificationDate] as? Date { return isoMs(m) }
            return row.lastEdited
        }
        return row.lastEdited
    }

    /// `new Date(ms).toISOString()`: milliseconds, truncated as JS keeps a file's mtime to the millisecond.
    static func isoMs(_ date: Date) -> String {
        let ms = (date.timeIntervalSince1970 * 1000).rounded(.down)
        return Time.iso(Date(timeIntervalSince1970: ms / 1000))
    }

    static func entryFor(_ row: LibraryRow, _ project: ProjectRecord, _ refs: [String: [String]]) -> CatalogEntry {
        let inside = row.path.map { $0.hasPrefix(project.dir + "/") } ?? false
        var path = row.path
        if inside, let p = row.path { path = String(p.dropFirst(project.dir.count + 1)) }
        let summary = row.summary.flatMap { $0.isEmpty ? nil : $0 }
        let edited = row.summaryEdited.flatMap { $0.isEmpty ? nil : $0 }
        var stale = false
        if summary != nil {
            if let edited { if let changed = changedAt(row) { stale = edited < changed } } else { stale = true }
        }
        return CatalogEntry(id: row.id, name: row.name, type: row.type, tags: row.tags, path: path, url: row.url.flatMap { $0.isEmpty ? nil : $0 },
                            folderPath: row.folderPath.flatMap { $0.isEmpty ? nil : $0 }, githubId: row.githubId.flatMap { $0.isEmpty ? nil : $0 },
                            workspaces: refs[row.id] ?? [], chars: row.charCount, lastEdited: row.lastEdited.flatMap { $0.isEmpty ? nil : $0 },
                            summary: summary, summaryEdited: edited, summaryStale: stale)
    }

    /// The catalog of one project. `madeIn` (projects.notesMadeIn): which workspace each note was made in.
    public static func build(_ project: ProjectRecord, _ workspaces: [WorkspaceRecord], _ rows: [LibraryRow], generated: String?, madeIn: [String: String?] = [:]) -> (json: OJ, entries: [CatalogEntry]) {
        let refs = referencedBy(workspaces)
        let held = holder(project, workspaces, madeIn)
        let entries = rows.filter(held).map { entryFor($0, project, refs) }
        let json: OJ = [
            "version": 2, // 2: `type` became the format and `tags` arrived (2026-09-21)
            "about": .string(about),
            "generated": generated.map { .string($0) } ?? .null,
            "project": ["id": .string(project.id), "name": .string(project.name), "root": .string(project.dir), "directory": project.directory.flatMap { $0.isEmpty ? nil : OJ.string($0) } ?? .null],
            "workspaces": .array(workspaces.map { w in ["id": .string(w.id), "name": .string(w.name), "path": .string(w.path), "document": .string("\(w.path)/workspace.md"), "chars": w.chars.map { .number(Double($0)) } ?? .null] }),
            "entries": .array(entries.map { $0.json }),
        ]
        return (json, entries)
    }

    /// Rewrites the catalog of every project whose content changed (`generated` aside). → the files written.
    public static func writeCatalogs(projects: [(project: ProjectRecord, workspaces: [WorkspaceRecord], madeIn: [String: String?])], rows: [LibraryRow], now: Date = Date()) -> [String] {
        var written: [String] = []
        for (project, workspaces, madeIn) in projects {
            let catalog = build(project, workspaces, rows, generated: Time.iso(now), madeIn: madeIn).json
            let dir = URL(fileURLWithPath: project.dir).appendingPathComponent(".context")
            let file = dir.appendingPathComponent("catalog.json")
            if let previous = OJ.read(file), previous.isObject,
               previous.setting("generated", .null).stringify() == catalog.setting("generated", .null).stringify() { continue }
            do { try writeJSONFile(file, catalog); written.append(file.path) } catch { continue }
        }
        return written
    }
}
