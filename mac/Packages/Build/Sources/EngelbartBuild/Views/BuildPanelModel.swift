import Foundation
import SwiftUI
import EngelbartCore

/// What the Build views ask of the app (the preload's build* calls; BuildService implements every one).
public protocol BuildActions: AnyObject, Sendable {
    func buildModels(_ place: String) async throws -> JSONValue
    func rememberModelChoice(_ place: String, provider: String, model: String, effort: String) async throws
    func buildTargets(_ projectId: String) async throws -> [JSONValue]
    func buildSetDefault(_ projectId: String, _ target: JSONValue) async throws -> [JSONValue]
    func buildPreflight(_ projectId: String, _ target: JSONValue) async throws -> JSONValue
}

extension BuildService: BuildActions {
    public func buildSetDefault(_ projectId: String, _ target: JSONValue) async throws -> [JSONValue] { try await buildSetDefault(projectId, Optional(target)) }
    public func buildPreflight(_ projectId: String, _ target: JSONValue) async throws -> JSONValue { try await buildPreflight(projectId, Optional(target)) }
}

/// A library row the panel can attach ("Add from library") and the glyph it draws.
public struct PanelLibraryItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var type: String
    public var tags: [String]
    public init(id: String, name: String, type: String, tags: [String] = []) { self.id = id; self.name = name; self.type = type; self.tags = tags }
}

/// The workspace's Build panel's state (BuildPanel.jsx, 2026-09-27; B2): the repository it works in (the project's
/// default repo unless another is picked; the pick is remembered per workspace; Make default), Add from library and the
/// attached items, "Automatically clear workspace" (off each time), a line when the repository leaves something out, is
/// made or cloned when the Build starts, or cannot take a Build, and the model chip with the send inside it.
@MainActor
public final class BuildPanelModel: ObservableObject {
    public struct Start: Sendable {
        public var provider: String, model: String, effort: String
        public var attach: [String]
        public var clear: Bool
        public var target: JSONValue
    }

    public let projectId: String
    public let workspaceId: String?
    public let title: String
    let actions: BuildActions
    let storage: BuildTarget.Storage?
    /// `onStart`: starts it (the Workspace does, then clears when asked); the panel closes only on Esc, ×, a press
    /// elsewhere, never while sending.
    let onStart: (Start) async throws -> Void

    @Published public var choices: BuildChoices?
    @Published public var choice: (provider: String, model: String, effort: String)?
    @Published public var targets: [JSONValue]?
    @Published public var target: JSONValue?
    @Published public var preflight: JSONValue?
    @Published public var attached: [PanelLibraryItem] = []
    @Published public var clear = false
    @Published public var busy = false
    @Published public var error = ""
    @Published public var cloning = false
    /// "library" | "target" while a search is up.
    @Published public var lookup: String?
    @Published public var pickerOpen = false

    public init(projectId: String, workspaceId: String?, title: String, actions: BuildActions, storage: BuildTarget.Storage? = BuildTarget.Defaults(),
                onStart: @escaping (Start) async throws -> Void) {
        self.projectId = projectId; self.workspaceId = workspaceId; self.title = title; self.actions = actions; self.storage = storage; self.onStart = onStart
    }

    /// The list starts on the model last picked here (main keeps it), else on Build's default.
    public func load() async {
        do {
            let models = try await actions.buildModels("build")
            if let c = BuildChoices(json: models), let p = c.entry(c.provider) {
                choices = c
                choice = (c.provider, p.start.model, p.start.effort)
            }
        } catch { self.error = error.text }
        do {
            let list = try await actions.buildTargets(projectId)
            targets = list
            target = BuildTarget.picked(projectId, workspaceId, list, storage: storage)
        } catch { self.error = error.text; target = BuildTarget.defaultTarget }
        await check()
    }

    /// What the picked repository says: whether it can take a Build, or must be made or cloned first.
    public func check() async {
        guard let target else { return }
        preflight = nil
        error = ""
        do { preflight = try await actions.buildPreflight(projectId, target) } catch { self.error = error.text }
    }

    public var ready: Bool {
        guard choice != nil, target != nil, let pre = preflight, !busy else { return false }
        return pre["ok"]?.bool == true || pre["canClone"]?.bool == true
    }

    /// The line under the chips: the error or the problem (red), or a note (grey).
    public var line: (text: String, alarming: Bool)? {
        let pre = preflight
        let problem = pre != nil && pre!["ok"]?.bool != true && pre!["canClone"]?.bool != true ? pre!["problems"]?[0]?["message"]?.string ?? "" : ""
        var note = ""
        if let pre {
            if pre["ok"]?.bool == true && pre["create"]?.bool == true { note = "Makes \(pre["target"]?["name"]?.string ?? "")/ in the project folder, with a history of its own." }
            else if pre["ok"]?.bool != true && pre["canClone"]?.bool == true {
                let to = pre["cloneTo"]?.string ?? ""
                note = cloning ? "Cloning into \(to)…" : "Clones it into \(to) in the project folder first."
            } else if pre["ok"]?.bool == true, let dirty = pre["dirty"]?.int, dirty > 0 { note = "\(dirty) uncommitted \(dirty == 1 ? "file" : "files") left out" }
        }
        let text = !error.isEmpty ? error : !problem.isEmpty ? problem : note
        return text.isEmpty ? nil : (text, !error.isEmpty || !problem.isEmpty)
    }

    public var current: JSONValue? { target.flatMap { t in targets?.first { BuildTarget.same($0, t) } } }

    public var chipText: String {
        guard let c = choice, let model = choices?.entry(c.provider)?.model(c.model) else { return "…" }
        return "\(model.name) \(EffortLabels.label(c.effort))"
    }

    public func send() async {
        guard ready, let c = choice, let target, let pre = preflight else { return }
        busy = true
        cloning = pre["ok"]?.bool != true && pre["canClone"]?.bool == true
        error = ""
        do {
            try await onStart(Start(provider: c.provider, model: c.model, effort: c.effort, attach: attached.map(\.id), clear: clear, target: target))
        } catch {
            self.error = error.text
            busy = false
            cloning = false
            if pre["canClone"]?.bool == true { if let p = try? await actions.buildPreflight(projectId, target) { preflight = p } }
        }
    }

    /// Make default: the project's default repo (every workspace's, and post-its'); the picker's rows read again.
    public func makeDefault(_ item: JSONValue) async {
        guard !busy else { return }
        busy = true
        error = ""
        let t: JSONValue = item["kind"]?.string == "library" ? ["kind": "library", "id": item["id"] ?? .null] : ["kind": item["kind"] ?? "default"]
        do {
            let list = try await actions.buildSetDefault(projectId, t)
            targets = list
            if let now = target, !list.contains(where: { BuildTarget.same($0, now) }) { target = BuildTarget.defaultTarget }
            busy = false
            await check()
        } catch { self.error = error.text; busy = false }
    }

    public func pickTarget(_ item: JSONValue) async {
        let next: JSONValue = item["kind"]?.string == "library" ? ["kind": "library", "id": item["id"] ?? .null] : ["kind": item["kind"] ?? "default"]
        BuildTarget.remember(projectId, workspaceId, next, storage: storage)
        target = next
        lookup = nil
        await check()
    }

    public func pickModel(provider: String, model: String, effort: String) {
        choice = (provider, model, effort)
        Task { try? await actions.rememberModelChoice("build", provider: provider, model: model, effort: effort) } // the next panel starts here
    }

    public func attach(_ item: PanelLibraryItem) {
        if !attached.contains(where: { $0.id == item.id }) { attached.append(item) }
        lookup = nil
    }

    public func remove(_ id: String) { attached.removeAll { $0.id == id } }

    /// The repository picker's rows for a query: every word in name, folder or url; its tag (✓ on the picked one).
    public func targetRows(_ query: String, sandboxed: (String) -> Bool = { _ in false }) -> [(key: String, item: JSONValue, name: String, tag: String, canMakeDefault: Bool)] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        return (targets ?? []).filter { item in
            let hay = "\(item["name"]?.string ?? "") \(item["folder"]?.string ?? "") \(item["url"]?.string ?? "")".lowercased()
            return words.allSatisfy { hay.contains($0) }
        }.map { item in
            let id = item["id"]?.string ?? ""
            return (BuildTarget.key(item), item, item["name"]?.string ?? "", "\(BuildTarget.same(item, target) ? "✓ " : "")\(BuildTarget.tag(item, sandboxed: sandboxed(id)))", item["kind"]?.string != "default")
        }
    }
}
