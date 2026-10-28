import Foundation
import EngelbartCore

// src/main/overleaf/stage.cjs (MATH-65, Overleaf part 1, 2026-10-07): what @bart is shown of the Overleaf projects open in
// the Stage. The tab in front, when it is an Overleaf editor: <stage source="overleaf" project="…" file="…" folder="…"
// copied_at="…">, holding <open_file> (the open file read live, at most OPEN_FILE_MAX characters around the cursor, its
// place marked CURSOR) and <selection>. `folder` is the project's copy on disk, refreshed before the turn when over a
// minute old. A page that does not answer in time says live="unavailable" and the copy is all Bart has: a <note> says so.
// Every other Overleaf tab is one line in <overleaf_tabs>. Both go in <stage>'s place in a turn (Bart's context) and in a
// resumed turn's `now`.

/// An Overleaf tab of a window (views.cjs overleafTabs): its tab id, project and title.
public struct OverleafTab: Equatable, Sendable {
    public var id: String
    public var projectId: String
    public var title: String
    public init(id: String, projectId: String, title: String) { self.id = id; self.projectId = projectId; self.title = title }
}

public struct OverleafFront: Equatable, Sendable {
    public var projectId: String
    public var name: String
    public var live: OverleafLive
    public var copy: OverleafCopyInfo?
}

public struct OverleafBackground: Equatable, Sendable {
    public var projectId: String
    public var name: String
    public var copy: OverleafCopyInfo?
}

public enum OverleafStage {
    public static let openFileMax = 60_000
    public static let cursor = "<<<cursor>>>"
    public static let copyWaitMs: Double = 15_000
    static let maxSkippedShown = 5

    /// `attrOf` of bart/highlights.cjs: <, >, " and line breaks become spaces, cut at `max`.
    static func attrOf(_ value: String?, _ max: Int) -> String { jsSlice(re("[<>\"\\n\\r]").replace(value ?? "", with: " "), max) }

    static func count(_ units: [UInt16], _ from: Int, _ to: Int) -> Int {
        var n = 0
        if from < to { for i in from..<to where units[i] == 10 { n += 1 } }
        return n
    }

    static func mb(_ bytes: Int) -> String { "\(Int((Double(bytes) / 1024 / 1024).rounded())) MB" }

    /// <open_file path lines cursor_line [shown_lines]>…CURSOR…</open_file>: a file past `max` characters is shown as whole
    /// lines around the cursor, `max` at most.
    public static func openFileXml(_ read: OverleafRead, max: Int = openFileMax) -> String {
        let units = Array(read.text.utf16)
        let head = read.head - read.offset
        var start = 0, end = units.count
        if read.offset > 0 || units.count < read.length || units.count > max {
            start = Swift.max(0, Swift.min(units.count - max, head - max / 2))
            end = Swift.min(units.count, start + max)
            // whole lines at each end, unless that would cut the cursor's own line (one longer than the window)
            let lineStart = head > 0 ? (lastIndex(of: 10, in: units, before: head - 1) + 1) : 0
            if start > 0 && start < lineStart && units[start - 1] != 10 {
                start = (firstIndex(of: 10, in: units, from: start) ?? -1) + 1
            }
            if end < units.count {
                let last = lastIndex(of: 10, in: units, before: end - 1)
                if last >= head { end = last }
            }
        }
        let first = read.cursorLine - count(units, start, head)
        let lastLine = first + count(units, start, end)
        let whole = start == 0 && end == units.count && read.offset == 0 && units.count == read.length
        let attrs = "\(read.file.isEmpty ? "" : "path=\"\(attrOf(read.file, 1024))\" ")lines=\"\(read.lines)\" cursor_line=\"\(read.cursorLine)\"\(whole ? "" : " shown_lines=\"\(first)-\(lastLine)\"")"
        let before = String(decoding: units[start..<Swift.max(start, head)], as: UTF16.self)
        let after = String(decoding: units[Swift.min(head, end)..<end], as: UTF16.self)
        return "<open_file \(attrs)>\n\(before)\(cursor)\(after)\n</open_file>\n"
    }

    /// `text.lastIndexOf('\n', from)` → index or -1.
    static func lastIndex(of unit: UInt16, in units: [UInt16], before from: Int) -> Int {
        var i = Swift.min(from, units.count - 1)
        while i >= 0 { if units[i] == unit { return i }; i -= 1 }
        return -1
    }

    static func firstIndex(of unit: UInt16, in units: [UInt16], from: Int) -> Int? {
        var i = Swift.max(0, from)
        while i < units.count { if units[i] == unit { return i }; i += 1 }
        return nil
    }

    /// <selection from_line to_line>…</selection>, or '' with nothing selected.
    public static func selectionXml(_ read: OverleafRead?) -> String {
        guard let read, !read.selection.isEmpty else { return "" }
        return "<selection from_line=\"\(read.fromLine)\" to_line=\"\(read.toLine)\">\n\(read.selection)\n</selection>\n"
    }

    /// The notes on a project's copy: not refreshed, still downloading, none at all, files left out.
    static func copyNotes(_ copy: OverleafCopyInfo?) -> [String] {
        var notes: [String] = []
        let when = copy?.fetchedAt.map(isoString) ?? ""
        if copy == nil || (copy!.folder == nil && copy!.error != nil) {
            notes.append("There is no copy of the project on disk: \(copy?.error ?? "it could not be downloaded").")
        } else if copy!.pending && copy!.folder == nil {
            notes.append("The project’s copy is still downloading; it is not on disk yet.")
        } else if copy!.pending {
            notes.append("A newer copy is still downloading; the folder holds the copy downloaded at \(when).")
        } else if let error = copy!.error {
            notes.append("The copy could not be refreshed (\(error)); the folder holds the copy downloaded at \(when).")
        }
        let skipped = copy?.skipped ?? []
        if !skipped.isEmpty {
            let named = skipped.prefix(maxSkippedShown).map { "\($0.path) (\(mb($0.bytes)), \($0.why.isEmpty ? "skipped" : $0.why))" }.joined(separator: ", ")
            notes.append("Not in the copy: \(named)\(skipped.count > maxSkippedShown ? " and \(skipped.count - maxSkippedShown) more" : "").")
        }
        return notes
    }

    /// Why the editor could not be read, for the <note> that says so.
    static func liveNote(_ live: OverleafLive?, timeoutMs: Double = OverleafEditor.readTimeoutMs) -> String {
        if case .read(let read)? = live, !read.found {
            return "The editor shows no text file now\(read.file.isEmpty ? "" : " (\(read.file) is selected in the file tree)"): an image or PDF is open, or the page is still loading. Read the project from the folder."
        }
        let why: String
        if case .failed("timeout")? = live { why = "did not answer within \(Int(timeoutMs)) ms" } else { why = "could not be read" }
        return "The Overleaf editor \(why), so the open file, what was typed in it in the last minute or so, and the cursor are not known. Read the project from the folder: it is the copy downloaded from Overleaf, which may be up to a minute old or older."
    }

    /// <stage source="overleaf" …> for the Overleaf tab in front; `screenshot` a picture of the page's path (optional).
    public static func stageBlock(name: String, live: OverleafLive?, copy: OverleafCopyInfo?, screenshot: String = "", max: Int = openFileMax,
                                  timeoutMs: Double = OverleafEditor.readTimeoutMs) -> String {
        var read: OverleafRead?
        var file = ""
        if case .read(let r)? = live {
            file = r.file
            if r.found { read = r }
        }
        var attrs = ["source=\"overleaf\"", "project=\"\(attrOf(name, 200))\""]
        if !file.isEmpty { attrs.append("file=\"\(attrOf(file, 1024))\"") }
        if let folder = copy?.folder {
            attrs.append("folder=\"\(attrOf(folder, 4096))\"")
            if let at = copy?.fetchedAt, at.isFinite { attrs.append("copied_at=\"\(isoString(at))\"") }
        }
        if read == nil { attrs.append("live=\"\(live?.ok == true ? "none" : "unavailable")\"") }
        let notes = (read == nil ? [liveNote(live, timeoutMs: timeoutMs)] : []) + copyNotes(copy)
        let body = [read.map { openFileXml($0, max: max) } ?? "", read.map { selectionXml($0) } ?? ""]
            + notes.map { "<note>\($0)</note>\n" }
            + [screenshot.isEmpty ? "" : "<screenshot path=\"\(attrOf(screenshot, 4096))\"/>\n"]
        return "<stage \(attrs.joined(separator: " "))>\n\(body.joined())</stage>"
    }

    /// <overleaf_tabs>, one line per Overleaf project open in another Stage tab; '' with none.
    public static func tabsBlock(_ background: [OverleafBackground]) -> String {
        if background.isEmpty { return "" }
        let lines = background.map { tab in
            tab.copy?.folder.map { "<project name=\"\(attrOf(tab.name, 200))\" folder=\"\(attrOf($0, 4096))\"/>" } ?? "<project name=\"\(attrOf(tab.name, 200))\" copy=\"unavailable\"/>"
        }
        return "<overleaf_tabs>\n\(lines.joined(separator: "\n"))\n</overleaf_tabs>"
    }
}

/// What a turn gathers of a window's Overleaf tabs (createOverleafStage forTurn): `front` says before it runs whether the
/// tab in front is one; `gather(dataRoot)` reads the front one live and every project's copy (waited for ≤ 15 s).
@MainActor
public final class OverleafTurn {
    public let front: Bool
    let list: [OverleafTab]
    let frontTab: OverleafTab?
    let read: (String) async -> OverleafLive
    let copies: OverleafCopies
    let copyWaitMs: Double

    init(list: [OverleafTab], frontTab: OverleafTab?, read: @escaping (String) async -> OverleafLive, copies: OverleafCopies, copyWaitMs: Double) {
        self.list = list; self.frontTab = frontTab; self.front = frontTab != nil; self.read = read; self.copies = copies; self.copyWaitMs = copyWaitMs
    }

    /// For an @bart turn: nil with no Overleaf tab. `stageKind`/`stageTab`: what the renderer says is in front.
    public static func forTurn(tabs: [OverleafTab], read: @escaping (String) async -> OverleafLive = { _ in .failed("error") }, stageKind: String?, stageTab: String?,
                               copies: OverleafCopies, copyWaitMs: Double = OverleafStage.copyWaitMs) -> OverleafTurn? {
        let list = tabs.filter { !$0.id.isEmpty && !$0.projectId.isEmpty }
        if list.isEmpty { return nil }
        let frontTab = stageKind == "web" && stageTab != nil ? list.first { $0.id == stageTab } : nil
        return OverleafTurn(list: list, frontTab: frontTab, read: read, copies: copies, copyWaitMs: copyWaitMs)
    }

    public func gather(dataRoot: String) async -> (front: OverleafFront?, background: [OverleafBackground]) {
        var ids: [String] = []
        for tab in list where !ids.contains(tab.projectId) { ids.append(tab.projectId) }
        var held: [String: OverleafCopyInfo] = [:]
        async let live: OverleafLive? = frontTab != nil ? read(frontTab!.id) : nil
        var tasks: [String: Task<OverleafCopyInfo, Never>] = [:]
        for id in ids { tasks[id] = Task { @MainActor in await self.copyOf(dataRoot, id) } }
        for id in ids { held[id] = await tasks[id]!.value }
        let liveValue = await live
        func nameOf(_ tab: OverleafTab, _ fromPage: String = "") -> String {
            if !fromPage.isEmpty { return fromPage }
            let title = OverleafEditor.projectTitle(tab.title)
            return title.isEmpty ? "Overleaf project \(tab.projectId)" : title
        }
        var front: OverleafFront?
        if let frontTab {
            front = OverleafFront(projectId: frontTab.projectId, name: nameOf(frontTab, liveValue?.readValue?.projectName ?? ""), live: liveValue ?? .failed("error"), copy: held[frontTab.projectId])
        }
        var seen = Set(front.map { [$0.projectId] } ?? [])
        var background: [OverleafBackground] = []
        for tab in list where seen.insert(tab.projectId).inserted {
            background.append(OverleafBackground(projectId: tab.projectId, name: nameOf(tab), copy: held[tab.projectId]))
        }
        return (front, background)
    }

    /// The copy within `copyWaitMs`, else what is on disk now marked `pending`.
    private func copyOf(_ dataRoot: String, _ id: String) async -> OverleafCopyInfo {
        let once = OnceBox<OverleafCopyInfo>()
        let copies = self.copies
        let wait = copyWaitMs
        return await withCheckedContinuation { (c: CheckedContinuation<OverleafCopyInfo, Never>) in
            once.set(c)
            Task { @MainActor in once.resume(await copies.ensure(dataRoot, id)) }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
                var info = copies.info(dataRoot, id) ?? OverleafCopyInfo(projectId: id)
                info.pending = true
                once.resume(info)
            }
        }
    }
}
