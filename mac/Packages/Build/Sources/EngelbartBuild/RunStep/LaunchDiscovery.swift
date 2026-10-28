import Foundation
import EngelbartCore

/// The launch facts of a repository's folder on this Mac (sandbox/launch-discovery.cjs discoverLocal, 2026-09-29; the
/// Sandbox package owns the sandbox side): bounded, read-only facts for a Build's run step, never running, installing or
/// building anything and never following a link. At most 120 folders three deep, 8 components, 11,900 bytes of JSON.
public enum LaunchDiscovery {
    static let ignore: Set<String> = [".git", "node_modules", ".venv", "venv", "vendor", ".next", "dist", "build", "__pycache__"]
    static let manifests: Set<String> = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "Gemfile", "composer.json"]
    static let locks: Set<String> = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock"]
    static let scripts = ["dev", "start", "serve", "preview", "build", "predev", "prestart", "prebuild", "postinstall", "prepare", "backend", "server", "client"]
    static let uiPackages = ["vite", "next", "react-scripts", "nuxt", "astro", "@sveltejs/kit", "@angular/cli", "webpack-dev-server", "parcel", "gatsby", "@remix-run/dev", "express", "fastify", "koa", "http-server", "serve"]
    static let appPackages = ["electron", "@tauri-apps/cli", "@tauri-apps/api", "nw", "@neutralinojs/lib"]
    static let localBytes = 11_900

    static func cut(_ value: JSONValue?, _ limit: Int = 300) -> JSONValue {
        guard let s = value?.string else { return .null }
        return .string(String(s.prefix(limit)))
    }

    static func readSmallJSON(_ file: String, limit: Int = 64_000) -> [String: JSONValue] {
        var st = stat()
        guard lstat(file, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= limit,
              let value = Files.readJSON(URL(fileURLWithPath: file))?.object else { return [:] }
        return value
    }

    /// fnmatch's case-sensitive match, as launch-discovery.py uses it for npm workspace patterns.
    static func globMatch(_ value: String, _ pattern: String) -> Bool {
        var source = ""
        for ch in pattern {
            switch ch {
            case "*": source += ".*"
            case "?": source += "."
            case ".", "+", "^", "$", "{", "}", "(", ")", "|", "\\": source += "\\\(ch)"
            default: source.append(ch)
            }
        }
        return value.range(of: "^\(source)$", options: .regularExpression) != nil
    }

    static func component(_ root: String, _ relative: String, _ files: [String]) -> [String: JSONValue] {
        let dir = NodePath.join(root, relative)
        var item: [String: JSONValue] = [
            "cwd": .string(relative.isEmpty ? "." : relative),
            "manifests": .array(files.filter { manifests.contains($0) && !FS.isSymlink(NodePath.join(dir, $0)) && FS.present(NodePath.join(dir, $0)) }.sorted().map(JSONValue.string)),
            "lockfiles": .array(files.filter { locks.contains($0) }.sorted().map(JSONValue.string)),
            "files": .array(files.filter { !$0.hasPrefix(".") && !locks.contains($0) }.sorted().prefix(20).map(JSONValue.string)),
        ]
        let pkg = files.contains("package.json") ? readSmallJSON(NodePath.join(dir, "package.json")) : [:]
        if let s = pkg["scripts"]?.object {
            item["scripts"] = .object(Dictionary(uniqueKeysWithValues: s.filter { scripts.contains($0.key) }.map { ($0.key, cut($0.value)) }))
        }
        if let proxy = pkg["proxy"]?.string {
            if let target = URL(string: proxy), ["http", "https"].contains(target.scheme ?? ""), ["localhost", "127.0.0.1", "[::1]", "::1"].contains(target.host ?? ""), target.user == nil {
                item["local_proxy"] = cut(.string(proxy), 200)
            } else { item["proxy_configured"] = true }
        }
        for key in ["workspaces", "engines", "packageManager"] {
            if let v = pkg[key] { item[key] = v.text().count < 500 ? v : "[truncated; inspect package.json]" }
        }
        var deps = pkg["dependencies"]?.object ?? [:]
        for (k, v) in pkg["devDependencies"]?.object ?? [:] { deps[k] = v }
        var hints: [String: JSONValue] = [:]
        let ui = uiPackages.filter { deps[$0] != nil }
        let app = appPackages.filter { deps[$0] != nil }
        if !ui.isEmpty { hints["web"] = .array(ui.prefix(4).map(JSONValue.string)) }
        if !app.isEmpty || files.contains("src-tauri") { hints["desktop"] = .array((app.isEmpty ? ["tauri"] : Array(app.prefix(3))).map(JSONValue.string)) }
        if pkg["bin"]?.string != nil {
            let name = cut(pkg["name"], 80)
            hints["bin"] = [name.string.flatMap { $0.isEmpty ? nil : JSONValue.string($0) } ?? "bin"]
        } else if let bins = pkg["bin"]?.object {
            hints["bin"] = .array(bins.keys.sorted().prefix(4).map { .string(String($0.prefix(80))) })
        }
        if pkg["main"]?.string != nil { hints["main"] = cut(pkg["main"], 200) }
        if !hints.isEmpty { item["hints"] = .object(hints) }
        let evidence = files.filter { name in
            name.range(of: "^readme", options: [.regularExpression, .caseInsensitive]) != nil || name.range(of: #"^(vite|next)\.config\."#, options: .regularExpression) != nil
                || ["Procfile", "railpack.json", "server.py", "app.py", "main.py", "manage.py", "index.html", "electron.js", "main.js"].contains(name)
        }.sorted().prefix(8).map { relative.isEmpty ? $0 : "\(relative)/\($0)" }
        item["evidence"] = .array(evidence.map(JSONValue.string))
        return item
    }

    /// → { components, scan_truncated, elapsed_ms }
    public static func discover(_ root: String) -> JSONValue {
        let started = Date()
        var found: [[String: JSONValue]] = []
        var visited = 0
        var truncated = false
        func walk(_ relative: String, _ depth: Int) -> Bool {
            if visited >= 120 { truncated = true; return false }
            visited += 1
            let dir = relative.isEmpty ? root : NodePath.join(root, relative)
            guard let names = FS.list(dir) else { return true }
            var files: [String] = [], children: [String] = []
            for name in names {
                var st = stat()
                guard lstat(NodePath.join(dir, name), &st) == 0 else { continue }
                let kind = st.st_mode & S_IFMT
                if kind == S_IFREG { files.append(name) }
                else if kind == S_IFDIR && !ignore.contains(name) { children.append(name) }
            }
            children.sort()
            if files.contains(where: { manifests.contains($0) }) {
                if found.count == 8 { truncated = true; return false }
                found.append(component(root, relative, files + (children.contains("src-tauri") ? ["src-tauri"] : [])))
            }
            if depth >= 3 { truncated = truncated || !children.isEmpty; return true }
            for child in children { if !walk(relative.isEmpty ? child : "\(relative)/\(child)", depth + 1) { return false } }
            return true
        }
        if NodePath.isAbsolute(root) { _ = walk("", 0) }
        // A child of an npm workspace keeps its facts but is marked with the root it installs from.
        for i in found.indices {
            for candidate in found {
                var patterns = candidate["workspaces"]?.array
                if patterns == nil, let o = candidate["workspaces"]?.object { patterns = o["packages"]?.array }
                let itemCwd = found[i]["cwd"]?.string ?? "", candidateCwd = candidate["cwd"]?.string ?? ""
                guard candidateCwd != itemCwd, found[i]["manifests"]?.array?.contains(.string("package.json")) == true, let patterns else { continue }
                let base = candidateCwd == "." ? "" : "\(candidateCwd)/"
                guard itemCwd.hasPrefix(base) else { continue }
                let rel = String(itemCwd.dropFirst(base.count))
                if patterns.contains(where: { p in
                    guard let s = p.string, !s.hasPrefix("!") else { return false }
                    return globMatch(rel, s.replacingOccurrences(of: "/+$", with: "", options: .regularExpression))
                }) { found[i]["workspace_root"] = .string(candidateCwd); break }
            }
        }
        var result: [String: JSONValue] = ["components": .array(found.map(JSONValue.object)), "scan_truncated": .bool(truncated), "elapsed_ms": 0]
        while JSONValue.object(result).text().utf8.count > localBytes && !found.isEmpty {
            found.removeLast()
            result["components"] = .array(found.map(JSONValue.object))
            result["scan_truncated"] = true
        }
        result["elapsed_ms"] = .number(Date().timeIntervalSince(started) * 1000).rounded
        return .object(result)
    }
}

private extension JSONValue { var rounded: JSONValue { if case .number(let n) = self { return .number(n.rounded()) }; return self } }
