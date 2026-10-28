import Foundation
import XCTest
import EngelbartCore
@testable import EngelbartIntegrations

/// The tests' keychain: reversible, never the real Keychain (test/github.test.cjs `crypt`).
struct ReversingCrypt: SecretCrypt {
    func available() -> Bool { true }
    func encrypt(_ text: String) throws -> String { Data(String(text.reversed()).utf8).base64EncodedString() }
    func decrypt(_ text: String) throws -> String {
        guard let data = Data(base64Encoded: text) else { throw SecretCryptError.unreadable }
        return String(String(decoding: data, as: UTF8.self).reversed())
    }
}

struct ThrowingCrypt: SecretCrypt {
    func available() -> Bool { true }
    func encrypt(_ text: String) throws -> String { "" }
    func decrypt(_ text: String) throws -> String { throw SecretCryptError.unreadable }
}

final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t: Double
    init(_ t: Double = 1_000_000) { self.t = t }
    var now: Double { lock.lock(); defer { lock.unlock() }; return t }
    func advance(_ ms: Double) { lock.lock(); t += ms; lock.unlock() }
    func set(_ ms: Double) { lock.lock(); t = ms; lock.unlock() }
}

/// A recorded request of a fake server.
struct Call: Sendable {
    var url: String
    var method: String
    var form: [String: String]?
    var auth: String?
    var headers: [String: String]
    var body: Data?
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Call] = []
    func add(_ call: Call) { lock.lock(); items.append(call); lock.unlock() }
    var calls: [Call] { lock.lock(); defer { lock.unlock() }; return items }
}

func formOf(_ body: Data?) -> [String: String]? {
    guard let body else { return nil }
    var out: [String: String] = [:]
    for pair in String(decoding: body, as: UTF8.self).split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        let decode = { (s: String) in s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? s }
        out[decode(parts[0])] = parts.count > 1 ? decode(parts[1]) : ""
    }
    return out
}

/// A fake HTTP whose answers come from `script`, every request recorded.
func fakeHTTP(_ recorder: Recorder = Recorder(), _ script: @escaping @Sendable (Call) async throws -> HTTPResponse) -> (HTTPClient, Recorder) {
    let client = ClosureHTTPClient { request in
        let headers = Dictionary(request.headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, b in b })
        let call = Call(url: request.url.absoluteString, method: request.method, form: headers["content-type"]?.contains("urlencoded") == true ? formOf(request.body) : nil,
                        auth: headers["authorization"], headers: headers, body: request.body)
        recorder.add(call)
        return try await script(call)
    }
    return (client, recorder)
}

func reply(_ status: Int, _ data: JSONValue, headers: [String: String] = [:]) -> HTTPResponse {
    HTTPResponse(status: status, headers: headers, body: Data(data.text().utf8))
}

func tempDir(_ name: String = "engelbart-test") -> String {
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("\(name)-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

/// Waits (yielding to the main actor's other work) until `check` holds.
@MainActor
func until(_ check: () -> Bool, tries: Int = 4000, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<tries {
        if check() { return }
        await Task.yield()
        if tries > 0 { try? await Task.sleep(nanoseconds: 200_000) }
    }
    XCTFail("never settled", file: file, line: line)
}

@MainActor
func settle(_ n: Int = 20) async { for _ in 0..<n { await Task.yield() } }

func assertThrows<T>(_ body: () async throws -> T, _ pattern: String, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await body()
        XCTFail("expected an error matching \(pattern)", file: file, line: line)
    } catch {
        let message = error.localizedDescription
        XCTAssertTrue(message.range(of: pattern, options: .regularExpression) != nil, "\(message) !~ \(pattern)", file: file, line: line)
    }
}
