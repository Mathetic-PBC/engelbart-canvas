import AppKit
import EngelbartCore
import EngelbartStore
import EngelbartUI
import SwiftUI
import XCTest
@testable import EngelbartScreens

// Fixtures, fakes and the offscreen window the view tests draw in (never ordered front).

func decode<T: Decodable>(_ type: T.Type, _ json: JSONValue) -> T {
    try! JSONDecoder().decode(T.self, from: Data(json.text().utf8))
}

func uuid(_ n: Int) -> String { String(format: "%08d-1111-4111-8111-111111111111", n) }

func project(_ id: String, _ name: String, workspaces: Int = 0, lastEdited: String? = nil, recent: [JSONValue] = [], libraryIds: [String] = []) -> PublicProject {
    decode(PublicProject.self, ["id": .string(id), "name": .string(name), "slug": .string(name.lowercased()), "dir": .string("/tmp/\(id)"),
                                "created": nil, "directory": "/tmp/code", "directoryMissing": nil, "description": "",
                                "workspaceCount": .number(Double(workspaces)), "lastEdited": lastEdited.map(JSONValue.string) ?? .null,
                                "recent": .array(recent), "libraryIds": .array(libraryIds.map(JSONValue.string))])
}

func recent(_ id: String, _ name: String, path: String? = nil, text: String = "") -> JSONValue {
    ["id": .string(id), "name": .string(name), "path": .string(path ?? name), "chars": .number(Double(text.count)), "edited": nil, "text": .string(text)]
}

func trashed(_ id: String, _ name: String, deleted: Date, expires: Date) -> TrashedProject {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return decode(TrashedProject.self, ["id": .string(id), "name": .string(name), "deleted": .string(iso.string(from: deleted)),
                                        "expires": .string(iso.string(from: expires)), "workspaceCount": 3])
}

func row(_ id: String, _ name: String, type: String = "pdf", tags: [String] = [], url: String? = nil, path: String? = nil, projectId: String? = nil,
         lastEdited: String = "2026-10-01T00:00:00.000Z", summary: String? = nil, folderPath: String? = nil, githubId: String? = nil) -> LibraryRow {
    LibraryRow(id: id, name: name, type: type, path: path, url: url, folderPath: folderPath, projectId: projectId, lastEdited: lastEdited, summary: summary,
               githubId: githubId, tags: tags)
}

func holder(_ id: String, _ name: String, workspaces: [(String, String)] = []) -> Library.Holder {
    decode(Library.Holder.self, ["id": .string(id), "name": .string(name), "origin": false,
                                 "workspaces": .array(workspaces.map { ["id": .string($0.0), "name": .string($0.1), "path": .string($0.1)] })])
}

func preview(_ id: String, text: String? = nil, files: [String]? = nil, owner: String? = nil, folder: String? = nil, folderMissing: String? = nil, heldBy: [Library.Holder] = []) -> Library.Preview {
    var json: [String: JSONValue] = ["id": .string(id), "heldBy": .array(heldBy.map { JSONValue.encode($0) })]
    if let text { json["text"] = .string(text) }
    if let files { json["files"] = .array(files.map(JSONValue.string)) }
    if let owner { json["owner"] = .string(owner) }
    if let folder { json["folder"] = .string(folder) }
    if let folderMissing { json["folderMissing"] = .string(folderMissing) }
    return decode(Library.Preview.self, .object(json))
}

/// The renderer's api, recorded.
final class FakeData: HomeData, OnboardingData {
    var rows: [LibraryRow] = []
    var calls: [String] = []
    var refuse: [String: String] = [:]          // input → message
    var holders: [String: [Library.Holder]] = [:]
    var holdersFail = false
    var previews: [String: Library.Preview] = [:]
    var bodies: [String: String] = [:]
    var picked: [String] = []
    var saved = ""
    var shown = "~/my-project"
    var folderProblem: String?
    var startProblem: String?
    var started: [OnboardingFlow.ProjectInput] = []
    var welcomed: [(String, [String], String?)] = []
    var about = ProjectAbout(name: "Thesis", description: "on help-seeking")
    var sandboxError: String?
    var offers: [String] = []
    var discardable = true
    var next = 100

    func add(_ input: String, type: String = "website") throws -> LibraryRow {
        if let message = refuse[input] {
            if message.hasPrefix("Already in the library as “"), let held = rows.first(where: { message.contains($0.name) }) {
                throw StoreError(message, code: "EXISTS", row: held)
            }
            throw StoreError(message)
        }
        next += 1
        let name = input.split(separator: "/").last.map(String.init) ?? input
        let made = row(uuid(next), name, type: input.hasSuffix(".pdf") ? "pdf" : type, url: input.hasPrefix("http") ? input : nil, path: input.hasPrefix("/") ? input : nil)
        rows.append(made)
        return made
    }

    // HomeData
    func addLibraryItem(_ input: String) async throws -> LibraryRow { calls.append("add \(input)"); return try add(input) }
    func addLibraryFile(_ bytes: Data, mime: String, name: String?) async throws -> LibraryRow {
        calls.append("file \(mime) \(bytes.count)")
        next += 1; let made = row(uuid(next), name ?? "Image", type: "png"); rows.append(made); return made
    }
    func addLibraryUrl(_ input: String) async throws -> LibraryRow { calls.append("url \(input)"); return try add(input) }
    func pickLibraryPaths(_ kind: String?) async -> [String] { calls.append("pick \(kind ?? "")"); return picked }
    func previewLibraryItem(_ id: String) async throws -> Library.Preview {
        calls.append("preview \(id)")
        guard let p = previews[id] else { throw StoreError("no preview") }
        return p
    }
    func projectsForLibraryItem(_ id: String) async throws -> [Library.Holder] {
        calls.append("holders \(id)")
        if holdersFail { throw StoreError("Unknown library item") }
        return holders[id] ?? []
    }
    func libraryBodies() async throws -> [String: String] { calls.append("bodies"); return bodies }

    // OnboardingData
    func library() async throws -> [LibraryRow] { rows }
    func addLibraryItem(_ input: String) async throws -> (row: LibraryRow, sandboxError: String?) {
        calls.append("add \(input)")
        return (try add(input), sandboxError)
    }
    func lookupLibraryItem(_ input: String) async throws -> LibraryRow? { rows.first { $0.url == input || $0.path == input } }
    func discardLibraryItem(_ id: String) async throws -> Bool {
        calls.append("discard \(id)")
        guard discardable else { return false }
        rows.removeAll { $0.id == id }
        return true
    }
    func instructions() async throws -> String { saved }
    func setInstructions(_ text: String) async throws { calls.append("instructions"); saved = text.trimmingCharacters(in: .whitespacesAndNewlines) }
    func freeFolder(_ name: String) async throws -> String { "~/" + name.lowercased().replacingOccurrences(of: " ", with: "-") }
    func checkFolder(_ path: String) async throws { calls.append("check \(path)"); if let folderProblem { throw StoreError(folderProblem) } }
    func startProject(_ input: OnboardingFlow.ProjectInput) async throws -> Onboarded {
        calls.append("start")
        if let startProblem { throw StoreError(startProblem) }
        started.append(input)
        return Onboarded(projectId: "p-new", projectName: input.name, workspaceId: "w-new", noteId: "n1", noteName: "Welcome!", welcomePage: input.onboarding)
    }
    func welcomeWorkspace(_ projectId: String, context: [String], connect: String?) async throws -> Onboarded {
        calls.append("welcome")
        welcomed.append((projectId, context, connect))
        return Onboarded(projectId: projectId, workspaceId: "w-welcome", gettingStarted: true)
    }
    func projectAbout(_ id: String) async throws -> ProjectAbout { about }
    func connectOfferSeen(_ how: String) async { offers.append(how) }
}

/// Lets the main queue and SwiftUI take what was asked.
@MainActor
func settle(_ seconds: Double = 0.15) async {
    try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    await Task.yield()
}

@MainActor
func until(_ seconds: Double = 3, _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() && Date() < deadline { await settle(0.03) }
}

/// An offscreen window (defer: false, never ordered front) holding the view.
@MainActor
final class Offscreen {
    let window: NSWindow
    let host: NSView
    /// The probed parts (Probe.swift): identifier → frame (y down) and press.
    let book = ProbeBook()

    init<V: View>(_ view: V, size: CGSize, chrome: WindowChrome = WindowChrome()) {
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let hosting = NSHostingView(rootView: AnyView(view.environmentObject(chrome).environment(\.probeBook, book)))
        hosting.frame = NSRect(origin: .zero, size: size)
        window.contentView = hosting
        host = hosting
        hosting.layoutSubtreeIfNeeded()
    }

    func layout() { host.layoutSubtreeIfNeeded() }

    func has(_ id: String) -> Bool { layout(); return book.has(id) }
    func frame(_ id: String) -> CGRect? { layout(); return book.frame(id) }
    func ids(prefix: String) -> [String] { layout(); return book.ids(prefix: prefix) }
    @discardableResult func press(_ id: String) -> Bool { layout(); return book.press(id) }

    /// The drawn picture.
    func bitmap() -> NSBitmapImageRep {
        layout()
        let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds)!
        host.cacheDisplay(in: host.bounds, to: rep)
        return rep
    }

    /// The colour at a point of the content (y down), as sRGB.
    func color(_ rep: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> NSColor {
        let scale = CGFloat(rep.pixelsWide) / host.bounds.width
        let c = rep.colorAt(x: Int(x * scale), y: Int(y * scale)) ?? .clear
        return c.usingColorSpace(.sRGB) ?? c
    }
}

/// Whether two colours are within `tolerance` (0–255) on every channel.
func near(_ a: NSColor, _ hex: String, _ tolerance: CGFloat = 6) -> Bool {
    let b = NSColor(hex: hex).usingColorSpace(.sRGB)!
    let c = a.usingColorSpace(.sRGB)!
    return abs(c.redComponent - b.redComponent) * 255 <= tolerance && abs(c.greenComponent - b.greenComponent) * 255 <= tolerance
        && abs(c.blueComponent - b.blueComponent) * 255 <= tolerance
}
