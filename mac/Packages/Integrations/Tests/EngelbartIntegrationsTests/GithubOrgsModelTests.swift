import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// test/github-orgs.test.cjs, test/github-repo-access.test.cjs, test/github-model.test.cjs.

final class GithubOrgsTests: XCTestCase {
    private func repo(_ root: String, _ name: String, _ config: String) -> String {
        let dir = join(root, name)
        FileOps.mkdir(join(dir, ".git"))
        try! config.write(toFile: join(dir, ".git", "config"), atomically: true, encoding: .utf8)
        return dir
    }
    private func remote(_ name: String, _ url: String) -> String { "[remote \"\(name)\"]\n\turl = \(url)\n\tfetch = +refs/heads/*:refs/remotes/\(name)/*\n" }

    func testRemoteOwner() {
        XCTAssertEqual(GithubOrgs.remoteOwner("https://github.com/Lab-A/tutor.git"), "Lab-A")
        XCTAssertEqual(GithubOrgs.remoteOwner("https://user@github.com/lab-a/tutor"), "lab-a")
        XCTAssertEqual(GithubOrgs.remoteOwner("git@github.com:lab-b/agents.git"), "lab-b")
        XCTAssertEqual(GithubOrgs.remoteOwner("ssh://git@github.com/lab-c/x.git"), "lab-c")
        XCTAssertEqual(GithubOrgs.remoteOwner("git://github.com/lab-d/x"), "lab-d")
        XCTAssertEqual(GithubOrgs.remoteOwner("https://www.github.com/lab-e/x"), "lab-e")
        XCTAssertNil(GithubOrgs.remoteOwner("https://gitlab.com/lab-a/tutor.git"))
        XCTAssertNil(GithubOrgs.remoteOwner("git@bitbucket.org:lab-a/tutor.git"))
        XCTAssertNil(GithubOrgs.remoteOwner("https://github.com/lab-a"), "an owner alone is not a repository")
        XCTAssertNil(GithubOrgs.remoteOwner("/Users/me/elsewhere/repo"))
        XCTAssertNil(GithubOrgs.remoteOwner("https://github.com/-bad/x"))
        XCTAssertEqual(GithubOrgs.remoteUrls("[core]\n\turl = https://github.com/no/thanks\n\(remote("origin", "git@github.com:a/b.git"))[branch \"main\"]\n\tremote = origin\n[remote \"up\"]\n\tpushurl = \"https://github.com/c/d\"\n"),
                       ["git@github.com:a/b.git", "https://github.com/c/d"])
    }

    func testMacOrgs() throws {
        let root = tempDir("engelbart-orgs")
        let a1 = repo(root, "a1", remote("origin", "https://github.com/lab-a/tutor.git"))
        let a2 = repo(root, "a2", remote("origin", "git@github.com:LAB-A/agents.git") + remote("fork", "git@github.com:Hudsonmp/agents.git"))
        let b = repo(root, "b", remote("origin", "git@github.com:lab-b/study.git"))
        let mine = repo(root, "mine", remote("origin", "https://github.com/hudsonmp/site"))
        let gitlab = repo(root, "gl", remote("origin", "https://gitlab.com/lab-z/x.git"))
        let worktree = join(root, "wt")
        FileOps.mkdir(join(a1, ".git", "worktrees", "wt"))
        try "../..\n".write(toFile: join(a1, ".git", "worktrees", "wt", "commondir"), atomically: true, encoding: .utf8)
        FileOps.mkdir(worktree)
        try "gitdir: \(join(a1, ".git", "worktrees", "wt"))\n".write(toFile: join(worktree, ".git"), atomically: true, encoding: .utf8)
        let found = GithubOrgs.macOrgs([a1, a2, b, mine, gitlab, worktree, a1, join(root, "nothing")], login: "HudsonMP")
        XCTAssertEqual(found, [MacOrg(login: "lab-a", repos: [a1, a2, worktree]), MacOrg(login: "lab-b", repos: [b])])
    }

    func testMissingOrgs() {
        let base = "https://github.com/apps/engelbart/installations/new"
        let found = GithubOrgs.missingOrgs(
            accounts: ["Lab-A"],
            fromGithub: [("LAB-B", "22"), ("lab-c", "33"), ("lab-a", "11")],
            fromMac: [MacOrg(login: "lab-a", repos: ["/r/a"]), MacOrg(login: "lab-b", repos: ["/r/b1", "/r/b2"]), MacOrg(login: "hudsonmp", repos: ["/r/me"]), MacOrg(login: "lab-d", repos: ["/r/d"])],
            login: "HudsonMP", base: base, ids: ["lab-d": "44"])
        XCTAssertEqual(found, [
            MissingOrg(login: "LAB-B", id: "22", repos: ["/r/b1", "/r/b2"], installUrl: "\(base)/permissions?target_id=22"),
            MissingOrg(login: "lab-c", id: "33", repos: [], installUrl: "\(base)/permissions?target_id=33"),
            MissingOrg(login: "lab-d", id: "44", repos: ["/r/d"], installUrl: "\(base)/permissions?target_id=44"),
        ])
        XCTAssertEqual(GithubOrgs.installUrlFor(base, nil), base)
    }
}

final class GithubRepoAccessTests: XCTestCase {
    private let REPO = RepoRef(owner: "owner", name: "app")
    private let TOKEN = "ghu_signed_in_token"
    private let LINK = "https://codeload.github.com/owner/app/legacy.tar.gz/refs/heads/main?token=AAAAONEARCHIVEONLYTOKEN"

    struct Route { var status: Int; var body: JSONValue = .null; var location: String? = nil }

    private func github(_ routes: [String: Route]) -> (HTTPClient, Box<[HTTPRequest]>) {
        let calls = Box<[HTTPRequest]>([])
        let client = ClosureHTTPClient { request in
            calls.value.append(request)
            let route = routes[request.url.path] ?? Route(status: 404, body: ["message": "Not Found"])
            var headers: [String: String] = [:]
            if let location = route.location { headers["location"] = location }
            return HTTPResponse(status: route.status, headers: headers, body: Data(route.body.text().utf8))
        }
        return (client, calls)
    }

    func testPrivateRepositoryDescribedSignedInArchiveLinkNotFollowed() async throws {
        let (http, calls) = github([
            "/repos/owner/app": Route(status: 200, body: ["private": true, "default_branch": "main"]),
            "/repos/owner/app/git/trees/HEAD": Route(status: 200, body: ["tree": [["path": "src/index.js"], ["path": "docker-compose.yml"]]]),
            "/repos/owner/app/tarball": Route(status: 302, location: LINK),
        ])
        let token = TOKEN
        let access = GithubRepoAccess(token: { token }, http: http)
        let described = try await access.describe(REPO)
        XCTAssertEqual(described, RepoDescription(isPrivate: true, branch: "main", docker: true))
        let link = try await access.archive(REPO)
        XCTAssertEqual(link, LINK)
        XCTAssertTrue(calls.value.allSatisfy { $0.url.absoluteString.hasPrefix("https://api.github.com/") && $0.headers["authorization"] == "Bearer \(token)" })
        XCTAssertEqual(calls.value.last?.redirect, .manual)
    }

    func testPublicRepositoryAndGithubUnableToAnswer() async throws {
        let (http, _) = github(["/repos/owner/app": Route(status: 200, body: ["private": false, "default_branch": "main"]), "/repos/owner/app/git/trees/HEAD": Route(status: 200, body: ["tree": [["path": "package.json"]]])])
        let token = TOKEN
        let open = try await GithubRepoAccess(token: { token }, http: http).describe(REPO)
        XCTAssertEqual(open, RepoDescription(isPrivate: false, branch: "main", docker: false))
        let (limited, _) = github(["/repos/owner/app": Route(status: 403, body: ["message": "API rate limit exceeded"])])
        let l = try await GithubRepoAccess(http: limited).describe(REPO)
        XCTAssertEqual(l, RepoDescription(isPrivate: false, branch: nil, docker: nil))
        let offline = GithubRepoAccess(http: ClosureHTTPClient { _ in throw HTTPError.failed("offline") })
        let o = try await offline.describe(REPO)
        XCTAssertEqual(o, RepoDescription(isPrivate: false, branch: nil, docker: nil))
    }

    func testNotFoundSaysWhatToDo() async {
        let (http, _) = github([:])
        let token = TOKEN
        await assertThrows({ try await GithubRepoAccess(token: { token }, http: http, installUrl: { "https://github.com/apps/engelbart/installations/new" }).describe(self.REPO) },
                           "Engelbart's GitHub App cannot see owner/app\\. If it is private, install the App for owner with access to it \\(https://github\\.com/apps/engelbart/installations/new\\)\\.")
        await assertThrows({ try await GithubRepoAccess(http: http).describe(self.REPO) }, "owner/app was not found on GitHub\\. If it is private, sign in to GitHub in Engelbart\\.")
    }

    func testOnlyCodeloadLinks() async {
        let token = TOKEN
        let answer = { (route: Route) in
            let (http, _) = self.github(["/repos/owner/app/tarball": route])
            return try await GithubRepoAccess(token: { token }, http: http).archive(self.REPO)
        }
        await assertThrows({ try await answer(Route(status: 302, location: "https://evil.example/owner/app.tar.gz")) }, "unexpected download address")
        await assertThrows({ try await answer(Route(status: 302, location: "http://codeload.github.com/owner/app")) }, "unexpected download address")
        await assertThrows({ try await answer(Route(status: 302, location: "https://user:pass@codeload.github.com/owner/app")) }, "unexpected download address")
        await assertThrows({ try await answer(Route(status: 404)) }, "would not hand over owner/app's code \\(404\\)")
        let (http, _) = github(["/repos/owner/app/tarball": Route(status: 302, location: LINK)])
        await assertThrows({ try await GithubRepoAccess(http: http).archive(self.REPO) }, "Sign in to GitHub")
    }
}

final class GithubModelTests: XCTestCase {
    private func repo(_ id: String, _ full: String, _ description: String = "", _ priv: Bool = false) -> GithubRepo {
        GithubRepo(id: id, fullName: full, url: "https://github.com/\(full)", owner: String(full.split(separator: "/")[0]), isPrivate: priv, description: description)
    }

    func testRowsEveryWordHeldRowHere() {
        let repos = [repo("9", "Mathetic-PBC/engelbart-canvas", "Engelbart desktop", true), repo("5", "hudsonmp/hudsonmp.github.io", "site"), repo("7", "VectifyAI/PageIndex", "reasoning-based RAG")]
        let library = [GithubLibraryRow(id: "a", githubId: "9", url: "https://github.com/Mathetic-PBC/engelbart-canvas"), GithubLibraryRow(id: "b", githubId: nil, url: "https://github.com/vectifyai/pageindex/")]
        let inRail = { (id: String) in id == "a" }
        let all = GithubModel.rows(repos: repos, query: "", library: library, inRail: inRail)
        XCTAssertEqual(all.map { [$0.repo.id ?? "", $0.row?.id ?? "nil", String($0.here)] }, [["9", "a", "true"], ["5", "nil", "false"], ["7", "b", "false"]])
        XCTAssertEqual(GithubModel.rows(repos: repos, query: "rag", library: library, inRail: inRail).map { $0.repo.id }, ["7"])
        XCTAssertEqual(GithubModel.rows(repos: repos, query: "mathetic desktop", library: library, inRail: inRail).map { $0.repo.id }, ["9"])
        XCTAssertEqual(GithubModel.rows(repos: repos, query: "nothing", library: library, inRail: inRail), [])
        XCTAssertEqual(GithubModel.heldRow(repo("9", "Mathetic-PBC/renamed-since"), library: library)?.id, "a")
        XCTAssertNil(GithubModel.heldRow(repo("1", "someone/else"), library: library))
    }

    func testTypedRepo() {
        for (query, url) in [("anthropics/claude-code", "https://github.com/anthropics/claude-code"), ("https://github.com/anthropics/claude-code.git", "https://github.com/anthropics/claude-code"), ("github.com/a/b/tree/main", "https://github.com/a/b"), ("git@github.com:a/b.git", "https://github.com/a/b")] {
            let entry = GithubModel.typedRepo(query: query)
            XCTAssertEqual(entry?.repo.url, url, query)
            XCTAssertEqual(entry?.typed, true)
            XCTAssertNil(entry?.repo.id)
        }
        for query in ["", "engelbart", "a/..", "one two/three"] { XCTAssertNil(GithubModel.typedRepo(query: query), query) }
        XCTAssertNil(GithubModel.typedRepo(query: "mathetic-pbc/landing", rows: [GithubRow(repo: repo("3", "Mathetic-PBC/landing"), row: nil, here: false)]))
        let held = GithubModel.typedRepo(query: "vectifyai/pageindex", library: [GithubLibraryRow(id: "b", url: "https://github.com/VectifyAI/PageIndex")], inRail: { $0 == "b" })
        XCTAssertEqual(held?.row?.id, "b")
        XCTAssertEqual(held?.here, true)
    }
}
