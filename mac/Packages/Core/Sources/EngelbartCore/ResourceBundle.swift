import Foundation

/// Where a SwiftPM resource bundle is (moved to Core 2026-10-28 so packages without UI — Store, Connect — can use it), in a build folder and in the signed app alike.
///
/// SwiftPM's generated `Bundle.module` looks for `<Package>_<Module>.bundle` next to the executable's bundle
/// (`Engelbart.app/UI_EngelbartUI.bundle`, the .app's root) and then in the absolute build folder it was compiled in. A
/// signed app cannot hold anything at its root ("unsealed contents present in the bundle root"), so
/// `mac/scripts/bundle.sh` puts every resource bundle in `Contents/Resources`, where only this lookup finds it. The build
/// folder fallback (`Bundle.module`) is touched only when nothing else matched, since it stops the process when it fails.
public enum ResourceBundle {
    private static var cache: [String: Bundle] = [:]
    private static let lock = NSLock()

    /// `name`: the bundle's name without `.bundle`, e.g. `UI_EngelbartUI`. `fallback`: the module's own `Bundle.module`,
    /// passed as an autoclosure so it is only evaluated when the app's folders do not have it.
    public static func named(_ name: String, fallback: @autoclosure () -> Bundle) -> Bundle {
        lock.lock()
        if let hit = cache[name] { lock.unlock(); return hit }
        lock.unlock()
        let file = "\(name).bundle"
        var candidates: [URL] = []
        if let resources = Bundle.main.resourceURL { candidates.append(resources.appendingPathComponent(file)) }
        candidates.append(Bundle.main.bundleURL.appendingPathComponent(file))
        if let exe = Bundle.main.executableURL?.deletingLastPathComponent() { candidates.append(exe.appendingPathComponent(file)) }
        for url in candidates {
            if let bundle = Bundle(url: url) { store(name, bundle); return bundle }
        }
        let bundle = fallback()
        store(name, bundle)
        return bundle
    }

    private static func store(_ name: String, _ bundle: Bundle) {
        lock.lock(); cache[name] = bundle; lock.unlock()
    }

}
