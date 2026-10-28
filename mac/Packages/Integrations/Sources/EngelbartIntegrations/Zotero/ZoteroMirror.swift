import Foundation
import EngelbartCore

// src/main/zotero/mirror.cjs: reading the Zotero mirror (MATH-65 build 2; ZoteroSync writes it to <dataRoot>/.zotero/).
// For the @ menu a level of the library is listed as a library folder's (collections, then items); for a mention
// `@[Title](zotero:<ref>)` its item, its attachment and the <zotero_item> block Bart is given. An attachment is found where
// it already is before anything is downloaded: a linked file at its own path, else Zotero's storage on this Mac
// (~/Zotero/storage/<attachmentKey>/<file>), else a copy downloaded before (files/<attachmentKey>/), else, only when
// asked, Zotero's copy is fetched. Build 3–4: an item with none may have a kept copy (found free, downloaded in the
// browser, dropped on its chip). Build 5: groups, each mirrored in <mirror>/groups/<groupID>/; a ref `g<groupID>:<key>`
// names a group's item, a bare key My Library's. A chip opens a pdf in the paper viewer and anything else in the default
// browser (its DOI's page, else its URL), never in the Stage, where publishers' bot checks block it.

public struct ZoteroRef: Equatable, Sendable {
    public var group: String
    public var key: String
}

/// A library mirrored: My Library (`group` "") or a group.
public struct ZoteroLibrary: Equatable, Sendable {
    public var group: String
    public var name: String
    public var root: String
    public var shown: String
}

/// A resolved file for an item: where it is and how it came (`source`).
public struct ZoteroFile: Equatable, Sendable {
    public var path: String
    public var source: String       // linked | storage | downloaded | open access | downloaded in browser | added by hand
    public var attachment: JSONValue?
    public var url: String = ""
    public var foundAt: String = ""
    public var via: String = ""
    public var from: String?
}

/// What resolvePdf answers: a file, or the reason there is none (`failed`, '' when there simply is none).
public enum ZoteroResolved: Equatable, Sendable {
    case file(ZoteroFile)
    case failed(String)
}

/// What a chip opens (openTarget).
public enum ZoteroOpenTarget: Equatable, Sendable {
    case file(path: String, source: String)
    case external(url: String, waiting: Bool)
    case error(String)

    public var json: JSONValue {
        switch self {
        case .file(let path, let source): return ["path": .string(path), "source": .string(source)]
        case .external(let url, let waiting): return waiting ? ["url": .string(url), "external": true, "waiting": true] : ["url": .string(url), "external": true]
        case .error(let words): return ["error": .string(words)]
        }
    }
}

/// One row of the @ menu's Zotero listing (as store/folder-files listFolder answers).
public struct ZoteroEntry: Equatable, Sendable {
    public var name: String
    public var rel: String
    public var dir: Bool
    public var type: String
    public var zotero: String?
    public var find: String?
    public var hint: String?

    public var json: JSONValue {
        var o: [String: JSONValue] = ["name": .string(name), "rel": .string(rel), "dir": .bool(dir), "type": .string(type)]
        if let zotero { o["zotero"] = .string(zotero) }
        if let find { o["find"] = .string(find) }
        if let hint { o["hint"] = .string(hint) }
        return .object(o)
    }
}

public enum ZoteroListing: Equatable, Sendable {
    case entries([ZoteroEntry], total: Int)
    case missing
    case error(String)

    public var json: JSONValue {
        switch self {
        case .entries(let list, let total): return ["entries": .array(list.map(\.json)), "total": .number(Double(total))]
        case .missing: return ["missing": true]
        case .error(let words): return ["error": .string(words)]
        }
    }
}

/// What itemBlock answers: the lines, the file Bart may be granted, whether the item is missing.
public struct ZoteroBlock: Equatable, Sendable {
    public var lines: [String]
    public var file: String
    public var missing: Bool
}

/// The library service a read needs (ZoteroSync.library(group)): download, a kept or free copy, the storage folder.
public struct ZoteroLibraryAccess: Sendable {
    public var group: String
    public var name: String
    public var root: String
    public var download: (@Sendable (String, String) async throws -> String)?
    public var openAccess: (@Sendable (JSONValue) async -> ZoteroKeptCopy?)?
    public var storageDir: String?
}

public enum ZoteroMirror {
    static let keyRE = re("^[A-Za-z0-9]{1,32}$")
    static let groupRE = re("^[0-9]{1,20}$")
    static let refRE = re("^(?:g([0-9]{1,20}):)?([A-Za-z0-9]{1,32})$")
    public static let myLibrary = "My Library"
    /// The kinds of attachment opened for an item, best first: a pdf, an epub, a saved web page.
    public static let openable = ["application/pdf", "application/epub+zip", "text/html"]
    static let maxEntries = 5000
    static let maxNoteChars = 4000
    static let maxNotesChars = 16000
    static let maxAnnotations = 200
    /// A collection's name in the line (`@Zotero/Reading/`): a `/` in it would read as a level.
    public static let slash = "∕"
    /// Kept copies of an item with no file of its own: found free, or brought by the person.
    public static let kept: Set<String> = ["open access", "downloaded in browser", "added by hand"]

    /// A dot folder: a project named "Zotero" would be <dataRoot>/zotero, which a sync and a disconnect delete.
    public static func mirrorDir(_ dataRoot: String) -> String { join(dataRoot, ".zotero") }
    public static func defaultStorage() -> String { join(NSHomeDirectory(), "Zotero", "storage") }
    public static func groupDir(_ base: String, _ group: String) -> String { join(base, "groups", group) }
    public static func libraryRoot(_ base: String, _ group: String = "") -> String { group.isEmpty ? base : groupDir(base, group) }

    public static func isKey(_ key: String) -> Bool { keyRE.test(key) }
    public static func isGroup(_ group: String) -> Bool { groupRE.test(group) }

    /// A mention's target ('KEY' or 'g<groupID>:KEY') → { group, key }, or nil.
    public static func parseRef(_ ref: String?) -> ZoteroRef? {
        guard let ref, let m = refRE.groups(ref), let key = m[2] else { return nil }
        return ZoteroRef(group: m[1] ?? "", key: key)
    }

    public static func refOf(_ group: String, _ key: String) -> String { group.isEmpty ? key : "g\(group):\(key)" }

    // items.json and collections.json, read again only when they change.
    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: [String: (mtime: Double, size: Int, value: JSONValue?)] = [:]

    static func readCached(_ file: String) -> JSONValue? {
        guard let mtime = FileOps.mtimeMs(file), let size = FileOps.size(file) else {
            cacheLock.lock(); cache[file] = nil; cacheLock.unlock()
            return nil
        }
        cacheLock.lock()
        if let held = cache[file], held.mtime == mtime, held.size == size { cacheLock.unlock(); return held.value }
        cacheLock.unlock()
        let value = FileOps.readJSON(file)
        cacheLock.lock(); cache[file] = (mtime, size, value); cacheLock.unlock()
        return value
    }

    public static func readItems(_ root: String) -> [JSONValue]? { readCached(join(root, "items.json"))?.array }
    static func readCollections(_ root: String) -> [JSONValue] { readCached(join(root, "collections.json"))?.array ?? [] }

    /// Whether a mirror is there to read: a sync has finished at least once.
    public static func hasMirror(_ root: String?) -> Bool { root.map { readItems($0) != nil } ?? false }

    static func readState(_ root: String) -> JSONValue? { FileOps.readJSON(join(root, "state.json")) }

    /// A library's name: My Library, else the group's as its last sync found it (else "Group <id>").
    public static func libraryName(_ base: String?, _ group: String = "") -> String {
        if group.isEmpty { return myLibrary }
        let name = base.flatMap { readState(groupDir($0, group))?["name"]?.string }?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Group \(group)" : name
    }

    /// The groups mirrored under `base`, each with a state.json.
    public static func groupIds(_ base: String) -> [String] {
        FileOps.list(join(base, "groups")).filter { isGroup($0) && FileOps.exists(join(groupDir(base, $0), "state.json")) }.sorted()
    }

    /// My Library, then each group by name; `shown` unique among them (a clash gets " (<id>)").
    public static func librariesOf(_ base: String?) -> [ZoteroLibrary] {
        guard let base else { return [] }
        let unsorted: [ZoteroLibrary] = groupIds(base).map { ZoteroLibrary(group: $0, name: libraryName(base, $0), root: groupDir(base, $0), shown: "") }
        let groups = unsorted.sorted(by: libraryOrder)
        var taken = Set<String>()
        return ([ZoteroLibrary(group: "", name: myLibrary, root: base, shown: "")] + groups).map { lib in
            var shown = shownName(lib.name)
            if taken.contains(shown.lowercased()) { shown = "\(shown) (\(lib.group))" }
            taken.insert(shown.lowercased())
            var out = lib
            out.shown = shown
            return out
        }
    }

    static func libraryOrder(_ a: ZoteroLibrary, _ b: ZoteroLibrary) -> Bool {
        if a.name != b.name { return a.name.localizedCompare(b.name) == .orderedAscending }
        return (Int(a.group) ?? 0) < (Int(b.group) ?? 0)
    }

    static func entryOrder(_ a: ZoteroEntry, _ b: ZoteroEntry) -> Bool {
        if a.name != b.name { return a.name.localizedCompare(b.name) == .orderedAscending }
        return (a.zotero ?? "") < (b.zotero ?? "")
    }

    /// An item by its key, or nil.
    public static func itemOf(_ root: String, _ key: String) -> JSONValue? {
        guard isKey(key) else { return nil }
        return readItems(root)?.first { $0["key"]?.string == key }
    }

    /// "Smith, Jones and Lee" from an item's authors (its other creators when it has none); "Smith et al." past `max`.
    public static func authorsOf(_ item: JSONValue, max: Int = 3) -> String {
        let creators = item["creators"]?.array ?? []
        let authors = creators.filter { $0["type"]?.string == "author" }
        let names = (authors.isEmpty ? creators : authors).compactMap { c -> String? in
            let last = c["last"]?.string ?? ""
            let name = last.isEmpty ? (c["name"]?.string ?? "") : last
            return name.isEmpty ? nil : name
        }
        if names.isEmpty { return "" }
        if names.count > max { return "\(names[0]) et al." }
        return names.count == 1 ? names[0] : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)"
    }

    static func shownName(_ name: String?) -> String {
        let value = (name ?? "").isEmpty ? "Untitled" : name!
        return value.replacingOccurrences(of: "/", with: slash)
    }

    // MARK: the @ menu

    /// One level of a library: `rel` the collection's path of names ('' the whole library).
    public static func listLevel(_ root: String?, _ rel: String = "", group: String = "") -> ZoteroListing {
        guard let root, let items = readItems(root) else { return .error("Your Zotero library is still syncing…") }
        let collections = readCollections(root)
        let parts = rel.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        var parent: String? = nil
        for part in parts {
            guard let next = collections.first(where: { ($0["parent"]?.string) == parent && shownName($0["name"]?.string) == part }) else { return .missing }
            parent = next["key"]?.string
        }
        let subs = collections.filter { ($0["parent"]?.string) == parent }
            .sorted { ($0["name"]?.string ?? "").localizedCompare($1["name"]?.string ?? "") == .orderedAscending }
            .map { c -> ZoteroEntry in
                let name = shownName(c["name"]?.string)
                return ZoteroEntry(name: name, rel: (parts + [name]).joined(separator: "/"), dir: true, type: "folder")
            }
        let held = parent.map { p in items.filter { ($0["collections"]?.array ?? []).contains(.string(p)) } } ?? items
        let all = subs + held.map { itemEntry($0, group: group) }
        return .entries(Array(all.prefix(maxEntries)), total: all.count)
    }

    /// An item's row in the @ menu; `library` (a group's name) said beside it where several libraries are listed.
    public static func itemEntry(_ item: JSONValue, group: String = "", library: String = "") -> ZoteroEntry {
        let who = authorsOf(item), year = item["year"]?.stringish ?? ""
        let file = (item["attachments"]?.array ?? []).contains { openable.contains($0["contentType"]?.string ?? "") }
        let ref = refOf(group, item["key"]?.stringish ?? "")
        let names = (item["creators"]?.array ?? []).map { $0["name"]?.stringish ?? "" }.joined(separator: " ")
        let title = item["title"]?.string ?? ""
        return ZoteroEntry(
            name: title.isEmpty ? "Untitled" : title, rel: "~\(ref)", dir: false,
            type: file ? "pdf" : (item["url"]?.truthy ?? false) ? "website" : "md", zotero: ref,
            find: "\(who) \(names) \(year) \(item["citeKey"]?.stringish ?? "")\(library.isEmpty ? "" : " \(library)")".lowercased(),
            hint: [who, year, library].filter { !$0.isEmpty }.joined(separator: " · "))
    }

    /// Zotero in the @ menu (build 5): at its top every library as a folder, then every item of them all; `<library>/<path>`
    /// one library's level.
    public static func listLibraries(_ base: String?, _ rel: String = "") -> ZoteroListing {
        let libraries = librariesOf(base).filter { hasMirror($0.root) }
        if libraries.isEmpty { return .error("Your Zotero library is still syncing…") }
        let parts = rel.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        if parts.isEmpty {
            let dirs = libraries.map { ZoteroEntry(name: $0.shown, rel: $0.shown, dir: true, type: "folder") }
            var unsorted: [ZoteroEntry] = []
            for lib in libraries {
                for item in readItems(lib.root) ?? [] { unsorted.append(itemEntry(item, group: lib.group, library: lib.group.isEmpty ? "" : lib.name)) }
            }
            let items = unsorted.sorted(by: entryOrder)
            let all = dirs + items
            return .entries(Array(all.prefix(maxEntries)), total: all.count)
        }
        guard let lib = libraries.first(where: { $0.shown == parts[0] }) else { return .missing }
        let level = listLevel(lib.root, parts.dropFirst().joined(separator: "/"), group: lib.group)
        guard case .entries(let entries, let total) = level else { return level }
        return .entries(entries.map { entry in
            guard entry.dir else { return entry }
            var e = entry
            e.rel = "\(lib.shown)/\(entry.rel)"
            return e
        }, total: total)
    }

    // MARK: attachments

    static func safeName(_ name: String?) -> String {
        ((name ?? "") as NSString).lastPathComponent.replacingOccurrences(of: "\0", with: "").replacingOccurrences(of: "/", with: "").replacingOccurrences(of: "\\", with: "")
    }

    /// The attachment an item opens with: its first pdf, else epub, else saved web page; nil when none.
    public static func openableOf(_ item: JSONValue?) -> JSONValue? {
        let list = item?["attachments"]?.array ?? []
        for type in openable {
            if let found = list.first(where: { $0["contentType"]?.string == type && $0["linkMode"]?.string != "linked_url" }) { return found }
        }
        return nil
    }

    /// Where an attachment's file already is on this Mac → (path, linked | storage | downloaded), or nil.
    public static func localFile(_ root: String, _ attachment: JSONValue?, storageDir: String? = defaultStorage()) -> (path: String, source: String)? {
        guard let attachment, let key = attachment["key"]?.string, isKey(key) else { return nil }
        if attachment["linkMode"]?.string == "linked_file" {
            let own = attachment["path"]?.string ?? ""
            return own.hasPrefix("/") && FileOps.isFile(own) ? (own, "linked") : nil
        }
        let name = safeName(attachment["filename"]?.string)
        if name.isEmpty { return nil }
        if let storageDir, !storageDir.isEmpty {
            let stored = join(storageDir, key, name)
            if FileOps.isFile(stored) { return (stored, "storage") }
        }
        let downloaded = join(root, "files", key, name)
        if FileOps.isFile(downloaded) { return (downloaded, "downloaded") }
        return nil
    }

    /// The file an item opens with: where it already is, else (with `download`) Zotero's copy fetched. nil with none;
    /// a download that fails throws.
    public static func resolveAttachment(_ root: String, _ item: JSONValue, storageDir: String? = defaultStorage(),
                                         download: (@Sendable (String, String) async throws -> String)? = nil) async throws -> ZoteroFile? {
        guard let attachment = openableOf(item) else { return nil }
        if let here = localFile(root, attachment, storageDir: storageDir) { return ZoteroFile(path: here.path, source: here.source, attachment: attachment) }
        if attachment["linkMode"]?.string == "linked_file" || download == nil { return nil }
        let file = try await download!(attachment["key"]?.stringish ?? "", attachment["filename"]?.stringish ?? "")
        return ZoteroFile(path: file, source: "downloaded", attachment: attachment)
    }

    /// The file an item is read from: its own attachment first, else the copy kept for it (`openAccess`).
    public static func resolvePdf(_ root: String, _ item: JSONValue, storageDir: String? = defaultStorage(),
                                  download: (@Sendable (String, String) async throws -> String)? = nil,
                                  openAccess: (@Sendable (JSONValue) async -> ZoteroKeptCopy?)? = nil) async -> ZoteroResolved {
        var failed = ""
        do {
            if let own = try await resolveAttachment(root, item, storageDir: storageDir, download: download) { return .file(own) }
        } catch {
            failed = error.localizedDescription.isEmpty ? "The file could not be downloaded." : error.localizedDescription
        }
        if let free = await openAccess?(item) {
            return .file(ZoteroFile(path: free.path, source: kept.contains(free.source) ? free.source : "open access", attachment: nil,
                                    url: free.url, foundAt: free.foundAt, via: free.via.isEmpty ? "OpenAlex" : free.via, from: free.from))
        }
        return .failed(failed)
    }

    /// An item's page in the default browser: its DOI's, else its URL; '' when it has neither.
    public static func pageOf(_ item: JSONValue) -> String {
        var doi = (item["doi"]?.stringish ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        doi = re("^https?://(dx\\.)?doi\\.org/", .caseInsensitive).replace(doi, with: "")
        doi = re("^doi:\\s*", .caseInsensitive).replace(doi, with: "")
        if !doi.isEmpty { return "https://doi.org/\(doi)" }
        let url = item["url"]?.stringish ?? ""
        return re("^https?://", .caseInsensitive).test(url) ? url : ""
    }

    /// What a chip clicked opens: a pdf (its own or a kept/free copy) for the paper viewer; else its DOI's page or URL
    /// in the default browser; else why not.
    public static func openTarget(_ root: String?, _ key: String, library: (group: String, name: String)? = nil, storageDir: String? = defaultStorage(),
                                  download: (@Sendable (String, String) async throws -> String)? = nil,
                                  openAccess: (@Sendable (JSONValue) async -> ZoteroKeptCopy?)? = nil) async -> ZoteroOpenTarget {
        guard let root, let item = itemOf(root, key) else { return .error(goneWords(root, library)) }
        let found = await resolvePdf(root, item, storageDir: storageDir, download: download, openAccess: openAccess)
        if case .file(let file) = found { return .file(path: file.path, source: file.source) }
        let url = pageOf(item)
        if !url.isEmpty { return .external(url: url, waiting: false) }
        if case .failed(let why) = found, !why.isEmpty { return .error(why) }
        return .error("This item has no file or address to open.")
    }

    /// Why an item cannot be read: gone from its library, its group no longer the person's, or nothing synced yet.
    static func goneWords(_ root: String?, _ library: (group: String, name: String)?) -> String {
        if let library, !library.group.isEmpty {
            return hasMirror(root) ? "This item is no longer in the Zotero group \"\(library.name)\"." : "This item is in a Zotero group you are no longer in, or that has not synced yet."
        }
        return hasMirror(root) ? "This item is no longer in your Zotero library." : "Your Zotero library is not synced yet."
    }

    // MARK: Bart's context

    static func attr(_ value: String?, _ max: Int = 300) -> String {
        jsSlice(re("[<>\"\\n\\r]").replace(value ?? "", with: " "), max)
    }

    static func cut(_ text: String?, _ max: Int) -> String {
        let s = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return jsLength(s) > max ? "\(jsSlice(s, max))… [cut]" : s
    }

    /// The <zotero_item> block for item `key` (`name` the title the mention was written with): metadata, BibTeX, notes,
    /// annotations, and where its file and indexed text are. An item the mirror does not hold → a `missing` line.
    public static func itemBlock(_ root: String?, _ key: String, name: String = "", library: (group: String, name: String)? = nil,
                                 storageDir: String? = defaultStorage(), download: (@Sendable (String, String) async throws -> String)? = nil,
                                 openAccess: (@Sendable (JSONValue) async -> ZoteroKeptCopy?)? = nil) async -> ZoteroBlock {
        let whereAttrs = libraryAttrs(library)
        guard let root, let item = itemOf(root, key) else {
            return ZoteroBlock(lines: ["<zotero_item key=\"\(attr(key, 40))\" title=\"\(attr(name))\"\(whereAttrs) missing=\"true\" />"], file: "", missing: true)
        }
        let itemKey = item["key"]?.stringish ?? key
        let dir = join(root, "items", itemKey)
        let resolved = await resolvePdf(root, item, storageDir: storageDir, download: download, openAccess: openAccess)
        var found: ZoteroFile?, free: ZoteroFile?, failed = ""
        switch resolved {
        case .file(let f): if kept.contains(f.source) { free = f } else { found = f }
        case .failed(let why): failed = why
        }
        let openableAttachment = openableOf(item)
        let texts = (item["attachments"]?.array ?? []).map { join(dir, "fulltext-\($0["key"]?.stringish ?? "").txt") }.filter { FileOps.isFile($0) }
        var head: [String] = ["title: \(item["title"]?.stringish ?? "")"]
        if let library { head.append("library: \(library.group.isEmpty ? "\(myLibrary) (the person's own Zotero library)" : "\(library.name) (Zotero group \(library.group))")") }
        let creators = item["creators"]?.array ?? []
        if !creators.isEmpty {
            head.append("creators: " + creators.map { c in
                let type = c["type"]?.string ?? ""
                return !type.isEmpty && type != "author" ? "\(c["name"]?.stringish ?? "") (\(type))" : (c["name"]?.stringish ?? "")
            }.joined(separator: "; "))
        }
        if let year = item["year"]?.stringish, !year.isEmpty { head.append("year: \(year)") }
        head.append("type: \(item["itemType"]?.stringish ?? "")")
        if let v = item["publication"]?.stringish, !v.isEmpty { head.append("publication: \(v)") }
        if let v = item["doi"]?.stringish, !v.isEmpty { head.append("doi: \(v)") }
        if let v = item["url"]?.stringish, !v.isEmpty { head.append("url: \(v)") }
        let tags = (item["tags"]?.array ?? []).map(\.stringish)
        if !tags.isEmpty { head.append("tags: \(tags.joined(separator: ", "))") }
        head += collectionNames(root, item).map { "collection: \($0)" }
        if let found {
            head.append("attachment: \(found.path) (\(found.attachment?["contentType"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "file"))")
        } else if let a = openableAttachment {
            let label = [a["filename"]?.string, a["title"]?.string, a["key"]?.string].compactMap { $0 }.first { !$0.isEmpty } ?? ""
            let type = a["contentType"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "file"
            head.append("attachment: \(label) (\(type)), not on this Mac\(failed.isEmpty ? "" : ": \(failed)")")
        } else {
            head.append("attachment: none")
        }
        if let free { head.append("pdf: \(free.path) (\(keptNote(free)))") }
        head += texts.map { "full text: \($0)" }
        head.append("folder: \(dir)")
        var lines = ["<zotero_item key=\"\(attr(itemKey, 40))\" cite=\"\(attr(item["citeKey"]?.stringish, 200))\"\(whereAttrs)>"] + head
        if let abstract = item["abstractNote"]?.string, !abstract.isEmpty { lines += ["<abstract>", cut(abstract, 6000), "</abstract>"] }
        let bib = (FileOps.read(join(dir, "item.bib")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !bib.isEmpty { lines += ["<bibtex>", bib, "</bibtex>"] }
        let children = FileOps.readJSON(join(dir, "children.json"))
        let notes = children?["notes"]?.array ?? []
        if !notes.isEmpty {
            var room = maxNotesChars
            lines.append("<notes>")
            for (i, note) in notes.enumerated() {
                if room <= 0 { lines.append("[\(notes.count - i) more notes in \(join(dir, "children.json"))]"); break }
                let text = cut(note["text"]?.string, min(maxNoteChars, room))
                room -= jsLength(text)
                lines += ["<note>", text, "</note>"]
            }
            lines.append("</notes>")
        }
        let annotations = children?["annotations"]?.array ?? []
        if !annotations.isEmpty {
            lines.append("<annotations>")
            for a in annotations.prefix(maxAnnotations) {
                let page = a["page"]?.stringish ?? ""
                lines.append("<annotation type=\"\(attr(a["type"]?.stringish, 40))\"\(page.isEmpty ? "" : " page=\"\(attr(page, 40))\"")>")
                if let text = a["text"]?.string, !text.isEmpty { lines += ["<quote>", text.trimmingCharacters(in: .whitespacesAndNewlines), "</quote>"] }
                if let comment = a["comment"]?.string, !comment.isEmpty { lines += ["<comment>", comment.trimmingCharacters(in: .whitespacesAndNewlines), "</comment>"] }
                lines.append("</annotation>")
            }
            if annotations.count > maxAnnotations { lines.append("[\(annotations.count - maxAnnotations) more in \(join(dir, "children.json"))]") }
            lines.append("</annotations>")
        }
        lines.append("</zotero_item>")
        let file: String
        if case .file(let f) = resolved { file = f.path } else { file = "" }
        return ZoteroBlock(lines: lines, file: file, missing: false)
    }

    static func libraryAttrs(_ library: (group: String, name: String)?) -> String {
        guard let library else { return "" }
        return library.group.isEmpty ? " library=\"\(myLibrary)\"" : " library=\"\(attr(library.name))\" group=\"\(attr(library.group, 20))\""
    }

    /// The <zotero_item> block for a mention's target, from its library's mirror under `base`; `service` downloads,
    /// finds free copies and knows Zotero's storage.
    public static func mentionBlock(_ base: String?, _ ref: String, name: String = "", service: ((String) -> ZoteroLibraryAccess?)? = nil) async -> ZoteroBlock {
        guard let parsed = parseRef(ref) else {
            return ZoteroBlock(lines: ["<zotero_item key=\"\(attr(ref, 60))\" title=\"\(attr(name))\" missing=\"true\" />"], file: "", missing: true)
        }
        let lib = service?(parsed.group)
        return await itemBlock(base.map { libraryRoot($0, parsed.group) }, parsed.key, name: name, library: (parsed.group, libraryName(base, parsed.group)),
                               storageDir: lib?.storageDir ?? defaultStorage(), download: lib?.download, openAccess: lib?.openAccess)
    }

    /// Where a kept copy came from, for its "pdf:" line.
    static func keptNote(_ copy: ZoteroFile) -> String {
        let on = copy.foundAt.isEmpty ? "" : " on \(String(copy.foundAt.prefix(10)))"
        if copy.source == "downloaded in browser" { return "source=\"downloaded in browser\": the person downloaded it in their browser\(on), after Engelbart opened the item's page there" }
        if copy.source == "added by hand" { return "source=\"added by hand\": the person chose this file as the item's pdf\(on)" }
        return "source=\"open access\": found through \(copy.via.isEmpty ? "OpenAlex" : copy.via)\(copy.url.isEmpty ? "" : " at \(copy.url)")\(on)"
    }

    static func collectionNames(_ root: String, _ item: JSONValue) -> [String] {
        var byKey: [String: JSONValue] = [:]
        for c in readCollections(root) { if let k = c["key"]?.string { byKey[k] = c } }
        return (item["collections"]?.array ?? []).compactMap { byKey[$0.stringish] }.map { c in
            let p = c["path"]?.string ?? ""
            return p.isEmpty ? (c["name"]?.stringish ?? "") : p
        }
    }

    /// The line every @bart turn carries when a mirror is there: where it is and what it holds; '' when none.
    public static func pointerLine(_ root: String?) -> String {
        guard let root else { return "" }
        var lines: [String] = []
        if let items = readItems(root) {
            lines.append("zotero library: \(root) (My Library, \(items.count) items; items.json, collections.json, library.bib, and items/<key>/ with item.bib, children.json and fulltext-*.txt)")
        }
        for lib in librariesOf(root).dropFirst() {
            if let held = readItems(lib.root) {
                lines.append("zotero group: \(lib.root) (\"\(attr(lib.name, 200))\", group \(lib.group), \(held.count) items; the same files)")
            }
        }
        return lines.joined(separator: "\n")
    }
}
