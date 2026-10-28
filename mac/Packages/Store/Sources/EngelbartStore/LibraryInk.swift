import Foundation
import EngelbartCore

/// Ink: the marks drawn on a library pdf (`annotations/<id>.json`), on a pdf or a web page read in the Stage before the
/// library held it (`annotations/pages/<sha256 of its address>.json`), and a web page's highlights and boxes, whose
/// pictures are `annotations/crops/<mark id>[-n].png` (library.cjs, MATH-27, MATH-54, MATH-70).
extension Library {
    /// Ink is written one change at a time (MATH-27 second pass): an answer put on a mark reads the ink and writes it back,
    /// and a save from the Stage must not land between the two.
    static let inkTurn = NSRecursiveLock()
    static func inTurn<T>(_ work: () throws -> T) rethrows -> T { inkTurn.lock(); defer { inkTurn.unlock() }; return try work() }

    public static let web = "web"

    static func annotationFile(_ ctx: StoreContext, _ id: String) throws -> String {
        guard Ids.isUUID(id) else { throw StoreError.type("library id is invalid") }
        return Paths.join(ctx.dataRoot, "annotations", "\(id).json")
    }

    static func readJSONFile(_ file: String) -> JSONValue? { JSONFiles.read(file) }

    /// A row's ink; for a row with none yet, the ink its pdf got on the Stage before the library held it.
    public static func readAnnotations(_ ctx: StoreContext, _ id: String) throws -> JSONValue? {
        if let own = readJSONFile(try annotationFile(ctx, id)) { return own }
        guard let row = try ctx.libraryDb.get(id) else { return nil }
        for address in inkAddresses(path: row.path, url: row.url) {
            if let ink = readJSONFile(pageAnnotationFile(ctx, address)) { return ink }
        }
        return nil
    }

    @discardableResult
    public static func writeAnnotations(_ ctx: StoreContext, _ id: String, _ value: JSONValue) throws -> Bool {
        try inTurn { try writeInk(try annotationFile(ctx, id), value) }
    }

    /// The address as ink was filed by before MATH-54: as the library spells it, without its #fragment.
    static func rawAddress(_ url: String) -> String { url.firstIndex(of: "#").map { String(url[..<$0]) } ?? url }

    /// What ink is kept by, in the order it is looked for (the first is where it is written): a file's real path as a
    /// file URL; an address as addressKey spells it, then as filed before. A preview's address is none of them.
    static func inkAddresses(path: String?, url: String?) -> [String] {
        var out: [String] = []
        if let path { out.append(Paths.fileURL(Paths.realOrNil(path) ?? Paths.resolve(path))) }
        if let url, !AddressKey.isPreviewAddress(url) { out.append(AddressKey.key(url)); out.append(rawAddress(url)) }
        var unique: [String] = []
        for a in out where !a.isEmpty && !unique.contains(a) { unique.append(a) }
        return unique
    }

    static func pageAnnotationFile(_ ctx: StoreContext, _ address: String) -> String {
        Paths.join(ctx.dataRoot, "annotations", "pages", "\(Data(address.utf8).sha256Hex).json")
    }

    /// The file a library row's ink is in: its own, else the one from before the library held it; nil when it has none.
    public static func inkFileOf(_ ctx: StoreContext, _ row: LibraryRow) -> String? {
        guard Ids.isUUID(row.id), let own = try? annotationFile(ctx, row.id) else { return nil }
        if Paths.exists(own) { return own }
        return inkAddresses(path: row.path, url: row.url).map { pageAnnotationFile(ctx, $0) }.first(where: Paths.exists)
    }

    enum InkPlace { case row(String); case file(String?, older: [String]) }

    /// Where the ink of `input` (an address or a path) is: the library's row, else the file it is written to and the
    /// ones it may have been filed in before; nothing for a preview.
    static func inkPlace(_ ctx: StoreContext, _ input: String) throws -> InkPlace {
        if AddressKey.isPreviewAddress(input) { return .file(nil, older: []) }
        let found = try resolveAddition(input, homeDir: ctx.homeDir)
        if let row = sameAs(try ctx.libraryDb.list(), found) { return .row(row.id) }
        let files = inkAddresses(path: found.path, url: found.url).map { pageAnnotationFile(ctx, $0) }
        return .file(files.first, older: Array(files.dropFirst()))
    }

    static func readPlace(_ file: String?, _ older: [String]) -> JSONValue? {
        ([file].compactMap { $0 } + older).lazy.compactMap(readJSONFile).first
    }

    public static func readPageAnnotations(_ ctx: StoreContext, _ input: String) throws -> JSONValue? {
        switch try inkPlace(ctx, input) {
        case .row(let id): return try readAnnotations(ctx, id)
        case .file(let file, let older): return readPlace(file, older)
        }
    }

    /// Ink made on `found` while it was only an address becomes row `id`'s, when that has none of its own.
    static func carryInk(_ ctx: StoreContext, _ found: Found, _ id: String) throws {
        guard let before = inkAddresses(path: found.path, url: found.url).map({ pageAnnotationFile(ctx, $0) }).first(where: Paths.exists) else { return }
        let own = try annotationFile(ctx, id)
        if !Paths.exists(own) {
            try JSONFiles.makeDir(Paths.dirname(own))
            try FileManager.default.copyItem(atPath: before, toPath: own)
        }
    }

    /// The absolute path of the file a pdf's or web page's ink is read from (`rowId` or `url`): where it would be written
    /// when there is none yet; '' for a preview. For @bart (MATH-27), to read again.
    public static func annotationsFileOf(_ ctx: StoreContext, rowId: String? = nil, url: String? = nil) throws -> String {
        let place: InkPlace = try rowId.map { .row($0) } ?? inkPlace(ctx, url ?? "")
        switch place {
        case .file(let file, let older):
            return ([file].compactMap { $0 } + older).first(where: Paths.exists) ?? file ?? ""
        case .row(let id):
            let own = try annotationFile(ctx, id)
            if Paths.exists(own) { return own }
            if let row = try ctx.libraryDb.get(id) {
                for address in inkAddresses(path: row.path, url: row.url) where Paths.exists(pageAnnotationFile(ctx, address)) { return pageAnnotationFile(ctx, address) }
            }
            return own
        }
    }

    /// → whether it was written: a preview's ink is not.
    @discardableResult
    public static func writePageAnnotations(_ ctx: StoreContext, _ input: String, _ value: JSONValue) throws -> Bool {
        try inTurn {
            switch try inkPlace(ctx, input) {
            case .row(let id): return try writeInk(try annotationFile(ctx, id), value)
            case .file(let file, _): return try file.map { try writeInk($0, value) } ?? false
            }
        }
    }

    /// shared/mark-answers.cjs withAsk: an answer onto mark `markId` on `page` (nil: the "web" list), once, and only while
    /// the mark is there. → the marks (unchanged when the mark is gone or has it).
    public static func withAsk(_ marks: JSONValue, page: Int?, markId: String, entry: JSONValue) -> JSONValue {
        let key = page.map(String.init) ?? web
        guard case .object(var all) = marks, let list = all[key]?.array,
              let index = list.firstIndex(where: { $0["id"]?.string == markId }) else { return marks }
        let mark = list[index]
        let asks = mark["asks"]?.array ?? []
        if asks.contains(where: { $0["id"] == entry["id"] }) { return marks }
        var next = list
        next[index] = mark.merging(["asks": .array(asks + [entry])])
        all[key] = .array(next)
        return .object(all)
    }

    static func place(_ ctx: StoreContext, rowId: String?, url: String?) throws -> (file: String?, held: JSONValue?) {
        if let rowId { return (try annotationFile(ctx, rowId), try readAnnotations(ctx, rowId)) }
        switch try inkPlace(ctx, url ?? "") {
        case .row(let id): return (try annotationFile(ctx, id), try readAnnotations(ctx, id))
        case .file(let file, let older): return (file, readPlace(file, older))
        }
    }

    /// A finished answer from a highlight's note onto its mark (`page` nil for a web page's mark). → whether written.
    @discardableResult
    public static func addMarkAnswer(_ ctx: StoreContext, rowId: String? = nil, url: String? = nil, page: Int?, markId: String, entry: JSONValue) throws -> Bool {
        try inTurn {
            let at = try place(ctx, rowId: rowId, url: url)
            guard let file = at.file else { return false }
            let marks = at.held?.isPlainObject == true ? at.held! : .object([:])
            let next = withAsk(marks, page: page, markId: markId, entry: entry)
            if next == marks { return false }
            return try writeInk(file, next)
        }
    }

    /// The web page `url`'s ink: { file, marks, list (its "web" list) }, or nil for a page whose ink is not kept.
    static func webInk(_ ctx: StoreContext, _ url: String) -> (file: String, marks: JSONValue, list: [JSONValue])? {
        guard let at = try? place(ctx, rowId: nil, url: url), let file = at.file else { return nil }
        let marks = at.held?.isPlainObject == true ? at.held! : .object([:])
        return (file, marks, marks[web]?.array ?? [])
    }

    /// The absolute path of a box's picture from its mark's `crop`, or nil for anything that is not "crops/<id>.png".
    public static func cropFile(_ ctx: StoreContext, _ crop: String?) -> String? {
        guard let id = Boxes.cropId(crop) else { return nil }
        return Paths.join(ctx.dataRoot, "annotations", "crops", "\(id).png")
    }

    static func writeCrop(_ file: String, _ png: Data) throws {
        try JSONFiles.makeDir(Paths.dirname(file))
        try JSONFiles.writeData(file, png)
    }

    /// Every picture of a mark there is: those it and its asks name, and any other "crops/<id>-<n>.png" left by a resize.
    static func picturesOf(_ ctx: StoreContext, _ mark: JSONValue) -> [String] {
        var names = Boxes.cropsOf(mark)
        let id = mark["id"]?.string
        for file in Paths.listDir(Paths.join(ctx.dataRoot, "annotations", "crops")) ?? [] {
            let crop = "crops/\(file)"
            if Boxes.cropNumber(id, crop) >= 0 && !names.contains(crop) { names.append(crop) }
        }
        return names
    }

    /// A highlight or box made on a web page, added to the end of its ink's "web" list; a box's picture written first.
    /// → whether it was written (a preview's, or a page the library cannot place, is not).
    @discardableResult
    public static func addWebMark(_ ctx: StoreContext, url: String, mark: JSONValue, crop: Data? = nil) throws -> Bool {
        try inTurn {
            guard let at = webInk(ctx, url) else { return false }
            if at.list.contains(where: { $0["id"] == mark["id"] }) { return false }
            let picture = (crop?.isEmpty == false && mark["crop"]?.string != nil) ? cropFile(ctx, mark["crop"]?.string) : nil
            if let picture, let crop { try writeCrop(picture, crop) }
            do { return try writeInk(at.file, at.marks.merging([web: .array(at.list + [mark])])) }
            catch { if let picture { try? FileManager.default.removeItem(atPath: picture) }; throw error }
        }
    }

    /// Mark `markId` of web page `url`'s "web" list, or nil.
    public static func readWebMark(_ ctx: StoreContext, rowId: String? = nil, url: String? = nil, markId: String) -> JSONValue? {
        let ink: JSONValue?
        if let rowId { ink = (try? readAnnotations(ctx, rowId)) ?? nil } else { ink = (try? readPageAnnotations(ctx, url ?? "")) ?? nil }
        return (ink?[web]?.array ?? []).first { $0["id"]?.string == markId }
    }

    /// What a change to a web mark may set: its note, a box's rectangle and the text under it.
    static let patchable = ["note", "box", "text"]

    /// Mark `markId` with `patch` put on it; a box given a new picture (`crop`) under the next name. → the mark, or nil.
    @discardableResult
    public static func updateWebMark(_ ctx: StoreContext, url: String, markId: String, patch: [String: JSONValue], crop: Data? = nil) throws -> JSONValue? {
        try inTurn {
            guard let at = webInk(ctx, url), let index = at.list.firstIndex(where: { $0["id"]?.string == markId }) else { return nil }
            let was = at.list[index]
            var next = was.object ?? [:]
            for key in patchable { if let value = patch[key] { next[key] = value } }
            if next["box"] != nil && !Boxes.isBox(.object(next)) { return nil } // a box stays a box
            var picture: String?
            if let crop, !crop.isEmpty, Boxes.isBox(was) {
                next["crop"] = .string(Boxes.nextCropName(was))
                picture = cropFile(ctx, next["crop"]?.string)
                if let picture { try writeCrop(picture, crop) } else { next["crop"] = was["crop"] }
            }
            var list = at.list
            list[index] = .object(next)
            do { try writeInk(at.file, at.marks.merging([web: .array(list)])) }
            catch { if let picture { try? FileManager.default.removeItem(atPath: picture) }; throw error }
            return .object(next)
        }
    }

    public struct RemovedMark: Sendable { public var mark: JSONValue; public var index: Int; public var crops: [(crop: String, bytes: Data)] }

    /// Mark `markId` taken out of the "web" list and every picture of it deleted (returned, for undo).
    public static func removeWebMark(_ ctx: StoreContext, url: String, markId: String) throws -> RemovedMark? {
        try inTurn {
            guard let at = webInk(ctx, url), let index = at.list.firstIndex(where: { $0["id"]?.string == markId }) else { return nil }
            let mark = at.list[index]
            var list = at.list; list.remove(at: index)
            try writeInk(at.file, at.marks.merging([web: .array(list)]))
            var crops: [(String, Data)] = []
            for crop in Boxes.isBox(mark) ? picturesOf(ctx, mark) : [] {
                guard let file = cropFile(ctx, crop) else { continue }
                if let bytes = FileManager.default.contents(atPath: file) { crops.append((crop, bytes)) }
                try? FileManager.default.removeItem(atPath: file)
            }
            return RemovedMark(mark: mark, index: index, crops: crops)
        }
    }

    /// What removeWebMark gave back, put back: the mark at its index (the end, if the list is shorter now), its pictures.
    @discardableResult
    public static func restoreWebMark(_ ctx: StoreContext, url: String, _ removed: RemovedMark) throws -> Bool {
        guard let id = removed.mark["id"]?.string else { return false }
        return try inTurn {
            guard let at = webInk(ctx, url), !at.list.contains(where: { $0["id"]?.string == id }) else { return false }
            for (crop, bytes) in removed.crops where Boxes.cropNumber(id, crop) >= 0 && !bytes.isEmpty { // only the mark's own
                if let file = cropFile(ctx, crop) { try writeCrop(file, bytes) }
            }
            var list = at.list
            list.insert(removed.mark, at: max(0, min(removed.index, list.count)))
            return try writeInk(at.file, at.marks.merging([web: .array(list)]))
        }
    }

    /// Ink written whole or not at all, at most 20 MB, 0600.
    @discardableResult
    static func writeInk(_ file: String, _ value: JSONValue) throws -> Bool {
        let text = (value.isNull ? JSONValue.object([:]) : value).text()
        if text.utf16.count > 20 * 1024 * 1024 { throw StoreError.type("annotations are too large") }
        try JSONFiles.makeDir(Paths.dirname(file))
        try JSONFiles.writeText(file, text)
        return true
    }
}
