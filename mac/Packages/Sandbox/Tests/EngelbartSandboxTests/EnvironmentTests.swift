import XCTest
import EngelbartCore
@testable import EngelbartSandbox

// test/environment-report.test.cjs, test/sandbox-environment.test.cjs
final class EnvironmentTests: XCTestCase {
    let at = "2026-09-22T21:00:00.000Z"
    func scan(_ variables: [JSONValue]) -> JSONValue { ["phase": "environment", "variables": .array(variables)] }
    func variable(_ name: String, _ status: String, _ group: String = "required") -> JSONValue {
        ["name": .string(name), "status": .string(status), "group": .string(group), "requirement": .string(group == "required" ? "required" : "optional")]
    }

    func testReportKeepsOnlyBoundedNamesAndStatuses() {
        var event = scan([
            ["name": "OPENAI_API_KEY", "status": "found", "group": "required", "requirement": "required", "value": "private-key", "default": "private-default", "source": ".env"],
            variable("NEXT_PUBLIC_API_URL", "missing"),
            ["name": "NEXT_PUBLIC_API_URL", "status": "found", "group": "required", "requirement": "required", "public": true],
            variable("HC_ENV_FILE", "found"), variable("__proto__", "found"), variable("BAD-NAME", "missing"),
            nil, ["name": "OPTION", "status": "invented", "requirement": "invented", "group": "invented"],
        ]).object!
        event["skipped"] = ["NEXT_PUBLIC_API_URL", nil, "BAD-NAME"]
        event["values"] = ["OPENAI_API_KEY": "private-key"]
        let report = EnvironmentReport.make(.object(event), runId: "run-1", at: at)!
        XCTAssertEqual(report["variables"]!.array!.map { $0["name"]!.string! }, ["OPENAI_API_KEY", "NEXT_PUBLIC_API_URL", "OPTION"])
        XCTAssertEqual(report["variables"]![1]!["status"], "missing", "one component still needing a value is not hidden by another")
        XCTAssertEqual(report["variables"]![2]!["status"], "uncertain")
        XCTAssertEqual(report["variables"]![2]!["requirement"], "unknown")
        XCTAssertEqual(report["missing"], ["NEXT_PUBLIC_API_URL"])
        XCTAssertFalse(report.text().contains("private-"))
        XCTAssertNil(EnvironmentReport.make(["phase": "environment", "warning": "scan failed"], runId: "run-1", at: at))
        XCTAssertNil(EnvironmentReport.make(["variables": []], runId: "run-1", at: at))
    }

    func testRowsMergeSavedAndDraftsMissingFirst() {
        let report = EnvironmentReport.make(scan([
            variable("PORT", "optional", "optional"), variable("OPENAI_API_KEY", "missing"), variable("DATABASE_URL", "local"),
            ["name": "VITE_API_URL", "status": "found", "group": "required", "requirement": "required", "public": true, "source": ".env.example"],
            variable("SAVED_KEY", "missing"),
        ]), runId: "run-1", at: at)
        let rows = EnvironmentRows.make(report: report, saved: ["SAVED_KEY", "EXTRA_KEY"], drafts: ["CUSTOM", "OPENAI_API_KEY"])
        XCTAssertEqual(rows[0].name, "OPENAI_API_KEY")
        XCTAssertEqual(rows.filter { $0.name == "OPENAI_API_KEY" }.count, 1)
        XCTAssertEqual(rows.count, 7)
        func row(_ name: String) -> EnvironmentRow { rows.first { $0.name == name }! }
        XCTAssertEqual(EnvironmentRows.describe(row("OPENAI_API_KEY")), "Required · no value")
        XCTAssertEqual(EnvironmentRows.describe(row("SAVED_KEY"), pending: true), "Saved · used on the next launch")
        XCTAssertEqual(EnvironmentRows.describe(row("SAVED_KEY"), removed: true), "Saved override removed")
        XCTAssertEqual(EnvironmentRows.describe(row("DATABASE_URL")), "Provided by the sandbox")
        XCTAssertEqual(EnvironmentRows.describe(row("PORT")), "Optional")
        XCTAssertEqual(row("VITE_API_URL").variable?.isPublic, true)
        XCTAssertEqual(EnvironmentRows.describe(row("VITE_API_URL")), "Found in .env.example")
        XCTAssertEqual(EnvironmentRows.describe(row("CUSTOM")), "New variable")
        XCTAssertEqual(EnvironmentRows.make(report: nil, saved: ["CUSTOM"]), [EnvironmentRow(name: "CUSTOM", variable: nil, saved: true)])
    }

    func testLegacyLogsSupplyTheLastScan() {
        var run: [String: JSONValue] = ["id": "old-run", "build_log": [
            ["time": .string(at), "data": scan([variable("OLD_KEY", "missing")])],
            ["time": .string(at), "data": ["phase": "environment", "warning": "Could not scan again"]],
        ]]
        XCTAssertEqual(EnvironmentReport.of(.object(run))?["variables"]?[0]?["name"], "OLD_KEY")
        run["build_log"] = .array(run["build_log"]!.array! + [["time": .string(at), "data": scan([])]])
        XCTAssertEqual(EnvironmentReport.of(.object(run))?["variables"], [])
        let persisted = EnvironmentReport.make(scan([variable("RETAINED_KEY", "found")]), runId: "old-run", at: at)!
        run["build_log"] = []; run["env_report"] = persisted
        XCTAssertEqual(EnvironmentReport.of(.object(run)), persisted)
        XCTAssertNil(EnvironmentReport.of(["id": "unscanned", "build_log": []]))
    }

    func testValidationAndRedaction() {
        for name in ["BAD-NAME", "1KEY", "__proto__", "HC_ENV_FILE", "HUMAN_COMPACT_HOME", "ENGELBART_CANVAS_PORT"] {
            XCTAssertThrowsError(try EnvironmentStore.validate([EnvironmentChange(name: name, value: "x")]))
        }
        XCTAssertThrowsError(try EnvironmentStore.validate([EnvironmentChange(name: "A", value: "x\0y")]))
        XCTAssertThrowsError(try EnvironmentStore.validate([EnvironmentChange(name: "A", value: "a"), EnvironmentChange(name: "A", value: "b")]))
        XCTAssertThrowsError(try EnvironmentStore.validate((0..<201).map { EnvironmentChange(name: "K\($0)", value: "") }))
        XCTAssertThrowsError(try EnvironmentStore.validate([EnvironmentChange(name: "A", value: String(repeating: "x", count: 16385))]))
        let secret = "hello\"\nsecret"
        XCTAssertEqual(Redact.value(["data": ["text": .string("got \(secret)")]], [secret]), ["data": ["text": "got [redacted]"]])
        XCTAssertFalse(Redact.output("token=abcdef", ["abcdefghij"]).contains("abcdef"))
        XCTAssertFalse(Redact.output("ghij done", ["abcdefghij"]).contains("ghij"))
        XCTAssertEqual(Redact.event(["event": "ready", "sandbox_id": "app-id", "preview_url": "https://app.example", "message": "app"], ["app"])["preview_url"], "https://app.example")
        XCTAssertEqual(Redact.event(["message": "app"], ["app"])["message"], "[redacted]")
    }

    func testEncryptedRevisionedStore() throws {
        let db = try database()
        let id = try db.insertLibrary(name: "owner/app", url: "https://github.com/owner/app")
        let vault = MemorySecure()
        let env = EnvironmentStore(db: db, secure: vault)
        let value = " secret \"$value\"\nwith-newline "
        let saved = try env.save(id, [EnvironmentChange(name: "APP_SECRET", value: value), EnvironmentChange(name: "EMPTY", value: "")], expectedRevision: nil)
        XCTAssertEqual(saved.names, ["APP_SECRET", "EMPTY"])
        XCTAssertFalse(saved.json.text().contains("secret \\\""))
        XCTAssertEqual(try env.read(id).values["APP_SECRET"], value, "whitespace and dollars are not altered")
        let raw = try db.query("select * from sandbox_environments", []).description
        XCTAssertFalse(raw.contains("secret")); XCTAssertFalse(raw.contains("APP_SECRET"))
        XCTAssertThrowsError(try env.save(id, [], expectedRevision: nil)) { XCTAssertTrue(message(of: $0).contains("changed elsewhere")) }
        let removed = try env.save(id, [EnvironmentChange(name: "APP_SECRET", value: nil)], expectedRevision: saved.revision)
        let reloaded = EnvironmentStore(db: db, secure: vault)
        XCTAssertEqual(try reloaded.describe(id), removed)
        XCTAssertEqual(try reloaded.read(id).values, ["EMPTY": ""])
        XCTAssertEqual(removed.removed, ["APP_SECRET"])
        XCTAssertEqual(try reloaded.save(id, [EnvironmentChange(name: "APP_SECRET", value: "new")], expectedRevision: removed.revision).removed, [])
        let off = MemorySecure(); off.available = false
        XCTAssertThrowsError(try EnvironmentStore(db: db, secure: off).read(id)) { XCTAssertTrue(message(of: $0).contains("Secure storage")) }
        XCTAssertThrowsError(try EnvironmentStore(db: db, secure: MemorySecure()).read(id)) { XCTAssertTrue(message(of: $0).contains("could not be unlocked")) }
        let other = try db.insertLibrary(name: "notes", url: "https://example.com", tags: [])
        XCTAssertThrowsError(try env.read(other)) { XCTAssertEqual(message(of: $0), "Choose a saved GitHub repository.") }
    }

    func testDiscoveredFieldsSurviveTrimmedLogsAndRetries() throws {
        let db = try database()
        let id = try db.insertLibrary(name: "owner/app", url: "https://github.com/owner/app")
        let store = RunStore(db), env = EnvironmentStore(db: db, secure: MemorySecure())
        XCTAssertNil(try env.describe(id).report)
        let first = try store.create(id)!
        let event = scan([["name": "OPENAI_API_KEY", "status": "missing", "requirement": "required", "group": "required"],
                          ["name": "DATABASE_URL", "status": "local", "requirement": "required", "group": "required"]])
        let updated = try store.record(first["id"]!.string!, "Environment scanned", ["data": event])!
        XCTAssertEqual(updated["env_report"]?["variables"]?.array?.map { $0["name"]!.string! }, ["OPENAI_API_KEY", "DATABASE_URL"])
        for _ in 0..<300 { try store.record(first["id"]!.string!, "Build output") }
        let trimmed = try store.get(first["id"]!.string!)!
        XCTAssertEqual(trimmed["build_log"]?.array?.count, 300)
        XCTAssertFalse(trimmed["build_log"]!.array!.contains { $0["data"]?["phase"]?.string == "environment" })
        XCTAssertEqual(trimmed["env_report"], updated["env_report"])
        try store.update(first["id"]!.string!, [("status", "failed")])
        let second = try store.create(id)!
        XCTAssertEqual(try env.describe(id).report, updated["env_report"])
        try store.record(second["id"]!.string!, "Scan unavailable", ["data": ["phase": "environment", "warning": "Unavailable"]])
        XCTAssertEqual(try env.describe(id).report?["runId"], first["id"])
        try store.record(second["id"]!.string!, "Environment scanned", ["data": scan([])])
        XCTAssertEqual(try env.describe(id).report?["variables"], [])
        XCTAssertEqual(try env.describe(id).report?["runId"], second["id"])
    }

    func testKeychainStorageRoundTrip() throws {
        let storage = KeychainSecureStorage(service: "Engelbart Swift Tests \(UUID().uuidString.prefix(6))", account: "sandbox-environments")
        defer { storage.deleteKey() }
        guard storage.isEncryptionAvailable else { throw XCTSkip("No keychain in this environment") }
        let sealed = try storage.encrypt("{\"values\":{\"K\":\"v\"}}")
        XCTAssertFalse(String(decoding: sealed, as: UTF8.self).contains("values"))
        XCTAssertEqual(try storage.decrypt(sealed), "{\"values\":{\"K\":\"v\"}}")
    }
}
