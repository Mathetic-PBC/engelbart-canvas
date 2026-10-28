import Foundation
import EngelbartCore

// The GitHub IPC of src/main/ipc.cjs (github-status, -connect, -cancel, -disconnect, -repos, -open) and the wiring of
// index.cjs createGithub, for the Swift app: one place the panes and the app call. Every change of the sign-in is
// posted on EventHub as `engelbart:github` with the status (preload's onGithub).

/// What index.cjs read from the environment and config.json for GitHub. ENGELBART_GITHUB_* name a fake GitHub, for
/// scripted runs only.
public struct GithubEnvironment: Sendable {
    public var web: String?
    public var api: String?
    public var broker: String?
    public var clientIdOverride: String?
    public var appSlugOverride: String?

    public init(_ env: [String: String] = ProcessInfo.processInfo.environment) {
        web = env["ENGELBART_GITHUB_WEB"].flatMap { $0.isEmpty ? nil : $0 }
        api = env["ENGELBART_GITHUB_API"].flatMap { $0.isEmpty ? nil : $0 }
        broker = env["ENGELBART_GITHUB_BROKER"].flatMap { $0.isEmpty ? nil : $0 }
        clientIdOverride = env["ENGELBART_GITHUB_CLIENT_ID"].flatMap { $0.isEmpty ? nil : $0 }
        appSlugOverride = env["ENGELBART_GITHUB_APP_SLUG"].flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The settings in force: the environment's over config.json's `github` { clientId, appSlug }.
    public func settings(config: GithubConnection.Settings) -> GithubConnection.Settings {
        GithubConnection.Settings(clientId: clientIdOverride ?? config.clientId, appSlug: appSlugOverride ?? config.appSlug)
    }
}

@MainActor
public final class GithubChannels {
    public let github: GithubConnection?
    let openPage: (String) async throws -> Void

    public init(github: GithubConnection?, openPage: @escaping (String) async throws -> Void) {
        self.github = github
        self.openPage = openPage
    }

    /// index.cjs's createGithub as the app makes it. `config()` is config.json's `github` block, `dataRoot()` the open
    /// data root (the sign-in follows it), `localRepoDirs()` the repositories Connect found on this Mac (MATH-111, read
    /// at most every 5 minutes by the app), `onConnected` brings the focused window forward (and fetches the E2B key),
    /// `onStatus` is told every change (the E2B key forgotten when signed out); each change is also posted on EventHub.
    public static func make(environment: GithubEnvironment = GithubEnvironment(),
                            config: @escaping () -> GithubConnection.Settings,
                            dataRoot: @escaping () -> String?,
                            crypt: SecretCrypt = KeychainCrypt.shared,
                            http: HTTPClient = URLSessionHTTPClient.shared,
                            openExternal: @escaping (String) async throws -> Void,
                            localRepoDirs: @escaping () -> [String] = { [] },
                            onConnected: @escaping () -> Void = {},
                            onStatus: @escaping (GithubStatus) -> Void = { _ in },
                            hub: EventHub = .shared) -> GithubChannels {
        let browser = try? GithubBrowserAuth(broker: environment.broker ?? GithubBrowserAuth.broker, http: http)
        let settings = { environment.settings(config: config()) }
        let github = GithubConnection(
            http: http,
            settings: settings,
            file: { dataRoot().map { join($0, "github.json") } },
            crypt: crypt,
            openVerification: openExternal,
            browserAuth: { settings().clientId == GithubBrowserAuth.clientId ? browser : nil },
            onConnected: onConnected,
            onChange: { status in
                onStatus(status)
                hub.post("engelbart:github", status.json)
            },
            localOrgs: { login, dirs in GithubOrgs.macOrgs(localRepoDirs() + dirs, login: login) },
            openInstall: openExternal,
            web: environment.web ?? GithubConnection.web,
            api: environment.api ?? environment.web ?? GithubConnection.api)
        return GithubChannels(github: github, openPage: openExternal)
    }

    private func gh() throws -> GithubConnection {
        guard let github else { throw GithubError("GitHub is not available") }
        return github
    }

    public func status() -> GithubStatus { github?.status() ?? .unavailable }
    public func connect() async throws -> GithubStatus { try await gh().connect() }
    public func cancel() throws -> GithubStatus { try gh().cancel() }
    public func disconnect() throws -> GithubStatus { try gh().disconnect() }
    public func repos(dirs: [String] = []) async throws -> GithubRepoList { try await gh().repos(dirs: dirs) }

    /// github-open: 'install' opens the App's install page (or one organization's, which must be a page of it), anything
    /// else the sign-in page waiting; in the default browser.
    @discardableResult
    public func open(_ which: String, page: String? = nil) async throws -> Bool {
        let status = try gh().status()
        var url = which == "install" ? status.installUrl : (status.pending?.verificationUri ?? "")
        if which == "install", let asked = page {
            let base = status.installUrl
            guard !base.isEmpty, asked.count <= 2048, asked == base || asked.hasPrefix("\(base)/") || asked.hasPrefix("\(base)?") else {
                throw GithubError("Not the GitHub App's install page")
            }
            url = asked
        }
        if url.isEmpty {
            throw GithubError(which == "install" ? "The GitHub App has no slug in ~/.engelbart/config.json (github.appSlug)." : "No sign-in is waiting")
        }
        try await openPage(url)
        return true
    }
}
