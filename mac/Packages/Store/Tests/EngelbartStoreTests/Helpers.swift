import XCTest
import Foundation
import EngelbartCore
@testable import EngelbartStore

/// A fresh temporary directory, by its real path (macOS's /var → /private/var), as `fs.realpathSync(mkdtemp)`.
func tempDir(_ prefix: String = "engelbart-") -> String {
    let base = NSTemporaryDirectory() + prefix + UUID().uuidString.prefix(8)
    try! FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    return try! Paths.real(base)
}

/// A layout and a context on its test root, as the Electron tests make `ctx`.
func makeContext(_ prefix: String = "engelbart-", dataRootIsRoot: Bool = false) throws -> (ctx: StoreContext, layout: Home.Layout, home: String) {
    let home = tempDir(prefix)
    let layout = try Home.ensureHome(home)
    let dataRoot = dataRootIsRoot ? layout.root : layout.testRoot
    let ctx = StoreContext(homeDir: home, root: layout.root, dataRoot: dataRoot, libraryDb: try LibraryDB.open(root: dataRoot))
    return (ctx, layout, home)
}

func write(_ path: String, _ text: String = "x") {
    try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try! text.write(toFile: path, atomically: false, encoding: .utf8)
}
func writeData(_ path: String, _ data: Data) {
    try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try! data.write(to: URL(fileURLWithPath: path))
}
func read(_ path: String) -> String? { try? String(contentsOfFile: path, encoding: .utf8) }
func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: path) }
func json(_ path: String) -> JSONValue? { JSONFiles.read(path) }
func uuid() -> String { IDs.new() }

func hex(_ s: String) -> Data {
    var data = Data(); var i = s.startIndex
    while i < s.endIndex { let j = s.index(i, offsetBy: 2); data.append(UInt8(s[i..<j], radix: 16)!); i = j }
    return data
}
func latin1(_ s: String) -> Data { Data(s.unicodeScalars.map { UInt8($0.value & 0xff) }) }

/// The error an async call throws (nil when it does not throw).
func thrown<T>(_ work: () async throws -> T) async -> Error? {
    do { _ = try await work(); return nil } catch { return error }
}
func thrownSync<T>(_ work: () throws -> T) -> Error? {
    do { _ = try work(); return nil } catch { return error }
}
func XCTAssertThrowsMatching<T>(_ work: () async throws -> T, _ pattern: String, file: StaticString = #filePath, line: UInt = #line) async {
    guard let error = await thrown(work) else { XCTFail("did not throw (wanted /\(pattern)/)", file: file, line: line); return }
    XCTAssertNotNil(error.localizedDescription.range(of: pattern, options: .regularExpression), "\(error.localizedDescription) !~ /\(pattern)/", file: file, line: line)
}
func XCTAssertThrowsMatchingSync<T>(_ work: () throws -> T, _ pattern: String, file: StaticString = #filePath, line: UInt = #line) {
    guard let error = thrownSync(work) else { XCTFail("did not throw (wanted /\(pattern)/)", file: file, line: line); return }
    XCTAssertNotNil(error.localizedDescription.range(of: pattern, options: .regularExpression), "\(error.localizedDescription) !~ /\(pattern)/", file: file, line: line)
}

/// A PDF with one page per list of lines and an Info dictionary when given (test/pdf-kind.test.cjs makePdf).
func makePdf(_ pages: [[String]], info: [String: String]? = nil) -> Data {
    func escape(_ text: String) -> String { text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "(", with: "\\(").replacingOccurrences(of: ")", with: "\\)") }
    var objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    var kids: [String] = []
    for lines in pages {
        let content = "BT\n/F1 10 Tf\n12 TL\n50 780 Td\n\(lines.map { "(\(escape($0))) Tj T*" }.joined(separator: "\n"))\nET"
        objects.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents \(objects.count + 2) 0 R >>")
        kids.append("\(objects.count) 0 R")
        objects.append("<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream")
    }
    objects[1] = "<< /Type /Pages /Kids [\(kids.joined(separator: " "))] /Count \(kids.count) >>"
    if let info { objects.append("<< \(info.map { "/\($0.key) (\(escape($0.value)))" }.joined(separator: " ")) >>") }
    var body = "%PDF-1.4\n"
    var offsets: [Int] = []
    for (index, object) in objects.enumerated() { offsets.append(body.utf8.count); body += "\(index + 1) 0 obj\n\(object)\nendobj\n" }
    let xref = body.utf8.count
    body += "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n\(offsets.map { String(format: "%010d 00000 n \n", $0) }.joined())trailer\n<< /Size \(objects.count + 1) /Root 1 0 R\(info != nil ? " /Info \(objects.count) 0 R" : "") >>\nstartxref\n\(xref)\n%%EOF\n"
    return Data(body.utf8)
}

extension Projects {
    static func create(_ ctx: StoreContext, _ name: String) throws -> PublicProject { try createProject(ctx, NewProject(name: name)) }
}
