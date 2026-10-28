import Foundation
import EngelbartCore

// src/main/sandbox/launch-discovery.cjs: bounded, read-only launch facts about a repository, in its sandbox (Railpack,
// through launch-discovery.py) and on this Mac (`discoverLocal`, for a Build's run step).

public enum LaunchDiscovery {
    static let remote = "/home/user/.engelbart-canvas/launch-discovery.py"

    /// `discoverLaunch`: the sandbox's launch facts, or `{ status: 'unavailable', components: [], scan_truncated: true }`.
    public static func discover(sandbox: E2BSandbox, signal: AbortSignal? = nil, secrets: [String] = [], onEvent: (JSONValue) -> Void = { _ in }) async throws -> JSONValue {
        let started = Date()
        try signal?.throwIfAborted()
        onEvent(["phase": "plan", "source": "railpack", "status": "running", "message": "Discovering launch facts with Railpack"])
        var result: JSONValue
        do {
            try await sandbox.writeFile(remote, try SandboxResources.text("launch-discovery.py"))
            let output = try await sandbox.run("python3 \(remote)", timeoutMs: 12_000, signal: signal)
            if output.stdout.byteLength > 12000 { throw SandboxError("Discovery exceeds context limit") }
            result = Redact.value(try JSONValue.parse(output.stdout), secrets)
            guard result["components"]?.array != nil else { throw SandboxError("Invalid discovery response") }
        } catch {
            try signal?.throwIfAborted()
            result = ["status": "unavailable", "components": [], "scan_truncated": true]
        }
        try signal?.throwIfAborted()
        let components = result["components"]?.array ?? []
        let available = components.contains { $0["railpack"]?["status"]?.string == "planned" }
        onEvent(["phase": "plan", "source": "railpack", "status": .string(available ? "ok" : "unavailable"),
                 "message": .string(available ? "Launch hints discovered; Claude verifies the preview recipe" : "Railpack hints unavailable; Claude will inspect the repository"),
                 "elapsed_ms": .number((Date().timeIntervalSince(started) * 1000).rounded()), "context_bytes": .number(Double(result.text().byteLength)),
                 "components": .array(components.map { ["cwd": $0["cwd"] ?? .null, "status": $0["railpack"]?["status"] ?? .null, "raw_bytes": $0["railpack"]?["raw_bytes"] ?? .null] })])
        return result
    }

    static let ignore: Set<String> = [".git", "node_modules", ".venv", "venv", "vendor", ".next", "dist", "build", "__pycache__"]
    static let manifests: Set<String> = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "Gemfile", "composer.json"]
    static let locks: Set<String> = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock"]
    static let scripts = ["dev", "start", "serve", "preview", "build", "predev", "prestart", "prebuild", "postinstall", "prepare", "backend", "server", "client"]
    static let uiPackages = ["vite", "next", "react-scripts", "nuxt", "astro", "@sveltejs/kit", "@angular/cli", "webpack-dev-server", "parcel", "gatsby", "@remix-run/dev", "express", "fastify", "koa", "http-server", "serve"]
    static let appPackages = ["electron", "@tauri-apps/cli", "@tauri-apps/api", "nw", "@neutralinojs/lib"]
    static let localBytes = 11900

    static func cut(_ value: JSONValue?, _ limit: Int = 300) -> JSONValue {
        guard let s = value?.string else { return .null }
        return .string(s.head(limit))
    }

    static func readSmallJSON(_ path: String, limit: Int = 64_000) -> [String: JSONValue] {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular, (attributes[.size] as? Int ?? 0) <= limit,
              let data = FileManager.default.contents(atPath: path), let value = try? JSONValue.parse(data), let o = value.object else { return [:] }
        return o
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
        return value.matches("^\(source)$")
    }

    static func isSymlink(_ path: String) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: path)[.type] as? FileAttributeType) == .typeSymbolicLink
    }

    static func component(_ root: String, _ relative: String, _ files: [String]) -> [String: JSONValue] {
        let dir = relative.isEmpty ? root : (root as NSString).appendingPathComponent(relative)
        var item: [String: JSONValue] = [
            "cwd": .string(relative.isEmpty ? "." : relative),
            "manifests": .array(files.filter { manifests.contains($0) && !isSymlink((dir as NSString).appendingPathComponent($0)) && FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent($0)) }.sorted().map { .string($0) }),
            "lockfiles": .array(files.filter { locks.contains($0) }.sorted().map { .string($0) }),
            "files": .array(files.filter { !$0.hasPrefix(".") && !locks.contains($0) }.sorted().prefix(20).map { .string($0) }),
        ]
        let pkg = files.contains("package.json") ? readSmallJSON((dir as NSString).appendingPathComponent("package.json")) : [:]
        if let s = pkg["scripts"]?.object {
            var kept: [String: JSONValue] = [:]
            for (k, v) in s where scripts.contains(k) { kept[k] = cut(v) }
            item["scripts"] = .object(kept)
        }
        if let proxy = pkg["proxy"]?.string {
            // Local routing evidence only, never another address or credentials.
            if let target = URL(string: proxy), ["http", "https"].contains(target.scheme ?? ""), ["localhost", "127.0.0.1", "::1"].contains(target.host ?? ""), target.user == nil {
                item["local_proxy"] = cut(.string(proxy), 200)
            } else { item["proxy_configured"] = true }
        }
        for key in ["workspaces", "engines", "packageManager"] {
            if let v = pkg[key] { item[key] = v.text().utf16.count < 500 ? v : "[truncated; inspect package.json]" }
        }
        var deps = pkg["dependencies"]?.object ?? [:]
        for (k, v) in pkg["devDependencies"]?.object ?? [:] { deps[k] = v }
        var hints: [String: JSONValue] = [:]
        let ui = uiPackages.filter { deps[$0] != nil }
        let app = appPackages.filter { deps[$0] != nil }
        if !ui.isEmpty { hints["web"] = .array(ui.prefix(4).map { .string($0) }) }
        if !app.isEmpty || files.contains("src-tauri") { hints["desktop"] = app.isEmpty ? ["tauri"] : .array(app.prefix(3).map { .string($0) }) }
        if pkg["bin"]?.string != nil { hints["bin"] = [cut(pkg["name"], 80).isNull ? "bin" : cut(pkg["name"], 80)] }
        else if let bin = pkg["bin"]?.object { hints["bin"] = .array(bin.keys.sorted().prefix(4).map { cut(.string($0), 80) }) }
        if pkg["main"]?.string != nil { hints["main"] = cut(pkg["main"], 200) }
        if !hints.isEmpty { item["hints"] = .object(hints) }
        let evidenceNames: Set<String> = ["Procfile", "railpack.json", "server.py", "app.py", "main.py", "manage.py", "index.html", "electron.js", "main.js"]
        item["evidence"] = .array(files.filter { $0.lowercased().hasPrefix("readme") || $0.matches(#"^(vite|next)\.config\."#) || evidenceNames.contains($0) }
            .sorted().prefix(8).map { .string(relative.isEmpty ? $0 : "\(relative)/\($0)") })
        return item
    }

    /// `discoverLocal(root)`: at most 120 folders three deep, 8 components, 11,900 bytes of JSON. Never runs, installs or
    /// builds anything; never follows a link. → `{ components, scan_truncated, elapsed_ms }`
    public static func discoverLocal(_ root: String) -> JSONValue {
        let started = Date()
        var found: [[String: JSONValue]] = []
        var visited = 0
        var truncated = false
        let fm = FileManager.default
        func walk(_ relative: String, _ depth: Int) -> Bool {
            if visited >= 120 { truncated = true; return false }
            visited += 1
            let dir = relative.isEmpty ? root : (root as NSString).appendingPathComponent(relative)
            guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return true }
            var files: [String] = [], children: [String] = []
            for name in names {
                let path = (dir as NSString).appendingPathComponent(name)
                guard let type = (try? fm.attributesOfItem(atPath: path))?[.type] as? FileAttributeType else { continue }
                if type == .typeRegular { files.append(name) }
                else if type == .typeDirectory && !ignore.contains(name) { children.append(name) }
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
        if root.hasPrefix("/") { _ = walk("", 0) }
        // A child of an npm workspace keeps its facts but is marked with the root it installs from.
        for i in found.indices {
            for candidate in found where candidate["cwd"] != found[i]["cwd"] {
                var patterns = candidate["workspaces"]
                if let o = patterns?.object { patterns = o["packages"] }
                guard (found[i]["manifests"]?.array ?? []).contains("package.json"), let list = patterns?.array else { continue }
                let cwd = candidate["cwd"]!.string!, itemCwd = found[i]["cwd"]!.string!
                let base = cwd == "." ? "" : "\(cwd)/"
                guard itemCwd != cwd, itemCwd.hasPrefix(base) else { continue }
                let rel = String(itemCwd.dropFirst(base.count))
                if list.contains(where: { p in
                    guard let s = p.string, !s.hasPrefix("!") else { return false }
                    return globMatch(rel, s.replacingOccurrences(of: "/+$", with: "", options: .regularExpression))
                }) { found[i]["workspace_root"] = .string(cwd); break }
            }
        }
        func result() -> JSONValue { ["components": .array(found.map { .object($0) }), "scan_truncated": .bool(truncated), "elapsed_ms": 0] }
        while result().text().byteLength > localBytes && !found.isEmpty { found.removeLast(); truncated = true }
        var out = result().object!
        out["elapsed_ms"] = .number((Date().timeIntervalSince(started) * 1000).rounded())
        return .object(out)
    }
}

/// src/main/sandbox/npm-audit.cjs: a read-only npm audit after the preview is ready. It has no readiness or installation
/// authority; its summaries go through the worker's redaction and the build log.
public enum NpmAudit {
    static let helper = "/home/user/.engelbart-canvas/npm-audit.py"
    static let statuses: Set<String> = ["checking", "findings", "complete", "unavailable", "skipped"]

    public static func run(sandbox: E2BSandbox, signal: AbortSignal, onEvent: @escaping (JSONValue) -> Void) async throws {
        let buffer = Locked(""), reported = Locked(false), failure = Locked<Error?>(nil)
        let receive: (String) -> Void = { chunk in
            if signal.aborted || failure.value != nil { return }
            do {
                try buffer.with { buffer in
                    buffer += chunk
                    if buffer.utf16.count > 64_000 { throw SandboxError("Audit event exceeded its size limit") }
                    while let nl = buffer.firstIndex(of: "\n") {
                        let line = String(buffer[..<nl])
                        buffer = String(buffer[buffer.index(after: nl)...])
                        if line.trimmed.isEmpty { continue }
                        guard let event = try? JSONValue.parse(line), event["phase"]?.string == "audit",
                              statuses.contains(event["status"]?.string ?? ""), event["message"]?.string != nil else { throw SandboxError("Invalid audit event") }
                        reported.with { $0 = true }
                        onEvent(event)
                    }
                }
            } catch { failure.with { $0 = error } }
        }
        try signal.throwIfAborted()
        try await sandbox.writeFile(helper, try SandboxResources.text("npm-audit.py"))
        try signal.throwIfAborted()
        let result = try await sandbox.run("python3 -u \(helper)", CommandOptions(timeoutMs: 120_000, requestTimeoutMs: 130_000, onStdout: receive, signal: signal))
        if let error = failure.value { throw error }
        if result.exitCode != 0 { throw SandboxError("Background npm audit did not finish") }
        if !buffer.value.trimmed.isEmpty { receive("\n") }
        if let error = failure.value { throw error }
        if !reported.value && !signal.aborted { throw SandboxError("Background npm audit returned no report") }
    }
}
