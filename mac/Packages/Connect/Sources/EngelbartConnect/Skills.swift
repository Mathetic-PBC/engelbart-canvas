import Foundation

// Port of src/main/connect/skills.cjs (Connect your library, 2026-10-07, second build): how an agent brings each app's
// things in, written down once so it need not search the web every time. The texts are Texts.skills (generated from the
// Electron source). <dataRoot>/.context/connect-skills/<App>.md replaces an app's skill.
public enum Skills {
    static let skillRE = #"^[\w .-]{1,40}$"#

    /// An app's skill: the person's own `<dataRoot>/.context/connect-skills/<App>.md` when it holds any, else the built-in one.
    public static func skillOf(_ app: String, dataRoot: URL? = nil) -> String {
        if let dataRoot, JS.test(app, skillRE) {
            let file = dataRoot.appendingPathComponent(".context/connect-skills/\(app).md")
            if let own = try? String(contentsOf: file, encoding: .utf8) {
                let trimmed = own.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return Texts.skills[app] ?? ""
    }

    /// The skills block of a job's first message: one per app it covers (Websites for the sites source), or ''.
    public static func skillsFor(source: String, apps: [String], dataRoot: URL? = nil) -> String {
        let names = source == "sites" ? ["Websites"] : source == "code" ? ["GitHub"] : apps
        var unique: [String] = []
        for name in names where !unique.contains(name) { unique.append(name) }
        let parts = unique.map { skillOf($0, dataRoot: dataRoot) }.filter { !$0.isEmpty }
        if parts.isEmpty { return "" }
        return "<skills note=\"How to reach each app, written down beforehand. If what you see does not match, look the app's help pages up with WebSearch and WebFetch, do what they say, and say in your reply what changed.\">\n\(parts.joined(separator: "\n\n"))\n</skills>"
    }
}
