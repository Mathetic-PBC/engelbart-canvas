import Foundation

// src/renderer/model/github.js (2026-09-22): the + menu's GitHub list. Pure: the App's repositories and the library come
// in, the rows go out; GithubPaneView draws them and the screen adds or links the one picked.

/// The little of a library row the list needs (the app adapts the Store's rows).
public struct GithubLibraryRow: Equatable, Sendable {
    public var id: String
    public var githubId: String?
    public var url: String?
    public init(id: String, githubId: String? = nil, url: String? = nil) { self.id = id; self.githubId = githubId; self.url = url }
}

public struct GithubRow: Equatable, Sendable {
    public var repo: GithubRepo
    public var row: GithubLibraryRow?
    public var here: Bool
    public var typed: Bool = false
}

public enum GithubModel {
    static func key(_ url: String?) -> String {
        var s = (url ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasSuffix(".git") { s.removeLast(4) }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// The library row that already is this repository: the same GitHub id, else the same address.
    public static func heldRow(_ repo: GithubRepo, library: [GithubLibraryRow]) -> GithubLibraryRow? {
        let address = key(repo.url)
        return library.first { row in
            if let gid = row.githubId, !gid.isEmpty, let rid = repo.id, gid == rid { return true }
            if let url = row.url, !url.isEmpty, key(url) == address { return true }
            return false
        }
    }

    /// Every word typed against the name and the description, in the order GitHub's list came.
    public static func rows(repos: [GithubRepo], query: String, library: [GithubLibraryRow], inRail: (String) -> Bool) -> [GithubRow] {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return repos.filter { repo in
            let hay = "\(repo.fullName) \(repo.description)".lowercased()
            return words.allSatisfy { hay.contains($0) }
        }.map { repo in
            let row = heldRow(repo, library: library)
            return GithubRow(repo: repo, row: row, here: row.map { inRail($0.id) } ?? false)
        }
    }

    // A repository typed or pasted into the search (2026-10-06): `owner/name`, `github.com/owner/name`, its https address,
    // or its git remote.
    static let typedRE = re("^(?:(?:https?://)?(?:www\\.)?github\\.com/|git@github\\.com:)?([a-z\\d](?:[a-z\\d-]{0,38}))/([\\w.-]+?)(?:\\.git)?(?:[/?#].*)?$", .caseInsensitive)

    /// The row for a repository typed into the search, when it is not one of `rows` already; nil when it is no repository.
    public static func typedRepo(query: String, rows: [GithubRow] = [], library: [GithubLibraryRow] = [], inRail: (String) -> Bool = { _ in false }) -> GithubRow? {
        guard let m = typedRE.groups(query.trimmingCharacters(in: .whitespacesAndNewlines)), let owner = m[1], let name = m[2] else { return nil }
        if name == "." || name == ".." { return nil }
        let fullName = "\(owner)/\(name)"
        if rows.contains(where: { $0.repo.fullName.lowercased() == fullName.lowercased() }) { return nil }
        let repo = GithubRepo(id: nil, fullName: fullName, url: "https://github.com/\(fullName)", owner: owner, isPrivate: false, typed: true)
        let row = heldRow(repo, library: library)
        return GithubRow(repo: repo, row: row, here: row.map { inRail($0.id) } ?? false, typed: true)
    }

    /// The picker's search (GithubRepos.jsx): every word against "fullName description".
    public static func filter(_ repos: [GithubRepo], query: String) -> [GithubRepo] {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return repos.filter { repo in
            let hay = "\(repo.fullName) \(repo.description)".lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// "1 repo on this Mac" / "N repos on this Mac".
    public static func reposOnMac(_ n: Int) -> String { n == 1 ? "1 repo on this Mac" : "\(n) repos on this Mac" }
}
