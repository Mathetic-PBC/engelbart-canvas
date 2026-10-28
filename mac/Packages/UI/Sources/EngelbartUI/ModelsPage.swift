import EngelbartCore
import SwiftUI

// Settings ▸ Models (ui/Settings.jsx IntelligenceLevels; model/intelligence.js): per provider offered, a group of the
// three @discover levels, each a model and an effort. The provider @discover runs on first. A provider whose CLI cannot run
// says so under its heading; its levels can still be set. Each pick is saved as it is made, and the next run starts there,
// in any window, with no restart. No line under the levels (2026-10-13: "Get rid of all this subtext").
//
// The data is what the Bart package's settingsModels gives (src/main/bart/settings.cjs):
//   { models, choices, usable, offered, cli, fileError }
// read as JSON here, so this page needs nothing from the Bart package but a source.

/// Where the Models page reads and saves (the app adapts the Bart package's model settings to it).
public protocol ModelSettingsSource: AnyObject {
    func load() async throws -> JSONValue
    /// Saves a patch (`patchOf`) and returns the settings as they are now.
    func save(_ patch: JSONValue) async throws -> JSONValue
    /// Calls `changed` when another window saved; returns a function that stops listening.
    func observe(_ changed: @escaping () -> Void) -> () -> Void
}

/// model/intelligence.js, the parts the Models page uses, on the JSON settings.
public enum Intelligence {
    /// question.cjs EFFORT_LABELS.
    public static let effortLabels = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"]
    /// in-force.cjs TOOL_OF: the CLI each provider runs on.
    public static let toolOf = ["anthropic": "claude", "openai": "codex"]

    /// The providers shown, in the file's order: the ones config.json offers.
    public static func shownProviders(_ settings: JSONValue) -> [String] {
        let offered = (settings["offered"]?.array ?? []).compactMap(\.string)
        return providerOrder(settings["models"]).filter { offered.contains($0) }
    }

    /// Keys of `models.providers` in file order. JSONValue objects are unordered, so the order comes from
    /// `models.providerOrder` when the source gives it, else anthropic, openai, then the rest sorted.
    public static func providerOrder(_ models: JSONValue?) -> [String] {
        if let order = models?["providerOrder"]?.array?.compactMap(\.string), !order.isEmpty { return order }
        let keys = Array((models?["providers"]?.object ?? [:]).keys)
        let known = ["anthropic", "openai"].filter { keys.contains($0) }
        return known + keys.filter { !known.contains($0) }.sorted()
    }

    /// in-force.cjs onlyProviders → preferUsable, the default provider of @bart (`which` "bart") or Build ("build") as a run
    /// sees it: one config.json does not offer gives way to the first it does, one whose CLI cannot run to one whose can.
    public static func defaultProvider(_ settings: JSONValue, _ which: String) -> String? {
        guard let models = settings["models"] else { return nil }
        let offered = (settings["offered"]?.array ?? []).compactMap(\.string)
        var keys = providerOrder(models)
        let kept = keys.filter { offered.contains($0) }
        var provider = models["provider"]?.string
        var build = models["build"]?["provider"]?.string
        if !kept.isEmpty {
            keys = kept
            if let p = provider, !kept.contains(p) { provider = kept.first }
            if let b = build, !kept.contains(b) { build = kept.first }
        }
        if let usable = settings["usable"]?.array?.compactMap(\.string) {
            let can = { (p: String) in usable.contains(toolOf[p] ?? "") }
            let moved = { (p: String?) -> String? in
                guard let p else { return nil }
                return can(p) ? p : keys.first(where: can) ?? p
            }
            provider = moved(provider)
            build = moved(build)
        }
        return which == "build" ? build : provider
    }

    /// `agent`'s default on `provider` → { model, effort }; `level` is @discover's ("standard" unless named).
    public static func defaultStep(_ models: JSONValue, agent: String, provider: String, level: String = "standard") -> (model: String, effort: String)? {
        let step: JSONValue?
        switch agent {
        case "bart": step = models["providers"]?[provider]?["ladder"]?[0]
        case "brainstorm": step = models["brainstorm"]?["providers"]?[provider]
        case "discover": step = models["discover"]?["providers"]?[provider]?[level]
        default: step = models["build"]?["providers"]?[provider]?["default"]
        }
        guard let model = step?["model"]?.string, let effort = step?["effort"]?.string else { return nil }
        return (model, effort)
    }

    /// What a pick in a cell saves.
    public static func patchOf(agent: String, provider: String, model: String, effort: String, level: String = "standard") -> JSONValue {
        let step: JSONValue = ["model": .string(model), "effort": .string(effort)]
        if agent == "discover" { return ["discover": .object([provider: .object([level: step])])] }
        return .object([agent: .object([provider: step])])
    }

    /// The groups the Models page shows: the provider @discover runs on first, then the rest in order.
    public static func modelsGroups(_ settings: JSONValue) -> [String] {
        let home = defaultProvider(settings, "bart")
        let shown = shownProviders(settings)
        return shown.filter { $0 == home } + shown.filter { $0 != home }
    }
}

/// The Models page.
public struct ModelsPage: View {
    let source: ModelSettingsSource?
    @State private var settings: JSONValue?
    @State private var error = ""
    @State private var stop: (() -> Void)?

    public init(source: ModelSettingsSource?, initial: JSONValue? = nil) {
        self.source = source
        _settings = State(initialValue: initial)
    }

    public var body: some View {
        Group {
            if let settings {
                content(settings)
            } else {
                Text(error.isEmpty ? "Loading…" : error)
                    .textStyle(TextStyle(13, lineHeight: 1.4))
                    .foregroundStyle(Color(error.isEmpty ? Palette.fnt : Palette.del))
                    .padding(.vertical, 8)
            }
        }
        .task { await load() }
        .onAppear { stop = source?.observe { Task { @MainActor in await load() } } }
        .onDisappear { stop?(); stop = nil }
    }

    @MainActor private func load() async {
        guard let source else { if settings == nil { error = "Models are not available yet" }; return }
        do { settings = try await source.load(); error = "" } catch { self.error = error.localizedDescription }
    }

    @MainActor private func save(_ patch: JSONValue) {
        guard let source else { return }
        Task { @MainActor in
            do { settings = try await source.save(patch); error = "" } catch { self.error = error.localizedDescription }
        }
    }

    @ViewBuilder private func content(_ settings: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let fileError = settings["fileError"]?.string, !fileError.isEmpty {
                Text(fileError)
                    .textStyle(TextStyle(12.5, lineHeight: 1.4))
                    .foregroundStyle(Color(Palette.del))
                    .padding(.vertical, 8).padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(Palette.gray50)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(Palette.bd), lineWidth: 1))
                    .padding(.top, 16)
                    .accessibilityAddTraits(.isStaticText)
                    .driveID("models-file-error")
            }
            ForEach(Intelligence.modelsGroups(settings), id: \.self) { provider in
                group(settings, provider)
            }
            if !error.isEmpty {
                Text(error).textStyle(TextStyle(12.5, lineHeight: 1.4)).foregroundStyle(Color(Palette.del)).padding(.top, 10)
            }
        }
        .accessibilityElement(children: .contain)
        .driveID("intelligence-levels")
    }

    @ViewBuilder private func group(_ settings: JSONValue, _ provider: String) -> some View {
        let models = settings["models"] ?? .null
        let entry = models["providers"]?[provider] ?? .null
        let name = entry["name"]?.string ?? provider
        let modelKeys = orderedKeys(entry["models"], order: entry["modelOrder"])
        let modelOptions = modelKeys.map { SettingsChoice.Option(value: $0, label: entry["models"]?[$0]?["name"]?.string ?? $0) }
        let efforts = (entry["efforts"]?.array ?? []).compactMap(\.string).map { SettingsChoice.Option(value: $0, label: Intelligence.effortLabels[$0] ?? $0) }
        let note = settings["cli"]?[provider]?.string
        SettingsGroup(name, note: {
            if let note { Text(note).textStyle(TextStyle(12.5, lineHeight: 1.4)).foregroundStyle(Color(Palette.fnt)) }
        }) {
            ForEach(DiscoverLevels.all, id: \.id) { level in
                let step = Intelligence.defaultStep(models, agent: "discover", provider: provider, level: level.id)
                SettingsRow(level.name) {
                    HStack(spacing: 10) {
                        SettingsChoice("\(name) \(level.name) model", value: step?.model ?? "", options: modelOptions, width: 96) { model in
                            save(Intelligence.patchOf(agent: "discover", provider: provider, model: model, effort: step?.effort ?? "", level: level.id))
                        }
                        SettingsChoice("\(name) \(level.name) effort", value: step?.effort ?? "", options: efforts, width: 110) { effort in
                            save(Intelligence.patchOf(agent: "discover", provider: provider, model: step?.model ?? "", effort: effort, level: level.id))
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .driveID("level=\(provider):\(level.id)")
            }
        }
        .driveID("levels-provider=\(provider)")
    }

    /// The models in their file order when the source gives it (`modelOrder`), else by name.
    private func orderedKeys(_ object: JSONValue?, order: JSONValue?) -> [String] {
        if let list = order?.array?.compactMap(\.string), !list.isEmpty { return list }
        return (object?.object ?? [:]).keys.sorted()
    }
}
