import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// index.cjs's wiring of GitHub and Zotero: the environment's fakes, the files per data root, the events on EventHub.

@MainActor
final class WiringTests: XCTestCase {
    func testGithubEnvironmentOverridesConfig() {
        let env = GithubEnvironment(["ENGELBART_GITHUB_WEB": "http://127.0.0.1:5000", "ENGELBART_GITHUB_CLIENT_ID": "Iv1.fake", "ENGELBART_GITHUB_APP_SLUG": "fake-app", "ENGELBART_GITHUB_BROKER": "http://127.0.0.1:5001"])
        XCTAssertEqual(env.settings(config: .init(clientId: "real", appSlug: "engelbart-mathetic")), .init(clientId: "Iv1.fake", appSlug: "fake-app"))
        XCTAssertEqual(GithubEnvironment([:]).settings(config: .init(clientId: "real", appSlug: "slug")), .init(clientId: "real", appSlug: "slug"))
        let hub = EventHub()
        var posted: [JSONValue] = []
        hub.on("engelbart:github") { posted.append($0) }
        let root = tempDir("gh-root")
        let channels = GithubChannels.make(environment: env, config: { .init() }, dataRoot: { root }, crypt: ReversingCrypt(),
                                           http: ClosureHTTPClient { _ in reply(500, [:]) }, openExternal: { _ in }, hub: hub)
        XCTAssertEqual(channels.github?.webBase, "http://127.0.0.1:5000")
        XCTAssertEqual(channels.github?.apiBase, "http://127.0.0.1:5000", "the API at the fake web address when none is named")
        XCTAssertEqual(channels.status().installUrl, "http://127.0.0.1:5000/apps/fake-app/installations/new")
        _ = try? channels.disconnect()
        XCTAssertEqual(posted.last?["connected"], false)
        XCTAssertFalse(FileOps.exists(join(root, "github.json")))
    }

    func testZoteroSourcesFromTheEnvironment() {
        let s = ZoteroSources(environment: ["ENGELBART_ZOTERO_API": "http://a", "ENGELBART_ZOTERO_BROKER": "http://127.0.0.1:1", "ENGELBART_ZOTERO_STORAGE": "/tmp/s",
                                            "ENGELBART_OPENALEX_API": "http://o", "ENGELBART_SEMANTIC_SCHOLAR_API": "http://s", "ENGELBART_ARXIV_API": "http://x", "ENGELBART_ARXIV": "http://y"])
        XCTAssertEqual([s.api, s.broker, s.storageDir, s.openAlex, s.semanticScholar, s.arxivApi, s.arxiv], ["http://a", "http://127.0.0.1:1", "/tmp/s", "http://o", "http://s", "http://x", "http://y"])
        let d = ZoteroSources(environment: [:])
        XCTAssertEqual([d.api, d.openAlex, d.arxiv], ["https://api.zotero.org", "https://api.openalex.org", "https://arxiv.org"])
        XCTAssertNil(d.storageDir)
    }

    func testZoteroChannelsPostStatusWithTheMirrorAndSyncNow() async throws {
        let world = FakeZoteroWorld(mine: seedLibrary())
        let hub = EventHub()
        var posted: [JSONValue] = []
        hub.on("engelbart:zotero") { posted.append($0) }
        let root = tempDir("zt-root")
        let crypt = ReversingCrypt()
        let account: JSONValue = ["v": 1, "userID": .string(ZUSER), "username": "r", "key": .string(try crypt.encrypt(ZKEY))]
        try account.text().write(toFile: join(root, "zotero.json"), atomically: true, encoding: .utf8)
        var sources = ZoteroSources(); sources.api = FakeZoteroWorld.api; sources.storageDir = tempDir("st")
        let channels = ZoteroChannels.make(sources: sources, dataRoot: { root }, crypt: crypt, http: world.client, openExternal: { _ in }, downloadsDir: { tempDir("dl") }, hub: hub, startClocks: false)
        XCTAssertEqual(channels.status().sync, ZoteroSyncStatus(state: "idle"))
        XCTAssertEqual(channels.list(""), .error("Your Zotero library is still syncing…"))
        let started = try channels.sync()
        XCTAssertEqual(started.sync?.state, "syncing", "answers at once")
        await until { channels.status().sync?.state == "synced" }
        XCTAssertEqual(channels.status().sync?.items, 5)
        XCTAssertTrue(FileOps.exists(join(root, ".zotero", "items.json")), "the mirror in <dataRoot>/.zotero")
        XCTAssertTrue(posted.contains { $0["sync"]?["state"] == "syncing" })
        XCTAssertEqual(posted.last?["sync"]?["state"], "synced")
        XCTAssertFalse(posted.map { $0.text() }.joined().contains(ZKEY))
        guard case .entries(let top, _) = channels.list("") else { return XCTFail() }
        XCTAssertEqual(top.first?.name, "My Library")
        let web = try await channels.open("WEB00001")
        XCTAssertEqual(web, .external(url: "https://example.org/page", waiting: false))
        let gone = try await channels.open("GONE0001")
        XCTAssertEqual(gone, .error("This item is no longer in your Zotero library."))
        await assertThrows({ try await channels.open("../x") }, "invalid")
        let out = try await channels.disconnect()
        XCTAssertNil(out.sync)
        XCTAssertFalse(FileOps.exists(join(root, ".zotero")), "disconnecting deletes the mirror")
        XCTAssertEqual(channels.list(""), .error("Zotero is not connected"))
        XCTAssertThrowsError(try channels.sync())
    }

    func testRefSetsFollowFindingAndWaitingEvents() {
        let hub = EventHub()
        let finding = ZoteroChips.RefSet.finding(hub: hub)
        let waiting = ZoteroChips.RefSet.waiting(seed: ["A"], hub: hub)
        hub.post("engelbart:zotero-finding", ["key": "g1:K", "finding": true])
        XCTAssertEqual(finding.refs, ["g1:K"])
        hub.post("engelbart:zotero-finding", ["key": "g1:K", "finding": false])
        XCTAssertEqual(finding.refs, [])
        hub.post("engelbart:zotero-waiting", ["key": "B", "waiting": true])
        hub.post("engelbart:zotero-waiting", ["key": "A", "waiting": false])
        XCTAssertEqual(waiting.refs, ["B"])
    }
}
