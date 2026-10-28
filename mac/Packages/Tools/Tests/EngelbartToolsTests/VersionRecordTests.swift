import EngelbartCore
import XCTest
@testable import EngelbartTools

// test/tools.test.cjs: versions, requirements and the record.
final class VersionRecordTests: XCTestCase {
    func testVersionsAreReadAndJudged() {
        XCTAssertEqual(parseVersion("git version 2.50.1 (Apple Git-155)", "git"), "2.50.1")
        XCTAssertEqual(parseVersion("2.1.281 (Claude Code)", "claude"), "2.1.281")
        XCTAssertEqual(parseVersion("WARNING: node v18.2.0 is old\ncodex-cli 0.155.1", "codex"), "0.155.1", "the program's own pattern beats a number in a warning")
        XCTAssertEqual(parseVersion("git version 2.39", "git"), "2.39.0")
        XCTAssertNil(parseVersion("no digits here", "git"))
        XCTAssertNil(parseVersion("10.0.0.1 is an address"))
        XCTAssertEqual(parseVersion("v01.02.03"), "1.2.3")
        XCTAssertEqual(compareVersions("2.1.278", "2.1.281"), -1)
        XCTAssertEqual(compareVersions("2.10.0", "2.9.9"), 1)
        XCTAssertEqual(judge("claude", "2.1.200").status, "outdated")
        XCTAssertEqual(judge("claude", "2.1.200").why, "Claude Code 2.1.200 is older than 2.1.278.")
        XCTAssertEqual(judge("claude", "2.1.278"), Verdict(status: "ready", untested: false, why: nil))
        XCTAssertTrue(judge("claude", "3.0.0").untested, "a newer major is allowed and marked untested")
        XCTAssertEqual(judge("codex", "nonsense").status, "unknown")
    }

    func testAKnownBadRangeMakesAVersionIncompatible() {
        let requirement = Requirements.codex.with(incompatible: [IncompatibleRange(from: "0.156.0", to: "0.156.3", why: "resume lost the session")])
        XCTAssertEqual(judge("codex", "0.156.1", requirement), Verdict(status: "incompatible", untested: false, why: "resume lost the session"))
        XCTAssertEqual(judge("codex", "0.156.3", requirement).status, "ready", "the end of a range is excluded")
        XCTAssertTrue(Requirements.codex.incompatible.isEmpty, "the shipped table is unchanged")
    }

    func testRequirementsTable() {
        XCTAssertEqual(TOOL_NAMES, ["git", "claude", "codex"])
        XCTAssertEqual([Requirements.git.minimum, Requirements.claude.minimum, Requirements.codex.minimum], ["2.30.0", "2.1.278", "0.155.0"])
        XCTAssertEqual([Requirements.git.testedMajor, Requirements.claude.testedMajor, Requirements.codex.testedMajor], [2, 2, 0])
        XCTAssertEqual(requiresText("claude"), ">=2.1.278")
        XCTAssertEqual(PROVIDER_OF["claude"], "anthropic")
        XCTAssertEqual(TOOL_OF["openai"], "codex")
    }

    func testTheRecordKeepsTheAccountOnlyWhileSignedIn() {
        let tools = normalizeTools(["claude": ["signedIn": true, "account": "someone@example.com"], "codex": ["signedIn": false, "account": "someone@example.com"], "git": ["account": "someone@example.com"]])
        XCTAssertEqual(tools["claude"].account, "someone@example.com")
        XCTAssertNil(tools["codex"].account)
        XCTAssertNil(tools["git"].fields["account"], "git has no account key")
        XCTAssertNil(normalizeTools(["claude": ["signedIn": true, "account": "two words"]])["claude"].account)
        XCTAssertNil(normalizeTools(["claude": ["signedIn": true, "account": 7]])["claude"].account)
        XCTAssertEqual(observed("claude", Found(file: "/x/claude", ran: true, version: "2.1.300", signedIn: false, account: "someone@example.com"))["account"], .null)
        XCTAssertEqual(observed("claude", Found(file: "/x/claude", ran: false, signedIn: true, account: "someone@example.com"))["account"], .null,
                       "a copy that did not run says nothing about who is signed in")
    }

    func testNormalizeKeepsOnlyValidFields() {
        let note = "An older Claude Code comes first on your PATH."
        let tool = normalizeTool("claude", [
            "installed": "yes", "version": "2.1", "status": "weird", "path": "relative/claude", "onPath": true, "source": "macports",
            "untested": 1, "checkedAt": "not a date", "error": .string(String(repeating: "x ", count: 400)), "note": .string("  \(note)\n"),
            "failedUpdate": ["from": "2.1.200", "at": "2026-09-23T12:00:00.000Z"], "skip": "true", "pin": "2.1.278", "requires": ">=0",
        ])
        XCTAssertEqual(tool.installed, false)
        XCTAssertNil(tool.version)
        XCTAssertEqual(tool.status, "unknown")
        XCTAssertNil(tool.path)
        XCTAssertEqual(tool.onPath, true)
        XCTAssertNil(tool.source)
        XCTAssertFalse(tool.untested)
        XCTAssertNil(tool.checkedAt)
        XCTAssertEqual(tool.error?.count, 300)
        XCTAssertEqual(tool.note, note, "kept on one line")
        XCTAssertEqual(tool.failedUpdate, FailedUpdate(from: "2.1.200", at: "2026-09-23T12:00:00.000Z"))
        XCTAssertFalse(tool.skip)
        XCTAssertEqual(tool.pin, "2.1.278")
        XCTAssertEqual(tool.requires, ">=2.1.278", "requires always comes from the table")
        let blank = normalizeTools(nil)
        XCTAssertEqual(blank.updates, "auto")
        XCTAssertEqual(blank["git"].status, "unknown")
        XCTAssertEqual(blank["git"].installed, false)
        XCTAssertEqual(normalizeTools(["updates": "ask"]).updates, "ask")
        XCTAssertEqual(normalizeTools(["updates": "never"]).updates, "auto")
        XCTAssertEqual(normalizeTool("git", ["path": "/usr/bin/git\u{0}x"]).path, nil)
        XCTAssertEqual(normalizeTool("git", ["checkedAt": "2026-10-28T17:04:05.123Z"]).checkedAt, "2026-10-28T17:04:05.123Z")
    }

    func testObserved() {
        XCTAssertEqual(status(observed("codex")), "missing")
        XCTAssertEqual(observed("codex")["installed"], false)
        let broken = observed("claude", Found(file: "/x/claude", ran: false, error: "Claude Code did not start: exit status 1"))
        XCTAssertEqual(status(broken), "failed")
        XCTAssertEqual(broken["installed"], true)
        XCTAssertEqual(broken["signedIn"], .null)
        XCTAssertEqual(status(observed("claude", Found(file: "/x/claude", ran: true, version: "2.1.100", signedIn: true))), "outdated")
        XCTAssertEqual(status(observed("claude", Found(file: "/x/claude", ran: true, version: "2.1.300", signedIn: false))), "signed-out")
        let unread = observed("codex", Found(file: "/x/codex", ran: true, version: nil, error: "Could not read the version"))
        XCTAssertEqual(status(unread), "ready", "an unreadable version is not called outdated, so it is never updated in a loop")
        XCTAssertEqual(unread["version"], .null)
        XCTAssertEqual(observed("claude", Found(file: "/x/claude", ran: true, version: "2.1.100"))["error"], "Claude Code 2.1.100 is older than 2.1.278.")
    }
}
