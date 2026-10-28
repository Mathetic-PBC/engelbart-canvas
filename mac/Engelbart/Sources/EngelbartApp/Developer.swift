import Foundation

/// Test mode (`<root>/test`, the Test pill and Settings ▸ Test data) is for developing Engelbart, never for the app people
/// download (src/main/developer.cjs, 2026-09-28). A copy has it when it runs from a checkout (here: not inside an .app,
/// `swift run`) or when it was packaged from a developer build: `mac/scripts/bundle.sh` with `ENGELBART_DEVELOPER=1`
/// writes `Contents/Resources/build.json` `{ "developer": true }`. Every other bundle has none. `ENGELBART_TEST_MODE=off`
/// takes it away from a developer's copy too, to see the app as it ships; nothing turns it on in a copy that has none.
public enum Developer {
    public static let buildFile = "build.json"

    /// `packaged`: running from an .app bundle; `resources`: the bundle's Resources folder (where build.json is).
    public static func hasTestMode(packaged: Bool, resources: URL?, environment: [String: String] = [:]) -> Bool {
        if environment["ENGELBART_TEST_MODE"] == "off" { return false }
        if !packaged { return true }
        guard let resources,
              let data = try? Data(contentsOf: resources.appendingPathComponent(buildFile)),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["developer"] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return value.boolValue // `true` itself: not "true", not 1
    }

    /// This process: packaged when its main bundle is an .app.
    public static var current: Bool {
        hasTestMode(packaged: Bundle.main.bundleURL.pathExtension == "app", resources: Bundle.main.resourceURL,
                    environment: ProcessInfo.processInfo.environment)
    }
}
