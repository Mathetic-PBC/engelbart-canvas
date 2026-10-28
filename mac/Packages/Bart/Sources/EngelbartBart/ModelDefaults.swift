import Foundation

// models.cjs — the defaults of <home>/model-effort-inline-question.json and every earlier shipped version of them
// (PAST_DEFAULT_MODELS), as ordered JSON: the file is written in this order, and the order of `models` is their rank.

public enum ModelDefaults {
    public static let modelsFile = "model-effort-inline-question.json"

    // Build (2026-09-25; B3): the models a Build can run on, per provider, and the one its dialog starts on.
    public static let build: OJ = [
        "about": "Models and efforts for Build, the coding agent a workspace hands its document to, and for a sticky's quick task. The Build dialog starts on the model and effort last picked in it (a sticky's on its own last pick; model-choices.json), else on `provider`'s `default`, and lists these models and efforts to pick from. When `provider`'s CLI cannot run (not installed or not signed in), it starts on the other provider's `default`.",
        "provider": "anthropic",
        "providers": [
            "openai": [
                "models": [
                    "luna": ["id": "gpt-6-luna", "name": "Luna", "use": "Fastest. Small, clear changes."],
                    "sol": ["id": "gpt-6.1-sol", "name": "Sol", "use": "The default. Most Builds."],
                    "astra": ["id": "gpt-6-astra", "name": "Astra", "use": "Deepest. Hard changes across many files; slow."],
                ],
                "efforts": ["medium", "high", "xhigh", "ultra"],
                "default": ["model": "sol", "effort": "high"],
            ],
            "anthropic": [
                "models": [
                    "sonnet": ["id": "claude-sonnet-5-5", "name": "Sonnet", "use": "Fast. Small, clear changes."],
                    "opus": ["id": "opus", "name": "Opus", "use": "The default. Most Builds."],
                    "fable": ["id": "fable", "name": "Fable", "use": "Deepest. Hard changes across many files; slow."],
                ],
                "efforts": ["medium", "high", "xhigh", "max"],
                "default": ["model": "opus", "effort": "high"],
            ],
        ],
    ]

    public static let bartAbout = "Models and efforts for @bart, the inline question agent. This file applies to every project and is read again for each question. A question starts where the last one picked by hand did (model-choices.json), else on the first step of the default provider's ladder, or on the other provider's when the default one's CLI cannot run (not installed or not signed in). The agent may move up a step when the question needs more than it was given, and it keeps what it has read. `@bart --opus --high …` picks a model and an effort by hand and turns that off. Luna and Haiku: the fastest, for routing, naming and short lookups. Sonnet: lookups, definitions, rewording. Sol and Opus: questions that need several files read or careful reasoning. Astra and Fable: the hardest questions, where a slow answer is acceptable. Low effort answers fastest; medium answers in seconds; high and xhigh think longer before answering; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them."

    public static let bart: OJ = [
        "about": .string(bartAbout),
        "provider": "anthropic",
        "providers": [
            "openai": [
                "name": "Codex",
                "models": [
                    "luna": ["id": "gpt-6-luna", "name": "Luna", "use": "Fastest. Lookups, definitions, rewording."],
                    "sol": ["id": "gpt-6.1-sol", "name": "Sol", "use": "The default. Most questions about the project."],
                    "astra": ["id": "gpt-6-astra", "name": "Astra", "use": "Deepest. Hard reasoning across many files; slow."],
                ],
                "efforts": ["low", "medium", "high", "xhigh", "ultra"],
                "ladder": [["model": "sol", "effort": "medium"], ["model": "sol", "effort": "high"], ["model": "astra", "effort": "xhigh"]],
            ],
            "anthropic": [
                "name": "Claude Code",
                // Opus and Fable are aliases, not versions; Sonnet and Haiku are named by version (2026-09-29, 2026-10-12),
                // since an older Claude Code resolves the bare names to older models. Haiku is first, so it ranks lowest.
                "models": [
                    "haiku": ["id": "claude-haiku-5-5", "name": "Haiku", "use": "Fastest. Routing, naming, short lookups."],
                    "sonnet": ["id": "claude-sonnet-5-5", "name": "Sonnet", "use": "Fast. Lookups, definitions, rewording, most questions."],
                    "opus": ["id": "opus", "name": "Opus", "use": "Questions that need several files read or careful reasoning."],
                    "fable": ["id": "fable", "name": "Fable", "use": "Deepest. The hardest questions; slow."],
                ],
                "efforts": ["low", "medium", "high", "xhigh", "max"],
                "ladder": [["model": "sonnet", "effort": "high"], ["model": "opus", "effort": "high"], ["model": "fable", "effort": "xhigh"]],
            ],
        ],
    ]

    // @brainstorm (2026-09-30; fixed 2026-10-02; in the file again 2026-10-06, for Settings): one step per provider.
    public static let brainstorm: OJ = [
        "about": "The model and effort for @brainstorm, the agent that asks one card at a time to help find what to work on. One step per provider and no ladder: it runs on the provider an @bart question would start on, at that provider's step here. The models and efforts are the ones listed above for @bart. Flags on an @brainstorm line pick nothing; Settings (the gear, top right) changes these.",
        "providers": [
            "anthropic": ["model": "sonnet", "effort": "high"],
            "openai": ["model": "sol", "effort": "medium"],
        ],
    ]

    // @discover (2026-09-30; three levels 2026-10-02): per provider a step for each mode.
    public static let discover: OJ = [
        "about": "The models and efforts for @discover, the agent that finds what to read about a problem by following the citations of the papers in the library. Three levels per provider and no ladder: `quick` (`@discover --quick …`, a fast look: at most five sources), `standard` (a plain `@discover …`: at most eight) and `deep` (`@discover --deep …`, a second hop: at most fifteen). It runs on the provider an @bart question would start on, at that provider's level here, and an answer or a follow-up stays on the level its exchange was asked at. The models are the ones listed above for @bart. `@discover --sonnet …` or `--high` picks by hand for that line.",
        "providers": [
            "openai": ["quick": ["model": "sol", "effort": "medium"], "standard": ["model": "astra", "effort": "high"], "deep": ["model": "astra", "effort": "ultra"]],
            "anthropic": ["quick": ["model": "sonnet", "effort": "medium"], "standard": ["model": "opus", "effort": "high"], "deep": ["model": "opus", "effort": "max"]],
        ],
    ]

    /// `{ ...BART_DEFAULTS, build, brainstorm, discover }`.
    public static let models: OJ = bart.setting("build", build).setting("brainstorm", brainstorm).setting("discover", discover)

    /// `defaults` with some models' ids replaced: [provider: [key: id]].
    static func withIds(_ defaults: OJ, _ ids: [(String, [(String, String)])]) -> OJ {
        var providers = defaults["providers"]!
        for (provider, changes) in ids {
            var entry = providers[provider]!
            var models = entry["models"]!
            for (key, id) in changes { models = models.setting(key, models[key]!.setting("id", .string(id))) }
            entry = entry.setting("models", models)
            providers = providers.setting(provider, entry)
        }
        return defaults.setting("providers", providers)
    }

    static func at(_ v: OJ, _ path: [String], _ f: (OJ) -> OJ) -> OJ {
        guard let k = path.first else { return f(v) }
        return v.setting(k, at(v[k] ?? .object([]), Array(path.dropFirst()), f))
    }

    // @bart as it shipped from 2026-09-29 until 2026-10-12: no Haiku, and no low effort for either provider.
    static let bart1006: OJ = {
        var v = bart.setting("about", .string(bartAbout
            .replacingOccurrences(of: "Luna and Haiku: the fastest, for routing, naming and short lookups. Sonnet: lookups, definitions, rewording.", with: "Luna and Sonnet: lookups, definitions, rewording.")
            .replacingOccurrences(of: "Low effort answers fastest; medium answers in seconds;", with: "Medium effort answers in seconds;")))
        v = at(v, ["providers", "openai"]) { $0.setting("efforts", ["medium", "high", "xhigh", "ultra"]) }
        v = at(v, ["providers", "anthropic"]) { $0.setting("models", $0["models"]!.removing("haiku")).setting("efforts", ["medium", "high", "xhigh", "max"]) }
        return v
    }()

    static let build0925: OJ = withIds([
        "about": "Models and efforts for Build, the coding agent a workspace hands its document to, and for a sticky's quick task. The Build dialog starts on the default provider's `default` and lists these models and efforts to pick from.",
        "providers": build["providers"]!,
    ], [("openai", [("sol", "gpt-6-sol")]), ("anthropic", [("sonnet", "sonnet")])])

    static let bart0927: OJ = {
        var shipped = withIds(bart1006, [("openai", [("sol", "gpt-6-sol")]), ("anthropic", [("sonnet", "sonnet")])])
        shipped = shipped.setting("about", "Models and efforts for @bart, the inline question agent. This file applies to every project and is read again for each question. A question starts on the first step of the default provider's ladder; the agent may move up a step when the question needs more than it was given, and it keeps what it has read. `@bart --opus --high …` picks a model and an effort by hand and turns that off. Luna and Sonnet: lookups, definitions, rewording. Sol and Opus: questions that need several files read or careful reasoning. Astra and Fable: the hardest questions, where a slow answer is acceptable. Medium effort answers in seconds; high and xhigh think longer before answering; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.")
        shipped = shipped.setting("provider", "openai")
        return at(shipped, ["providers", "anthropic"]) { $0.setting("ladder", [["model": "sonnet", "effort": "medium"], ["model": "opus", "effort": "high"], ["model": "fable", "effort": "xhigh"]]) }
    }()

    // Keep the shipped 5.6 defaults as migration bases, so untouched model IDs move to 6.
    static let previousBart: OJ = withIds(bart0927, [("openai", [("luna", "gpt-5.6-luna"), ("sol", "gpt-5.6-sol")])])

    static let brainstorm0930: OJ = [
        "about": "The model and effort for @brainstorm, the agent that asks one card at a time to help find what to work on. One step per provider and no ladder: it runs on the provider an @bart question would start on, at that provider's step here. The models are the ones listed above for @bart. `@brainstorm --opus …` picks by hand for that line.",
        "providers": ["openai": ["model": "sol", "effort": "medium"], "anthropic": ["model": "sonnet", "effort": "high"]],
    ]
    static let discover0930: OJ = [
        "about": "The model and effort for @discover, the agent that finds what to read about a problem by following the citations of the papers in the library. One step per provider and no ladder: it runs on the provider an @bart question would start on, at that provider's step here. The models are the ones listed above for @bart. `@discover --sonnet …` picks by hand for that line; `--deep` traces further.",
        "providers": ["openai": ["model": "sol", "effort": "high"], "anthropic": ["model": "opus", "effort": "high"]],
    ]

    /// Every earlier DEFAULT_MODELS, oldest first.
    public static let past: [OJ] = {
        // 2026-09-20 (9b50bad): no ultra or max yet, and the last sentence of `about` ended at xhigh.
        var first = previousBart.setting("about", .string(previousBart["about"]!.string!.replacingOccurrences(of: "; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.", with: ".")))
        first = at(first, ["providers", "openai"]) { $0.setting("efforts", ["medium", "high", "xhigh"]) }
        first = at(first, ["providers", "anthropic"]) { $0.setting("efforts", ["medium", "high", "xhigh"]) }
        return [
            first,
            // 2026-09-21 to 2026-09-25: @bart alone, before Build had models of its own.
            previousBart,
            // 2026-09-25 to 2026-09-27: Build had its own GPT-6 models; @bart still used 5.6.
            previousBart.setting("build", build0925),
            // 2026-09-27 to 2026-09-29: both on GPT-6, @bart on Codex first.
            bart0927.setting("build", build0925),
            // 2026-09-29 to 2026-09-30: GPT-6.1 Sol, Sonnet 5.5, Claude Code first, Build on a provider of its own.
            bart1006.setting("build", build),
            // 2026-09-30 to 2026-10-02: @brainstorm and @discover, one step each, both in the file.
            bart1006.setting("build", build).setting("brainstorm", brainstorm0930).setting("discover", discover0930),
            // 2026-10-02 to 2026-10-06: @discover's three levels; @brainstorm's step fixed in the code, not in the file.
            bart1006.setting("build", build).setting("discover", discover),
            // 2026-10-06 to 2026-10-12: @brainstorm back in the file, for Settings; @bart without Haiku or low effort.
            bart1006.setting("build", build).setting("brainstorm", brainstorm).setting("discover", discover),
        ]
    }()
}
