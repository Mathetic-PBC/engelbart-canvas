import Foundation

// settings.cjs — Settings › Intelligence (2026-10-06, MATH-53): the default model and effort of each agent on each
// provider, and the default provider of @bart (which @brainstorm and @discover follow) and of Build. No file of its own:
// the defaults are the models file's, so a save writes what an edit by hand would. Each agent's default is
//   @bart        providers.<p>.ladder[0], then the built-in ladder's steps above it (withFirstStep)
//   @brainstorm  brainstorm.providers.<p>
//   @discover    discover.providers.<p>.standard (quick and deep under the panel's Advanced)
//   Build        build.providers.<p>.default, which a post-it's quick task starts on too
// The last action wins: setting @bart's default provider forgets @bart's last pick by hand, and setting its default on a
// provider forgets that pick when it is on that provider; Build's do the same to Build's pick and the quick task's.

/// What the tool check knows, for which CLIs can run (tools/manager.cjs usableAgents + snapshot).
public protocol BartToolStatus: AnyObject, Sendable {
    /// The CLIs that can run now (['claude', 'codex'] or fewer), nil before the first check.
    func usableAgents() -> [String]?
    /// A tool's record: installed, and status ('signed-out', 'outdated', 'incompatible', …).
    func record(_ tool: String) -> (installed: Bool, status: String?)
}

public struct SettingsModels: Sendable {
    public var models: ModelsList
    public var choices: [String: Choice]
    public var usable: [String]?
    public var offered: [String]
    /// Why each provider's CLI cannot run ('not installed', 'signed out', 'out of date', 'cannot run'), nil when it can.
    public var cli: [String: String?]
    public var fileError: String?

    public var json: OJ {
        var choicesJSON: [(String, OJ)] = []
        for place in Choices.places { if let c = choices[place] { choicesJSON.append((place, ["provider": .string(c.provider), "model": .string(c.model), "effort": .string(c.effort)])) } }
        return [
            "models": models.json,
            "choices": .object(choicesJSON),
            "usable": usable.map { .array($0.map { .string($0) }) } ?? .null,
            "offered": .array(offered.map { .string($0) }),
            "cli": .object(models.providers.keys.map { k in (k, (cli[k] ?? nil).map { .string($0) } ?? .null) }),
            "fileError": fileError.map { .string($0) } ?? .null,
        ]
    }
}

public struct SettingsError: Error, LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }
    init(_ m: String) { message = m }
}

public enum ModelSettings {
    /// What a save may name.
    public static let patchKeys = ["provider", "buildProvider", "bart", "brainstorm", "discover", "build"]

    /// The list a run starts on: the models file, cut to the providers config.json offers (`only`), starting where
    /// `place` ('bart', 'build' or 'quick') was last picked by hand, else on its default, on a provider whose CLI can run
    /// (`usable`). Read again for every run.
    public static func modelsInForce(home: URL, place: String = "bart", only: [String]? = nil, usable: [String]? = nil) -> ModelsList {
        InForce.preferUsable(InForce.startingAt(Models.load(home: home, only: only), place, Choices.read(home: home)[place]), usable)
    }

    public static func cliNotes(_ providers: Ordered<ProviderEntry>, _ tools: BartToolStatus?) -> [String: String?] {
        let usable = tools?.usableAgents()
        var out: [String: String?] = [:]
        for provider in providers.keys {
            let name = Models.toolOf[provider] ?? provider
            guard let usable, !usable.contains(name), let tools else { out[provider] = .some(nil); continue }
            let record = tools.record(name)
            out[provider] = !record.installed ? "not installed"
                : record.status == "signed-out" ? "signed out"
                : record.status == "outdated" || record.status == "incompatible" ? "out of date" : "cannot run"
        }
        return out
    }

    enum FileRead: Error { case notJSON, unreadable(String) }

    /// The models file as it is on disk; a file that is not a JSON object is refused, never written over.
    static func readFile(_ url: URL) throws -> OJ {
        if !FileManager.default.fileExists(atPath: url.path) { return .object([]) }
        guard let data = FileManager.default.contents(atPath: url.path) else { throw FileRead.unreadable("EACCES") }
        guard let value = OJ.parse(data), value.isObject else { throw SettingsError("\(ModelDefaults.modelsFile) is not valid JSON. Fix it or delete it, then save again.") }
        return value
    }

    /// Why the models file cannot be read, or nil when it can (or is not there).
    public static func fileError(home: URL) -> String? {
        do { _ = try readFile(home.appendingPathComponent(ModelDefaults.modelsFile)); return nil }
        catch {
            let why: String
            if let e = error as? SettingsError, e.message.contains("is not valid JSON") { why = "is not valid JSON" }
            else if case FileRead.unreadable(let code) = error { why = "cannot be read (\(code))" }
            else { why = "cannot be read (\(error.localizedDescription))" }
            return "\(ModelDefaults.modelsFile) \(why), so every agent runs on the built-in defaults shown here, and a pick here is not saved. Fix the file or delete it."
        }
    }

    /// What the panel shows.
    public static func read(home: URL, only: [String]? = nil, tools: BartToolStatus? = nil) -> SettingsModels {
        let models = Models.load(home: home)
        return SettingsModels(models: models, choices: Choices.read(home: home), usable: tools?.usableAgents(),
                              offered: InForce.onlyProviders(models, only).providers.keys, cli: cliNotes(models.providers, tools),
                              fileError: fileError(home: home))
    }

    static func providerOf(_ models: ModelsList, _ value: OJ?, _ what: String) throws -> String {
        guard let s = value?.string, models.providers[s] != nil else {
            throw SettingsError("\(what) must be one of \(models.providers.keys.joined(separator: ", "))")
        }
        return s
    }

    static func stepOf(models: Ordered<ModelInfo>, efforts: [String], _ value: OJ?, _ what: String) throws -> Rung {
        guard let value, value.isObject, let m = value["model"]?.string, models[m] != nil, let e = value["effort"]?.string, efforts.contains(e) else {
            throw SettingsError("\(what) must be one of its provider's models and efforts")
        }
        return Rung(model: m, effort: e)
    }

    static func eachProvider(_ models: ModelsList, _ value: OJ?, _ what: String) throws -> [(String, OJ)] {
        guard let value else { return [] }
        guard let pairs = value.pairs else { throw SettingsError("\(what) must name providers") }
        return try pairs.map { (try providerOf(models, .string($0.0), "\(what)'s provider"), $0.1) }
    }

    static func rungJSON(_ r: Rung) -> OJ { ["model": .string(r.model), "effort": .string(r.effort)] }

    /// Every value `patch` sets, checked against `current` before anything is written, and only those that differ.
    static func changesOf(_ current: ModelsList, _ patch: OJ) throws -> [([String], OJ)] {
        var changes: [([String], OJ)] = []
        func change(_ keys: [String], _ value: OJ, _ now: OJ) { if !jsonEqual(value, now) { changes.append((keys, value)) } }
        if let p = patch["provider"] { change(["provider"], .string(try providerOf(current, p, "provider")), .string(current.provider)) }
        if let p = patch["buildProvider"] { change(["build", "provider"], .string(try providerOf(current, p, "buildProvider")), .string(current.build!.provider)) }
        for (provider, value) in try eachProvider(current, patch["bart"], "@bart") {
            let entry = current.providers[provider]!
            let first = try stepOf(models: entry.models, efforts: entry.efforts, value, "@bart on \(provider)")
            change(["providers", provider, "ladder"], .array(Models.withFirstStep(provider, entry, first).map(rungJSON)), .array(entry.ladder.map(rungJSON)))
        }
        for (provider, value) in try eachProvider(current, patch["brainstorm"], "@brainstorm") {
            let entry = current.providers[provider]!
            let step = try stepOf(models: entry.models, efforts: entry.efforts, value, "@brainstorm on \(provider)")
            change(["brainstorm", "providers", provider], rungJSON(step), current.brainstorm!.providers[provider].map(rungJSON) ?? .null)
        }
        for (provider, levels) in try eachProvider(current, patch["discover"], "@discover") {
            guard let modes = levels.pairs else { throw SettingsError("@discover on \(provider) must name its levels") }
            for (mode, value) in modes {
                guard Question.modes.contains(mode) else { throw SettingsError("@discover's level must be one of \(Question.modes.joined(separator: ", "))") }
                let entry = current.providers[provider]!
                let step = try stepOf(models: entry.models, efforts: entry.efforts, value, "@discover \(mode) on \(provider)")
                change(["discover", "providers", provider, mode], rungJSON(step), current.discover!.providers[provider]?[mode].map(rungJSON) ?? .null)
            }
        }
        for (provider, value) in try eachProvider(current, patch["build"], "Build") {
            let entry = current.build!.providers[provider]!
            let step = try stepOf(models: entry.models, efforts: entry.efforts, value, "Build on \(provider)")
            change(["build", "providers", provider, "default"], rungJSON(step), rungJSON(entry.default))
        }
        return changes
    }

    /// `value` put at `keys` in `object`, making the objects on the way that are missing (or are not objects).
    static func setAt(_ object: OJ, _ keys: [String], _ value: OJ) -> OJ {
        guard let k = keys.first else { return value }
        if keys.count == 1 { return object.setting(k, value) }
        let inner = object[k].flatMap { $0.isObject ? $0 : nil } ?? .object([])
        return object.setting(k, setAt(inner, Array(keys.dropFirst()), value))
    }

    /// A save from the panel → what `read` gives after it. Every pick is checked first; then only the values that change are
    /// written into the file as it is on disk, so its `about`s and unknown keys stay. Then the last action wins over the
    /// picks it overrules.
    @discardableResult
    public static func save(home: URL, patch: OJ, only: [String]? = nil, tools: BartToolStatus? = nil) throws -> SettingsModels {
        guard let keys = patch.pairs?.map({ $0.0 }) else { throw SettingsError("settings must be an object") }
        if let unknown = keys.first(where: { !patchKeys.contains($0) }) { throw SettingsError("\(unknown) is not a setting") }
        let file = home.appendingPathComponent(ModelDefaults.modelsFile)
        _ = Models.load(home: home) // the file is there, and any default changed since is carried into it, before it is edited
        let held = try readFile(file)
        let changes = try changesOf(Models.normalize(held), patch)
        if !changes.isEmpty {
            var next = Models.fileShape(held)
            for (keys, value) in changes { next = setAt(next, keys, value) }
            try writeJSONFile(file, next)
        }
        let choices = Choices.read(home: home)
        func overruled(_ place: String, _ provider: OJ?, _ defaults: OJ?) -> Bool {
            provider != nil || (choices[place] != nil && defaults?.isObject == true && defaults?[choices[place]!.provider] != nil)
        }
        if overruled("bart", patch["provider"], patch["bart"]) { Choices.forget(home: home, place: "bart") }
        for place in ["build", "quick"] where overruled(place, patch["buildProvider"], patch["build"]) { Choices.forget(home: home, place: place) }
        return read(home: home, only: only, tools: tools)
    }

    /// "Use default": that place starts on its default again.
    public static func forget(home: URL, place: String, only: [String]? = nil, tools: BartToolStatus? = nil) throws -> SettingsModels {
        guard Choices.places.contains(place) else { throw SettingsError("place must be one of \(Choices.places.joined(separator: ", "))") }
        Choices.forget(home: home, place: place)
        return read(home: home, only: only, tools: tools)
    }
}
