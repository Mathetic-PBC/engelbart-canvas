import AppKit
import SwiftUI
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

// Every view of the package drawn offscreen (NSHostingView into a bitmap) in each of its states: it lays out and draws
// without trapping. What it looks like is not checked here.

@MainActor
final class ViewDrawTests: XCTestCase {
    private func draw<V: View>(_ view: V, size: NSSize = NSSize(width: 520, height: 600), file: StaticString = #filePath, line: UInt = #line) {
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return XCTFail("no bitmap", file: file, line: line) }
        host.cacheDisplay(in: host.bounds, to: rep)
        XCTAssertEqual(rep.pixelsWide > 0, true, file: file, line: line)
    }

    func testConnectionRowsInEveryState() {
        let pending = GithubPending(kind: "device", userCode: "AAAA-BBBB", verificationUri: "https://github.com/login/device", expiresAt: 1)
        for status: GithubStatus? in [nil, GithubStatus(configured: false), GithubStatus(configured: true), GithubStatus(configured: true, pending: pending),
                                      GithubStatus(configured: true, connected: true, login: "hudsonmp", persisted: false, installUrl: "https://github.com/apps/x/installations/new")] {
            draw(GithubConnectionRow(status: status, busy: nil, error: "", onAction: { _ in }))
        }
        for status: ZoteroStatus? in [nil, ZoteroStatus(configured: true), ZoteroStatus(configured: true, pending: ZoteroPending(kind: "browser", expiresAt: 1)),
                                      ZoteroStatus(configured: true, connected: true, username: "r", sync: ZoteroSyncStatus(state: "synced", items: 3, groups: 1, problems: [.init(name: "Lab", error: "x")]))] {
            draw(ZoteroConnectionRow(status: status, busy: nil, error: "oops", onAction: { _ in }))
        }
    }

    func testGithubPaneAndPicker() async {
        let (http, _) = fakeHTTP { call in
            if call.url.contains("/user/installations?") { return reply(200, ["installations": [["id": 1, "account": ["login": "me", "type": "User"], "repository_selection": "all"]]]) }
            if call.url.contains("/repositories") { return reply(200, ["repositories": [["id": 5, "full_name": "me/site", "private": true, "description": "d", "pushed_at": "2026-01-01T00:00:00Z"]]]) }
            if call.url.contains("/user/orgs") { return reply(200, []) }
            return reply(404, [:])
        }
        let dir = tempDir("pane")
        let crypt = ReversingCrypt()
        let saved: JSONValue = ["v": 1, "login": "me", "name": "", "avatarUrl": "", "id": "1", "access": .string(try! crypt.encrypt("t")), "accessExpiresAt": nil, "refresh": nil, "refreshExpiresAt": nil, "tokenFlow": "device"]
        try! saved.text().write(toFile: join(dir, "github.json"), atomically: true, encoding: .utf8)
        let github = GithubConnection(http: http, settings: { .init(clientId: "x", appSlug: "app") }, file: { join(dir, "github.json") }, crypt: crypt)
        let model = GithubPaneModel(channels: GithubChannels(github: github, openPage: { _ in }), hub: EventHub())
        await until { model.list != nil }
        XCTAssertEqual(model.rows(library: [], inRail: { _ in false }).map(\.repo.fullName), ["me/site"])
        model.query = "anthropics/claude-code"
        XCTAssertEqual(model.rows(library: [], inRail: { _ in false }).last?.typed, true)
        model.query = ""
        draw(GithubPaneView(model: model, library: [], inRail: { _ in false }, busy: false, onBack: {}, onPick: { _ in }))
        draw(GithubReposView(model: model, held: { $0.fullName == "me/site" }, onToggle: { _ in }, busyId: nil))
        let signedOut = GithubPaneModel(channels: GithubChannels(github: GithubConnection(http: http, settings: { .init(clientId: "x") }, file: { nil }), openPage: { _ in }), hub: EventHub())
        draw(GithubPaneView(model: signedOut, library: [], inRail: { _ in false }, busy: false, onBack: {}, onPick: { _ in }))
        draw(GithubReposView(model: signedOut, held: { _ in false }, onToggle: { _ in }, busyId: nil))
    }

    func testAgentViewerTabsAndBenchmark() async {
        let runs: [JSONValue] = [
            ["id": "rt-1", "agent": "router", "at": 5, "status": "done", "by": "model", "sure": 0.85, "pick": "chat", "question": "why?", "system": "R", "steps": []],
            ["id": "ch-1", "agent": "bart", "at": 6, "status": "failed", "error": "timed out", "question": "why?", "routedFrom": "rt-1", "system": "CHAT",
             "context": ["head": "<engelbart>"], "steps": [["name": "Opus", "model": "o", "effort": "high", "input": "IN", "output": "OUT", "escalated": true,
                                                            "tools": [["name": "Bash", "input": ["command": "ls"], "result": ["size": 3, "excerpt": "abc", "exitCode": 0], "ms": 12]]]], "written": ["bart> x"]],
        ]
        let channels = AgentMapChannels(runLog: FakeRunLog(runs), design: { AgentDesign.agentDesign(FakeDesignSource(), dataRoot: nil) }, saveFile: { _, _ in nil })
        let model = AgentMapModel(channels: channels, hub: EventHub())
        model.open = "steps"
        model.parts.route = true
        draw(AgentMapView(model: model), size: NSSize(width: 1280, height: 860))
        model.showDesign()
        for agent in ["router", "bart", "discover", "create", "build", "run step"] {
            model.designAgent = agent
            draw(AgentMapView(model: model), size: NSSize(width: 1280, height: 860))
        }
        let src = FakeBenchmarkSource(root: tempDir("draw-bench"))
        try! "@chat q?\nbart> # A\nbart> - b\nbart> *Chat · Opus · high · 1 s*\n".write(toFile: join(src.projectDir, "plan", "workspace.md"), atomically: true, encoding: .utf8)
        let withBench = AgentMapChannels(runLog: nil, design: { .null }, saveFile: { _, _ in nil },
                                         benchmark: ChatBenchmark(file: join(tempDir("draw-bench-user"), "b.json"), source: src), hub: EventHub())
        let bench = BenchmarkModel(channels: withBench, hub: EventHub())
        await until { bench.data != nil }
        draw(BenchmarkView(model: bench), size: NSSize(width: 1000, height: 700))
        XCTAssertTrue(BenchmarkPage.plainAnswerHTML("# A\n- b\n```js\nx\n```").contains("font:600 17px"))
    }
}
