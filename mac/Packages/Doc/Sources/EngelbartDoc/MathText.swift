import Foundation

// Math, drawn natively (2026-10-12 in Electron: KaTeX). The Swift app has no KaTeX: LaTeX is turned into Unicode math
// text (Greek, operators, super- and subscripts, fractions as a⁄b, roots as √, accents as combining marks, \mathbb as
// double-struck letters) and the editor draws it in a math face. What KaTeX could not draw (an unknown command, an
// unbalanced brace) is `nil` here too, and the source then shows as typed in the inline-code look, as doc.js does. The
// result is the token's `shown` text: one unit, the caret before or after it, never inside (tokShown).

public enum MathText {
    private static let lock = NSLock()
    private static var cache: [String: String?] = [:]
    private static var order: [String] = []

    /// LaTeX → the text drawn for it, or nil when it cannot be drawn. Cached (500 entries, as MATH_CACHE).
    public static func render(_ tex: String, display: Bool) -> String? {
        let key = (display ? "D" : "I") + tex
        lock.lock()
        if let hit = cache[key] { lock.unlock(); return hit }
        lock.unlock()
        var p = Parser(Array(tex))
        let out = p.parseAll()
        let result = out.flatMap { $0.trimmed.isEmpty && !tex.trimmed.isEmpty ? nil : $0 }
        lock.lock()
        if cache.count >= 500, let first = order.first { cache[first] = nil; order.removeFirst() }
        cache[key] = .some(result); order.append(key)
        lock.unlock()
        return result
    }

    static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ϵ", "varepsilon": "ε", "zeta": "ζ", "eta": "η",
        "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π",
        "varpi": "ϖ", "rho": "ρ", "varrho": "ϱ", "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "ϕ",
        "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ",
        "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "sum": "∑", "prod": "∏", "coprod": "∐", "int": "∫", "iint": "∬", "iiint": "∭", "oint": "∮", "infty": "∞",
        "partial": "∂", "nabla": "∇", "pm": "±", "mp": "∓", "times": "×", "div": "÷", "cdot": "·", "cdots": "⋯",
        "ldots": "…", "dots": "…", "vdots": "⋮", "ddots": "⋱", "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠",
        "ne": "≠", "approx": "≈", "sim": "∼", "simeq": "≃", "cong": "≅", "equiv": "≡", "propto": "∝", "ll": "≪", "gg": "≫",
        "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆", "supset": "⊃", "supseteq": "⊇", "cup": "∪",
        "cap": "∩", "setminus": "∖", "emptyset": "∅", "varnothing": "∅", "forall": "∀", "exists": "∃", "nexists": "∄",
        "neg": "¬", "lnot": "¬", "land": "∧", "wedge": "∧", "lor": "∨", "vee": "∨", "to": "→", "rightarrow": "→",
        "leftarrow": "←", "gets": "←", "Rightarrow": "⇒", "Leftarrow": "⇐", "implies": "⟹", "iff": "⟺",
        "leftrightarrow": "↔", "Leftrightarrow": "⇔", "mapsto": "↦", "uparrow": "↑", "downarrow": "↓",
        "longrightarrow": "⟶", "longleftarrow": "⟵", "langle": "⟨", "rangle": "⟩", "lceil": "⌈", "rceil": "⌉",
        "lfloor": "⌊", "rfloor": "⌋", "circ": "∘", "bullet": "•", "star": "⋆", "ast": "∗", "prime": "′", "hbar": "ℏ",
        "ell": "ℓ", "Re": "ℜ", "Im": "ℑ", "aleph": "ℵ", "degree": "°", "angle": "∠", "perp": "⊥", "parallel": "∥",
        "mid": "∣", "vert": "|", "lvert": "|", "rvert": "|", "Vert": "‖", "lVert": "‖", "rVert": "‖", "oplus": "⊕",
        "otimes": "⊗", "odot": "⊙", "top": "⊤", "bot": "⊥", "vdash": "⊢", "models": "⊨", "therefore": "∴",
        "because": "∵", "triangle": "△", "square": "□", "checkmark": "✓", "dagger": "†", "S": "§", "P": "¶",
        "lbrace": "{", "rbrace": "}", "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", "_": "_", "|": "‖",
        ",": "\u{2009}", ";": "\u{2005}", ":": "\u{2005}", "!": "", " ": " ", "quad": "\u{2003}", "qquad": "\u{2003}\u{2003}",
        "colon": ":", "cdotp": "·", "smallsetminus": "∖", "intercal": "⊺", "dagger*": "‡", "ddagger": "‡", "wp": "℘",
        "mho": "℧", "complement": "∁", "imath": "ı", "jmath": "ȷ", "flat": "♭", "sharp": "♯", "natural": "♮",
    ]
    static let functions: Set<String> = ["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
        "log", "ln", "lg", "exp", "lim", "liminf", "limsup", "max", "min", "sup", "inf", "det", "arg", "deg", "dim", "gcd",
        "hom", "ker", "Pr", "mod", "bmod", "argmax", "argmin", "tr", "Var", "Cov", "E"]
    static let accents: [String: String] = ["bar": "\u{0304}", "hat": "\u{0302}", "widehat": "\u{0302}", "vec": "\u{20D7}", "dot": "\u{0307}",
        "ddot": "\u{0308}", "tilde": "\u{0303}", "widetilde": "\u{0303}", "acute": "\u{0301}", "grave": "\u{0300}", "breve": "\u{0306}",
        "check": "\u{030C}", "overline": "\u{0305}", "underline": "\u{0332}"]
    static let ignored: Set<String> = ["left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "displaystyle",
        "textstyle", "scriptstyle", "limits", "nolimits", "middle"]
    static let upright: Set<String> = ["text", "textrm", "mathrm", "operatorname", "textnormal", "textit", "textbf", "mathit", "mathbf",
        "boldsymbol", "bm", "mathsf", "mathtt", "texttt", "emph", "mbox", "hbox", "mathbfit"]

    static let superscripts: [Character: Character] = ["0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷",
        "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ", "a": "ᵃ", "b": "ᵇ",
        "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ", "h": "ʰ", "j": "ʲ", "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "o": "ᵒ", "p": "ᵖ",
        "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ", "v": "ᵛ", "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ", "T": "ᵀ", "′": "′", "*": "*",
        "A": "ᴬ", "B": "ᴮ", "D": "ᴰ", "E": "ᴱ", "G": "ᴳ", "H": "ᴴ", "I": "ᴵ", "J": "ᴶ", "K": "ᴷ", "L": "ᴸ", "M": "ᴹ", "N": "ᴺ",
        "O": "ᴼ", "P": "ᴾ", "R": "ᴿ", "U": "ᵁ", "V": "ⱽ", "W": "ᵂ", "β": "ᵝ", "γ": "ᵞ", "δ": "ᵟ", "θ": "ᶿ", "φ": "ᵠ", "χ": "ᵡ", " ": " "]
    static let subscripts: [Character: Character] = ["0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇",
        "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ",
        "j": "ⱼ", "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ", "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ", "v": "ᵥ",
        "x": "ₓ", "β": "ᵦ", "γ": "ᵧ", "ρ": "ᵨ", "φ": "ᵩ", "χ": "ᵪ", " ": " "]
    static let blackboard: [Character: String] = ["R": "ℝ", "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "C": "ℂ", "P": "ℙ", "H": "ℍ", "E": "𝔼", "1": "𝟙"]

    struct Parser {
        let cs: [Character]
        var i = 0
        init(_ cs: [Character]) { self.cs = cs }

        mutating func parseAll() -> String? {
            guard let out = parseUntil(nil) else { return nil }
            return i == cs.count ? out : nil
        }

        /// Reads atoms until `stop` (a closing brace) or the end.
        mutating func parseUntil(_ stop: Character?) -> String? {
            var out = ""
            while i < cs.count {
                let c = cs[i]
                if let stop, c == stop { return out }
                if c == "}" { return nil }
                if c == "^" || c == "_" {
                    i += 1
                    guard let arg = argument() else { return nil }
                    out += script(arg, sup: c == "^")
                    continue
                }
                guard let atom = atom() else { return nil }
                out += atom
            }
            return stop == nil ? out : nil
        }

        mutating func script(_ s: String, sup: Bool) -> String {
            let table = sup ? MathText.superscripts : MathText.subscripts
            let mapped = s.compactMap { table[$0] }
            if mapped.count == s.count && !s.isEmpty { return String(mapped) }
            return (sup ? "^" : "_") + (s.count == 1 ? s : "(\(s))")
        }

        /// One atom: a group, a command, or a character.
        mutating func atom() -> String? {
            let c = cs[i]
            if c == "{" {
                i += 1
                guard let inner = parseUntil("}") else { return nil }
                i += 1
                return inner
            }
            if c == "\\" { return command() }
            i += 1
            if c == "~" { return "\u{00A0}" }
            if c == "'" { return "′" }
            if c == "-" { return "−" }
            if c == "*" { return "∗" }
            if c == "&" { return "  " }
            return String(c)
        }

        /// A command's argument or a script's operand: a group or one atom.
        mutating func argument() -> String? {
            while i < cs.count && cs[i] == " " { i += 1 }
            guard i < cs.count else { return nil }
            if cs[i] == "}" { return nil }
            return atom()
        }

        mutating func rawGroup() -> String? {
            while i < cs.count && cs[i] == " " { i += 1 }
            guard i < cs.count, cs[i] == "{" else { return nil }
            var depth = 0, s = ""
            while i < cs.count {
                let c = cs[i]; i += 1
                if c == "{" { depth += 1; if depth == 1 { continue } }
                if c == "}" { depth -= 1; if depth == 0 { return s } }
                s.append(c)
            }
            return nil
        }

        mutating func command() -> String? {
            i += 1
            guard i < cs.count else { return nil }
            var name = ""
            if cs[i].isLetter {
                while i < cs.count && cs[i].isLetter { name.append(cs[i]); i += 1 }
            } else {
                name = String(cs[i]); i += 1
                if name == "\\" { return "; " } // a row break
            }
            if let s = MathText.symbols[name] { return s }
            if MathText.functions.contains(name) { return name }
            if MathText.ignored.contains(name) {
                // \left( and \right): the delimiter that follows is kept, a `.` dropped.
                if (name == "left" || name == "right" || name == "middle"), i < cs.count {
                    if cs[i] == "." { i += 1; return "" }
                }
                return ""
            }
            if MathText.upright.contains(name) {
                if name == "text" || name == "textrm" || name == "mbox" || name == "hbox" || name == "textnormal" || name == "texttt" || name == "textit" || name == "textbf" || name == "emph" {
                    return rawGroup()
                }
                return argument()
            }
            if let mark = MathText.accents[name] {
                guard let arg = argument() else { return nil }
                if name == "overline" || name == "underline" { return arg.map { String($0) + mark }.joined() }
                return arg + mark
            }
            switch name {
            case "frac", "tfrac", "dfrac", "cfrac":
                guard let a = argument(), let b = argument() else { return nil }
                return Parser.fraction(a, b)
            case "binom", "tbinom", "dbinom":
                guard let a = argument(), let b = argument() else { return nil }
                return "(\(a) \(b))"
            case "sqrt":
                var index = ""
                if i < cs.count && cs[i] == "[" {
                    i += 1
                    var s = ""
                    while i < cs.count && cs[i] != "]" { s.append(cs[i]); i += 1 }
                    guard i < cs.count else { return nil }
                    i += 1
                    index = s
                }
                guard let a = argument() else { return nil }
                let root = index == "3" ? "∛" : index == "4" ? "∜" : (index.isEmpty ? "" : script(index, sup: true)) + "√"
                return root + (a.count <= 1 ? a : "(\(a))")
            case "mathbb", "Bbb":
                guard let a = argument() else { return nil }
                return a.map { MathText.blackboard[$0] ?? String($0) }.joined()
            case "mathcal", "mathscr", "mathfrak":
                guard let a = argument() else { return nil }
                return a
            case "not":
                guard let a = argument() else { return nil }
                return a + "\u{0338}"
            case "begin":
                guard let env = rawGroup() else { return nil }
                if env == "array", i < cs.count, cs[i] == "{" { _ = rawGroup() }
                var body = ""
                // Up to the matching \end{env}.
                let end = "\\end{\(env)}"
                let rest = String(cs[i...])
                guard let r = rest.range(of: end) else { return nil }
                body = String(rest[rest.startIndex..<r.lowerBound])
                i += rest.distance(from: rest.startIndex, to: r.upperBound)
                var sub = Parser(Array(body))
                guard let inner = sub.parseAll() else { return nil }
                let rows = inner.components(separatedBy: "; ").map { $0.trimmed }.filter { !$0.isEmpty }.joined(separator: "; ")
                switch env {
                case "pmatrix": return "(\(rows))"
                case "bmatrix": return "[\(rows)]"
                case "vmatrix": return "|\(rows)|"
                case "Bmatrix", "cases": return "{\(rows)"
                default: return rows
                }
            case "end": return nil
            case "operatorname*": return argument()
            default: return nil // KaTeX would draw it as an error
            }
        }

        static func fraction(_ a: String, _ b: String) -> String {
            let simple = { (s: String) in s.count <= 1 || s.allSatisfy { $0.isNumber } || s.allSatisfy { $0.isLetter } }
            return (simple(a) ? a : "(\(a))") + "⁄" + (simple(b) ? b : "(\(b))")
        }
    }
}
