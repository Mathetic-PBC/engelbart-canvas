import Foundation

// src/main/github/repo-access.cjs (2026-09-29): a GitHub repository's code for an E2B sandbox, read with the person's
// GitHub sign-in without the sign-in ever leaving this process. `describe` says whether the repository is private, its
// default branch and whether it wants Docker; `archive` hands a private repository's sandbox a codeload.github.com link
// good for one archive for about five minutes, never the sign-in. A public repository needs neither.

public struct RepoRef: Sendable, Equatable {
    public var owner: String
    public var name: String
    public init(owner: String, name: String) { self.owner = owner; self.name = name }
}

public struct RepoDescription: Sendable, Equatable {
    public var isPrivate: Bool
    public var branch: String?
    /// nil: not known (GitHub could not say).
    public var docker: Bool?
}

public struct RepoAccessError: Error, LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }
}

public final class GithubRepoAccess: @unchecked Sendable {
    static let timeout: TimeInterval = 20
    static let dockerFiles = re("(^|/)(docker-compose|compose)\\.ya?ml$|(^|/)supabase/config\\.toml$", .caseInsensitive)
    public static let branchRule = re("^(?![-/])(?!.*\\.\\.)(?!.*//)(?!.*/$)[\\w./-]{1,200}$")
    public static let archiveHosts = ["codeload.github.com"]

    let token: @Sendable () async -> String?
    let http: HTTPClient
    let api: String
    let installUrl: @Sendable () async -> String
    let hosts: [String]

    public init(token: @escaping @Sendable () async -> String? = { nil }, http: HTTPClient = URLSessionHTTPClient.shared,
                api: String = GithubConnection.api, installUrl: @escaping @Sendable () async -> String = { "" }, archiveHosts: [String] = GithubRepoAccess.archiveHosts) {
        self.token = token; self.http = http; self.api = api; self.installUrl = installUrl; self.hosts = archiveHosts
    }

    private func base(_ repo: RepoRef) -> String { "\(api)/repos/\(encodeURIComponent(repo.owner))/\(encodeURIComponent(repo.name))" }

    /// A GET of GitHub's API, signed in when there is a sign-in.
    private func get(_ url: String, redirect: HTTPRequest.Redirect = .follow) async throws -> (HTTPResponse, Bool) {
        let value = await token()
        var headers = ["accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "engelbart-canvas"]
        if let value { headers["authorization"] = "Bearer \(value)" }
        guard let target = URL(string: url) else { throw RepoAccessError(message: "Bad address") }
        return (try await http.send(HTTPRequest(url: target, headers: headers, redirect: redirect, timeout: Self.timeout)), value != nil)
    }

    private func wantsDocker(_ repo: RepoRef) async -> Bool? {
        guard let (response, _) = try? await get("\(base(repo))/git/trees/HEAD?recursive=1"), response.ok, let body = response.json else { return nil }
        return (body["tree"]?.array ?? []).contains { Self.dockerFiles.test($0["path"]?.stringish ?? "") }
    }

    /// → { private, branch, docker }. A repository GitHub cannot show throws words that say what to do; anything else
    /// GitHub cannot answer now leaves it to the sandbox's clone, as for a public repository.
    public func describe(_ repo: RepoRef) async throws -> RepoDescription {
        let name = "\(repo.owner)/\(repo.name)"
        guard let (response, signed) = try? await get(base(repo)) else { return RepoDescription(isPrivate: false, branch: nil, docker: nil) }
        if response.status == 404 {
            let install = await installUrl()
            throw RepoAccessError(message: signed
                ? "Engelbart's GitHub App cannot see \(name). If it is private, install the App for \(repo.owner) with access to it\(install.isEmpty ? "" : " (\(install))")."
                : "\(name) was not found on GitHub. If it is private, sign in to GitHub in Engelbart.")
        }
        guard response.ok else { return RepoDescription(isPrivate: false, branch: nil, docker: nil) }
        let data = response.json ?? .object([:])
        let branch = data["default_branch"]?.string.flatMap { Self.branchRule.test($0) ? $0 : nil }
        return RepoDescription(isPrivate: data["private"]?.bool == true, branch: branch, docker: await wantsDocker(repo))
    }

    /// A private repository's download link: one archive, minutes long. The sign-in goes to GitHub's API only.
    public func archive(_ repo: RepoRef) async throws -> String {
        let name = "\(repo.owner)/\(repo.name)"
        let (response, signed) = try await get("\(base(repo))/tarball", redirect: .manual)
        let location = response.header("location")
        if !signed { throw RepoAccessError(message: "Sign in to GitHub in Engelbart to prepare \(name): it is private.") }
        guard [301, 302, 303, 307, 308].contains(response.status), let location else {
            throw RepoAccessError(message: "GitHub would not hand over \(name)'s code (\(response.status)).")
        }
        guard let url = URL(string: location, relativeTo: URL(string: api)), url.scheme == "https", let host = url.host,
              hosts.contains(host), url.user == nil, url.password == nil else {
            throw RepoAccessError(message: "GitHub answered with an unexpected download address for \(name).")
        }
        return url.absoluteString
    }
}
