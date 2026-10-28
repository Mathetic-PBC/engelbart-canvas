import Foundation

// src/main/github/orgs.cjs (MATH-111): the organizations the person works in, so Engelbart can name the ones its GitHub App
// is not installed on and open GitHub's install page for each. Two places say which: GitHub's /user/orgs (an App's user
// token lists few or none; only added to what the Mac says) and the GitHub remotes of this Mac's repositories (Connect's
// localRepos and picked folders). Everything here only reads.

public struct MacOrg: Equatable, Sendable {
    public var login: String
    public var repos: [String]
    public init(login: String, repos: [String]) { self.login = login; self.repos = repos }
}

public struct MissingOrg: Equatable, Sendable {
    public var login: String
    public var id: String?
    public var repos: [String]
    public var installUrl: String
    public init(login: String, id: String?, repos: [String], installUrl: String) {
        self.login = login; self.id = id; self.repos = repos; self.installUrl = installUrl
    }
}

public enum GithubOrgs {
    static let loginRE = re("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")

    static func validLogin(_ s: String) -> Bool { loginRE.test(s) }

    /// The owner of a github.com remote URL (https, ssh://, git@github.com:, git://), or nil for any other host.
    public static func remoteOwner(_ url: String?) -> String? {
        let value = (url ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let scp = re("^[\\w.-]+@(?:www\\.)?github\\.com:/?([^/\\s]+)/[^/\\s]+$", .caseInsensitive).groups(value), let owner = scp[1] {
            return validLogin(owner) ? owner : nil
        }
        guard let parsed = URLComponents(string: value), let scheme = parsed.scheme?.lowercased(), let host = parsed.host else { return nil }
        guard ["http", "https", "ssh", "git", "git+ssh"].contains(scheme), re("^(www\\.)?github\\.com$", .caseInsensitive).test(host) else { return nil }
        let parts = parsed.path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard parts.count >= 2 else { return nil }
        return validLogin(parts[0]) ? parts[0] : nil
    }

    /// The remote URLs in a git config's text (`[remote "…"]` url = … / pushurl = …).
    public static func remoteUrls(_ config: String?) -> [String] {
        var out: [String] = []
        var inRemote = false
        let line = re("^(?:push)?url\\s*=\\s*(.+)$", .caseInsensitive)
        for raw in (config ?? "").components(separatedBy: "\n") {
            let text = raw.replacingOccurrences(of: "\r", with: "").trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("[") { inRemote = re("^\\[remote\\s+\"[^\"]*\"\\]$").test(text); continue }
            if inRemote, let m = line.groups(text), let url = m[1] {
                var value = url.trimmingCharacters(in: .whitespaces)
                if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") { value = String(value.dropFirst().dropLast()) }
                out.append(value)
            }
        }
        return out
    }

    /// A repository folder's git config: .git/config, or for a worktree (.git a file) its common folder's.
    public static func configOf(_ dir: String) -> String {
        let dotGit = join(dir, ".git")
        if FileOps.isDirectory(dotGit) { return FileOps.read(join(dotGit, "config")) ?? "" }
        guard let pointer = FileOps.read(dotGit), let m = re("^gitdir:\\s*(.+)$", .anchorsMatchLines).groups(pointer), let target = m[1] else { return "" }
        let gitdir = resolve(dir, target.trimmingCharacters(in: .whitespacesAndNewlines))
        var common = gitdir
        if let commondir = FileOps.read(join(gitdir, "commondir")) {
            common = resolve(gitdir, commondir.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return FileOps.read(join(common, "config")) ?? ""
    }

    static func resolve(_ base: String, _ path: String) -> String {
        let full = path.hasPrefix("/") ? path : join(base, path)
        return (full as NSString).standardizingPath
    }

    /// The GitHub owners of the repositories in `dirs`: each once (as its first remote spelled it), the person's own
    /// login left out in any case, most repositories first, then by login.
    public static func macOrgs(_ dirs: [String], login: String = "") -> [MacOrg] {
        let me = login.lowercased()
        var order: [String] = []
        var byOwner: [String: MacOrg] = [:]
        var seenDirs = Set<String>()
        for dir in dirs where !dir.isEmpty && seenDirs.insert(dir).inserted {
            var owners: [String] = []
            for url in remoteUrls(configOf(dir)) {
                if let owner = remoteOwner(url), !owners.contains(owner) { owners.append(owner) }
            }
            var seen = Set<String>()
            for owner in owners {
                let key = owner.lowercased()
                if key == me || !seen.insert(key).inserted { continue }
                if byOwner[key] == nil { byOwner[key] = MacOrg(login: owner, repos: []); order.append(key) }
                byOwner[key]!.repos.append(dir)
            }
        }
        return order.compactMap { byOwner[$0] }.sorted {
            $0.repos.count != $1.repos.count ? $0.repos.count > $1.repos.count : $0.login.localizedCompare($1.login) == .orderedAscending
        }
    }

    /// The App's install page for one account: its permissions page with the account's id, else the page that lets them pick.
    public static func installUrlFor(_ base: String, _ id: String?) -> String {
        guard !base.isEmpty, let id, !id.isEmpty else { return base }
        return "\(base)/permissions?target_id=\(encodeURIComponent(id))"
    }

    /// The organizations without the App: GitHub's (/user/orgs) and the Mac's, less the installed `accounts` and the
    /// person, case-insensitively; `ids` (login lowercased → id) fills in ids the two lists did not carry.
    public static func missingOrgs(accounts: [String], fromGithub: [(login: String, id: String?)], fromMac: [MacOrg],
                                   login: String = "", base: String = "", ids: [String: String] = [:]) -> [MissingOrg] {
        var installed = Set(accounts.map { $0.lowercased() })
        installed.insert(login.lowercased())
        var order: [String] = []
        var out: [String: MissingOrg] = [:]
        for org in fromGithub where validLogin(org.login) {
            let key = org.login.lowercased()
            if installed.contains(key) || out[key] != nil { continue }
            out[key] = MissingOrg(login: org.login, id: org.id, repos: [], installUrl: "")
            order.append(key)
        }
        for org in fromMac {
            let key = org.login.lowercased()
            if key.isEmpty || installed.contains(key) { continue }
            var held = out[key] ?? MissingOrg(login: org.login, id: nil, repos: [], installUrl: "")
            if out[key] == nil { order.append(key) }
            for repo in org.repos where !held.repos.contains(repo) { held.repos.append(repo) }
            out[key] = held
        }
        return order.compactMap { key in
            guard var org = out[key] else { return nil }
            org.id = org.id ?? ids[org.login.lowercased()]
            org.installUrl = installUrlFor(base, org.id)
            return org
        }
    }
}
