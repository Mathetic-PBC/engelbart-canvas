import XCTest
import EngelbartCore
@testable import EngelbartStore

/// test/home.test.cjs, test/defaults.test.cjs, test/developer.test.cjs
final class HomeTests: XCTestCase {
    let providers: JSONValue = ["openai", "anthropic"]
    let summarizer: JSONValue = ["provider": "openai", "openai": ["model": "gpt-6-luna", "effort": "high"], "anthropic": ["model": "claude-opus-5-5", "effort": "high"]]
    let github: JSONValue = ["clientId": "Iv23liAZNYl96zlluMDs", "appSlug": "engelbart-mathetic"]
    var tools: JSONValue { ToolsRecord.normalizeTools(nil) }

    func testEnsureHomeMakesTheRootTestRootAndAnnotations() throws {
        let home = tempDir()
        let layout = try Home.ensureHome(home)
        XCTAssertEqual(layout.root, Paths.join(home, ".engelbart-swift"))
        XCTAssertEqual(layout.testRoot, Paths.join(home, ".engelbart-swift", "test"))
        XCTAssertTrue(Paths.isDirectory(layout.testRoot))
        XCTAssertTrue(Paths.isDirectory(Paths.join(layout.testRoot, "annotations")))
        XCTAssertThrowsError(try Home.ensureHome("relative/path"))
        let shipped = try Home.ensureHome(tempDir(), test: false)
        XCTAssertTrue(Paths.isDirectory(shipped.root)); XCTAssertTrue(exists(shipped.configFile)); XCTAssertFalse(exists(shipped.testRoot))
        let custom = try Home.ensureHome(home, rootDir: Paths.join(home, "elsewhere"), test: false)
        XCTAssertEqual(custom.root, Paths.join(home, "elsewhere"), "ENGELBART_ROOT_DIR")
    }

    func testConfigDefaultsAndToggle() throws {
        let root = try Home.ensureHome(tempDir()).root
        let base: JSONValue = ["testMode": false, "providers": providers, "summarizer": summarizer, "github": github, "tools": tools]
        XCTAssertEqual(Home.readConfig(root), base)
        XCTAssertEqual(try Home.writeConfig(root, ["testMode": true]), base.merging(["testMode": true]))
        XCTAssertEqual(Home.readConfig(root)["testMode"], true)
        let file = Paths.join(root, "config.json")
        write(file, #"{"testMode":false,"summarizer":{"provider":"claude","anthropic":{"model":"claude-sonnet-5","effort":"low"},"openai":{"model":"rm -rf /","effort":"extreme"}}}"#)
        XCTAssertEqual(Home.readConfig(root)["summarizer"], ["provider": "anthropic", "openai": ["model": "gpt-6-luna", "effort": "high"], "anthropic": ["model": "claude-sonnet-5", "effort": "low"]])
        XCTAssertEqual(try Home.writeConfig(root, ["testMode": true])["summarizer"]?["anthropic"]?["model"], "claude-sonnet-5")
        // A config file from before the setting existed gains it on the next launch.
        write(file, #"{"testMode":false}"#)
        try Home.ensureHome((root as NSString).deletingLastPathComponent)
        XCTAssertEqual(json(file), base)
        write(file, JSONValue.object(["testMode": false, "providers": providers, "summarizer": summarizer, "github": ["clientId": "", "appSlug": ""]]).text())
        XCTAssertEqual(Home.readConfig(root)["github"], github)
        write(file, JSONValue.object(["testMode": false, "github": ["clientId": " Iv23liAbCdEf1234567890 ", "appSlug": "engelbart-mathetic"]]).text())
        XCTAssertEqual(try Home.writeConfig(root, ["testMode": true])["github"], ["clientId": "Iv23liAbCdEf1234567890", "appSlug": "engelbart-mathetic"])
        write(file, JSONValue.object(["testMode": false, "github": ["clientId": "x y", "appSlug": "Not A Slug"]]).text())
        XCTAssertEqual(Home.readConfig(root)["github"], github)
        write(file, JSONValue.object(["testMode": false, "providers": ["claude", "Anthropic", "gemini"]]).text())
        XCTAssertEqual(Home.readConfig(root)["providers"], ["anthropic"])
        XCTAssertEqual(try Home.writeConfig(root, ["testMode": true])["providers"], ["anthropic"])
        write(file, JSONValue.object(["testMode": false, "providers": ["gemini"]]).text())
        XCTAssertEqual(Home.readConfig(root)["providers"], providers)
        XCTAssertThrowsError(try Home.writeConfig(root, ["testMode": "no"]))
        XCTAssertThrowsMatchingSync({ try Home.writeConfig(root, ["other": 1]) }, "Unsupported config key: other")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root).filter { $0.hasSuffix(".tmp") }.count, 0)
    }

    func testALaterDefaultReachesConfigAndChoicesStay() throws {
        let home = tempDir()
        let root = try Home.ensureHome(home).root
        let file = Paths.join(root, "config.json"), base = Paths.join(root, ".defaults", "config.json")
        XCTAssertTrue(exists(base))
        var given = json(base)!.object!
        given["summarizer"] = ["provider": "openai", "openai": ["model": "gpt-5.6-luna", "effort": "high"], "anthropic": ["model": "claude-opus-5", "effort": "medium"]]
        write(base, JSONValue.object(given).text())
        var mine = json(file)!.object!
        mine["testMode"] = true
        mine["summarizer"] = ["provider": "anthropic", "openai": ["model": "gpt-5.6-luna", "effort": "high"], "anthropic": ["model": "claude-opus-5", "effort": "low"]]
        write(file, JSONValue.object(mine).text())
        try Home.ensureHome(home)
        let now = Home.readConfig(root)
        XCTAssertEqual(now["summarizer"]?["openai"]?["model"], "gpt-6-luna")
        XCTAssertEqual(now["summarizer"]?["anthropic"]?["model"], "claude-opus-5-5")
        XCTAssertEqual([now["testMode"], now["summarizer"]?["provider"], now["summarizer"]?["anthropic"]?["effort"]], [true, "anthropic", "low"])
    }

    func testOldTestModeDefaultGoesOffChosenStaysOn() throws {
        let home = tempDir()
        let root = try Home.ensureHome(home).root
        let file = Paths.join(root, "config.json"), base = Paths.join(root, ".defaults", "config.json")
        func old(_ path: String) -> String { json(path)!.merging(["testMode": true]).text() }
        write(base, old(base)); write(file, old(file))
        try Home.ensureHome(home)
        XCTAssertEqual(Home.readConfig(root)["testMode"], false)
        write(file, old(file)); try FileManager.default.removeItem(atPath: base)
        try Home.ensureHome(home)
        XCTAssertEqual(Home.readConfig(root)["testMode"], false)
        try Home.writeConfig(root, ["testMode": true])
        try Home.ensureHome(home)
        XCTAssertEqual(Home.readConfig(root)["testMode"], true)
    }

    func testUntouchedModelsUpgradeWithoutABase() throws {
        let home = tempDir()
        let root = try Home.ensureHome(home).root
        var config = Home.readConfig(root).object!
        config["summarizer"] = ["provider": "openai", "openai": ["model": "gpt-5.6-luna", "effort": "high"], "anthropic": ["model": "claude-opus-5", "effort": "medium"]]
        write(Paths.join(root, "config.json"), JSONValue.object(config).text())
        try FileManager.default.removeItem(atPath: Paths.join(root, ".defaults", "config.json"))
        try Home.ensureHome(home)
        XCTAssertEqual(Home.readConfig(root)["summarizer"], ["provider": "openai", "openai": ["model": "gpt-6-luna", "effort": "high"], "anthropic": ["model": "claude-opus-5-5", "effort": "medium"]])
        XCTAssertEqual((try FileManager.default.contentsOfDirectory(atPath: Paths.join(root, ".backups"))).filter { $0.hasPrefix("config-") }.count, 1, "backed up once")
    }

    func testAnUnparsableConfigIsNeverOverwritten() throws {
        let home = tempDir()
        let root = try Home.ensureHome(home).root
        let file = Paths.join(root, "config.json")
        write(file, #"{ "testMode": fal"#)
        try Home.ensureHome(home)
        XCTAssertEqual(read(file), #"{ "testMode": fal"#)
        XCTAssertEqual(Home.readConfig(root)["testMode"], false)
        XCTAssertNil(try Home.writeTools(root, ToolsRecord.normalizeTools(["git": ["installed": true]])))
        XCTAssertEqual(read(file), #"{ "testMode": fal"#)
    }

    func testToolRecordIsValidated() throws {
        let root = try Home.ensureHome(tempDir()).root
        let written = try Home.writeTools(root, [
            "updates": "never",
            "git": ["installed": true, "version": "2.50.1", "requires": ">=0.0.1", "status": "ready", "path": "/usr/bin/git", "onPath": true, "source": "apple", "checkedAt": "2026-09-23T18:00:00.000Z", "skip": false],
            "claude": ["installed": "yes", "version": "banana", "status": "on fire", "signedIn": "maybe", "path": "relative/claude", "error": .string("line one\n" + String(repeating: "x", count: 500)), "pin": "2.1.278", "skip": true],
            "codex": ["failedUpdate": ["from": "0.150.0", "at": "2026-09-23T18:00:00.000Z"], "source": "apt"],
        ])!
        let t = written["tools"]!
        XCTAssertEqual(t["updates"], "auto")
        XCTAssertEqual([t["git"]?["installed"], t["git"]?["version"], t["git"]?["requires"], t["git"]?["source"]], [true, "2.50.1", ">=2.30.0", "apple"])
        XCTAssertNil(t["git"]?["signedIn"], "Git has no sign-in")
        let c = t["claude"]!
        XCTAssertEqual([c["installed"], c["version"], c["status"], c["signedIn"], c["path"], c["pin"], c["skip"]], [false, .null, "unknown", .null, .null, "2.1.278", true])
        XCTAssertEqual(c["error"]?.string?.count, 300); XCTAssertFalse(c["error"]!.string!.contains("\n"))
        XCTAssertEqual([t["codex"]?["failedUpdate"], t["codex"]?["source"]], [["from": "0.150.0", "at": "2026-09-23T18:00:00.000Z"], .null])
        XCTAssertEqual(Home.readConfig(root)["tools"], t)
    }

    func testNames() {
        XCTAssertEqual(Names.sanitizeName("a/b..c "), "a-b..c")
        XCTAssertEqual(Names.sanitizeName("09/20 plan\\v2"), "09-20 plan-v2")
        XCTAssertEqual(Names.sanitizeName("..hidden"), "hidden")
        XCTAssertEqual(Names.sanitizeName("  many   spaces\n"), "many spaces")
        XCTAssertEqual(Names.sanitizeName("Émile: Café/Notes"), "Émile Café-Notes")
        XCTAssertEqual(Names.sanitizeName(""), "Untitled")
        XCTAssertEqual(Names.sanitizeName(nil), "Untitled")
        XCTAssertEqual(Names.sanitizeName(String(repeating: "x", count: 200)).count, 120)
        let dir = tempDir()
        try! FileManager.default.createDirectory(atPath: Paths.join(dir, "Goal"), withIntermediateDirectories: true)
        try! FileManager.default.createDirectory(atPath: Paths.join(dir, "Goal 2"), withIntermediateDirectories: true)
        XCTAssertEqual(Names.uniqueName(dir, "Goal"), "Goal 3")
        XCTAssertEqual(Names.uniqueName(dir, "Fresh"), "Fresh")
        write(Paths.join(dir, "Note.md"), "")
        XCTAssertEqual(Names.uniqueName(dir, "Note", ext: ".md"), "Note 2")
        XCTAssertEqual(Names.slugify("Thesis 2026"), "thesis-2026")
        XCTAssertEqual(Names.slugify("  My Folder!  "), "my-folder")
        XCTAssertEqual(Names.slugify("../etc/passwd"), "etc-passwd")
        XCTAssertEqual(Names.slugify(""), "")
        XCTAssertEqual(Names.slugify(String(repeating: "x", count: 80)).count, 48)
    }

    // MARK: defaults.test.cjs

    func testEqualIgnoresKeyOrder() {
        XCTAssertTrue(Defaults.equal(["a": 1, "b": [1, ["c": 2]]], ["b": [1, ["c": 2]], "a": 1]))
        XCTAssertFalse(Defaults.equal([1, 2], [2, 1]))
        XCTAssertTrue(Defaults.equal(nil, nil))
        XCTAssertFalse(Defaults.equal(.null, nil))
    }

    func testMerge3() {
        let base: JSONValue = ["model": "luna", "effort": "high", "efforts": ["medium", "high"], "about": "old words"]
        let theirs: JSONValue = ["model": "sol", "effort": "high", "efforts": ["medium", "high", "ultra"], "about": "new words"]
        let ours: JSONValue = ["model": "luna", "effort": "low", "efforts": ["medium", "high"], "about": "old words"]
        XCTAssertEqual(Defaults.merge3(base, ours, theirs), ["model": "sol", "effort": "low", "efforts": ["medium", "high", "ultra"], "about": "new words"])
        XCTAssertEqual(Defaults.merge3(base, ours.merging(["efforts": ["high"]]), theirs)?["efforts"], ["high"])
        let b2: JSONValue = ["models": ["luna": 1, "sol": 2], "keep": true]
        XCTAssertEqual(Defaults.merge3(b2, b2, b2.merging(["models": ["luna": 1, "sol": 2, "astra": 3]]))?["models"], ["luna": 1, "sol": 2, "astra": 3])
        XCTAssertEqual(Defaults.merge3(b2, ["models": ["sol": 2], "keep": true], ["models": ["luna": 9, "sol": 2], "keep": true])?["models"], ["sol": 2])
        XCTAssertEqual(Defaults.merge3(b2, b2, ["models": ["sol": 2], "keep": true])?["models"], ["sol": 2])
        XCTAssertEqual(Defaults.merge3(b2, ["models": ["luna": 7, "sol": 2], "keep": true], ["models": ["sol": 2], "keep": true])?["models"], ["luna": 7, "sol": 2])
        XCTAssertEqual(Defaults.merge3(b2, b2.merging(["mine": "x"]), b2.merging(["keep": false])), ["models": ["luna": 1, "sol": 2], "keep": false, "mine": "x"])
    }

    func testRebuildBase() {
        let v1: JSONValue = ["about": "one", "efforts": ["m", "h"], "ladder": ["a"]]
        let v2: JSONValue = ["about": "two", "efforts": ["m", "h", "u"], "ladder": ["a"]]
        let file: JSONValue = ["about": "one", "efforts": ["m", "h", "u"], "ladder": ["mine"]]
        let base = Defaults.rebuildBase(file, [v1, v2])
        XCTAssertEqual(base, ["about": "one", "efforts": ["m", "h", "u"], "ladder": ["a"]])
        XCTAssertEqual(Defaults.merge3(base, file, v2), ["about": "two", "efforts": ["m", "h", "u"], "ladder": ["mine"]])
        XCTAssertEqual(Defaults.rebuildBase(["testMode": false], [["testMode": true], ["testMode": true, "github": ["id": "x"]]]), ["testMode": true])
        XCTAssertEqual(Defaults.rebuildBase(["a": 1], [["a": 1, "b": 2], ["a": 1, "b": 3]]), ["a": 1, "b": 3])
        XCTAssertEqual(Defaults.rebuildBase(["s": ["x": 1]], [[:], ["s": ["x": 1, "y": 2]]]), ["s": ["x": 1, "y": 2]])
        XCTAssertEqual(Defaults.rebuildBase(["s": ["x": 1]], [["s": ["x": 1]], ["s": ["x": 1, "y": 2]]]), ["s": ["x": 1]])
    }

    func testCarryDefaults() throws {
        let dir = tempDir()
        let file = Paths.join(dir, "models.json")
        let out = Defaults.carryDefaults(file: file, defaults: ["a": 1])
        XCTAssertEqual(out.value, ["a": 1]); XCTAssertTrue(out.wrote)
        XCTAssertEqual(json(file), ["a": 1]); XCTAssertEqual(json(Defaults.baseFile(for: file)), ["a": 1])
        XCTAssertEqual(Defaults.baseFile(for: file), Paths.join(dir, ".defaults", "models.json"))
        XCTAssertEqual(((try FileManager.default.attributesOfItem(atPath: file))[.posixPermissions] as! NSNumber).intValue & 0o777, 0o600)

        let f2 = Paths.join(dir, "m2.json")
        Defaults.carryDefaults(file: f2, defaults: ["provider": "openai", "about": "v1", "effort": "high"])
        write(f2, #"{"provider":"openai","about":"v1","effort":"low"}"#)
        XCTAssertEqual(Defaults.carryDefaults(file: f2, defaults: ["provider": "anthropic", "about": "v2", "effort": "high"]).value, ["provider": "anthropic", "about": "v2", "effort": "low"])
        XCTAssertEqual(json(Defaults.baseFile(for: f2)), ["provider": "anthropic", "about": "v2", "effort": "high"])
        let before = Paths.stat(f2)!.mtimeMs
        XCTAssertFalse(Defaults.carryDefaults(file: f2, defaults: ["provider": "anthropic", "about": "v2", "effort": "high"]).wrote)
        XCTAssertEqual(Paths.stat(f2)!.mtimeMs, before)

        let f3 = Paths.join(dir, "m3.json"), backups = Paths.join(dir, ".backups")
        let v1: JSONValue = ["about": "v1", "efforts": ["m"], "provider": "openai"]
        let v2: JSONValue = ["about": "v2", "efforts": ["m", "u"], "provider": "openai"]
        let v3: JSONValue = ["about": "v3", "efforts": ["m", "u"], "provider": "openai", "ladder": ["sol"]]
        write(f3, #"{"about":"v1","efforts":["m","u"],"provider":"anthropic"}"#)
        let merged = Defaults.carryDefaults(file: f3, defaults: v3, past: [v1, v2], backupDir: backups, now: { Time.parse("2026-09-23T12:00:00.000Z")! })
        XCTAssertEqual(merged.value, ["about": "v3", "efforts": ["m", "u"], "provider": "anthropic", "ladder": ["sol"]])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: backups), ["m3-2026-09-23T12-00-00-000Z.json"])
        XCTAssertEqual(json(Paths.join(backups, "m3-2026-09-23T12-00-00-000Z.json"))?["about"], "v1")
        Defaults.carryDefaults(file: f3, defaults: v3.merging(["about": "v4"]), past: [v1, v2, v3], backupDir: backups)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: backups).count, 1)
        XCTAssertEqual(json(f3)?["about"], "v4")

        let f4 = Paths.join(dir, "m4.json")
        write(f4, #"{ "half": "#)
        let broken = Defaults.carryDefaults(file: f4, defaults: ["a": 1])
        XCTAssertNil(broken.value); XCTAssertFalse(broken.wrote); XCTAssertEqual(read(f4), #"{ "half": "#); XCTAssertFalse(exists(Defaults.baseFile(for: f4)))
        write(f4, "[]")
        XCTAssertNil(Defaults.carryDefaults(file: f4, defaults: ["a": 1]).value)

        let f5 = Paths.join(dir, "config.json")
        write(f5, #"{"testMode":false,"junk":1}"#)
        let normalize: (JSONValue) -> JSONValue = { v in ["testMode": .bool(v["testMode"]?.bool ?? true), "providers": v["providers"]?.array.map(JSONValue.array) ?? ["openai"]] }
        XCTAssertEqual(Defaults.carryDefaults(file: f5, defaults: normalize([:]), past: [["testMode": true]], normalize: normalize).value, ["testMode": false, "providers": ["openai"]])

        let f6 = Paths.join(dir, "c6.json")
        let defaults: JSONValue = ["testMode": true, "summarizer": ["provider": "openai", "effort": "high"]]
        Defaults.carryDefaults(file: f6, defaults: defaults)
        write(f6, #"{"testMode":false,"summarizer":{"provider":"anthropic"}}"#)
        XCTAssertEqual(Defaults.carryDefaults(file: f6, defaults: defaults).value, ["testMode": false, "summarizer": ["provider": "anthropic"]])
        XCTAssertEqual(Defaults.carryDefaults(file: f6, defaults: defaults, fillMissing: true).value, ["testMode": false, "summarizer": ["provider": "anthropic", "effort": "high"]])
        XCTAssertEqual(json(f6), ["testMode": false, "summarizer": ["provider": "anthropic", "effort": "high"]])
        XCTAssertFalse(Defaults.carryDefaults(file: f6, defaults: defaults, fillMissing: true).wrote)
    }

    // MARK: developer.test.cjs

    func testDeveloperHasTestMode() {
        let dist = tempDir("engelbart-dist-")
        let file = Paths.join(dist, Developer.buildFile)
        XCTAssertTrue(Developer.hasTestMode(packaged: false, distDir: dist, env: [:]))
        XCTAssertFalse(Developer.hasTestMode(packaged: true, distDir: dist, env: [:]))
        write(file, #"{"developer":false}"#); XCTAssertFalse(Developer.hasTestMode(packaged: true, distDir: dist, env: [:]))
        write(file, #"{"developer":true}"#); XCTAssertTrue(Developer.hasTestMode(packaged: true, distDir: dist, env: [:]))
        write(file, #"{"developer":"true"}"#); XCTAssertFalse(Developer.hasTestMode(packaged: true, distDir: dist, env: [:]))
        write(file, #"{"developer":tr"#); XCTAssertFalse(Developer.hasTestMode(packaged: true, distDir: dist, env: [:]))
        XCTAssertFalse(Developer.hasTestMode(packaged: false, distDir: dist, env: ["ENGELBART_TEST_MODE": "off"]))
        write(file, #"{"developer":true}"#); XCTAssertFalse(Developer.hasTestMode(packaged: true, distDir: dist, env: ["ENGELBART_TEST_MODE": "off"]))
        write(file, #"{"developer":false}"#); XCTAssertFalse(Developer.hasTestMode(packaged: true, distDir: dist, env: ["ENGELBART_TEST_MODE": "on"]))
    }
}
