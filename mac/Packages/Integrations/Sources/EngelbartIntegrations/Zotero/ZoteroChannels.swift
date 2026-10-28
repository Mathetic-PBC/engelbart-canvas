import Foundation
import EngelbartCore

// The Zotero IPC of src/main/ipc.cjs (zotero-status, -connect, -cancel, -disconnect, -sync, -list, -open, -waiting,
// -attach) and the wiring of index.cjs (createZotero, createZoteroSync, scheduleZoteroSyncs). Events go out on EventHub
// under Electron's channel names: `engelbart:zotero` (the status with the mirror's), `engelbart:zotero-finding`
// ({ key, finding }), `engelbart:zotero-waiting` ({ key, waiting }), `engelbart:zotero-downloaded` ({ key, path }).
// Build 5: an item is named by its ref (`<key>` My Library's, `g<groupID>:<key>` a group's) everywhere.

@MainActor
public final class ZoteroChannels {
    public let zotero: ZoteroConnection?
    public let library: ZoteroSync?
    public private(set) var schedule: ZoteroSchedule?

    public init(zotero: ZoteroConnection?, library: ZoteroSync?) {
        self.zotero = zotero
        self.library = library
    }

    /// index.cjs's wiring. `dataRoot()` the open data root (the sign-in and the mirror follow it); `downloadsDir()` the
    /// Downloads folder; `onConnected` brings the focused window forward; `onDownloaded(ref, path)` opens the copy in the
    /// Stage of the window focused last and brings the app forward (it is also posted). The first sync runs 4 s after
    /// launch when connected; then every 10 minutes and on `windowFocused()`.
    public static func make(sources: ZoteroSources = ZoteroSources(environment: ProcessInfo.processInfo.environment),
                            dataRoot: @escaping () -> String?,
                            crypt: SecretCrypt = KeychainCrypt.shared,
                            http: HTTPClient = URLSessionHTTPClient.shared,
                            openExternal: @escaping (String) async throws -> Void,
                            downloadsDir: @escaping () -> String = { FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first?.path ?? (NSHomeDirectory() as NSString).appendingPathComponent("Downloads") },
                            onConnected: @escaping () -> Void = {},
                            onDownloaded: @escaping (String, String) -> Void = { _, _ in },
                            hub: EventHub = .shared,
                            startClocks: Bool = true) -> ZoteroChannels {
        let browser = try? ZoteroBrowserAuth(broker: sources.broker, http: http)
        let box = Box<ZoteroChannels?>(nil)
        let library = ZoteroSync(
            http: http, sources: sources,
            root: { dataRoot().map(ZoteroMirror.mirrorDir) },
            account: {
                guard let zotero = box.value?.zotero, let key = zotero.key() else { return nil }
                return ZoteroAccount(userID: zotero.status().userID, key: key)
            },
            onChange: { _ in if let c = box.value { hub.post("engelbart:zotero", c.status().json) } },
            onFinding: { key, finding in hub.post("engelbart:zotero-finding", ["key": .string(key), "finding": .bool(finding)]) },
            downloadsDir: downloadsDir,
            onWaiting: { key, waiting in hub.post("engelbart:zotero-waiting", ["key": .string(key), "waiting": .bool(waiting)]) },
            onDownloaded: { key, copy in
                hub.post("engelbart:zotero-downloaded", ["key": .string(key), "path": .string(copy.path)])
                onDownloaded(key, copy.path)
            })
        let zotero = ZoteroConnection(
            http: http,
            file: { dataRoot().map { join($0, "zotero.json") } },
            crypt: crypt,
            browserAuth: { browser },
            openAuthorize: openExternal,
            onConnected: {
                onConnected()
                Task { @MainActor in await library.sync() } // the library, mirrored as soon as it is connected
            },
            onChange: { _ in if let c = box.value { hub.post("engelbart:zotero", c.status().json) } },
            api: sources.api)
        let made = ZoteroChannels(zotero: zotero, library: library)
        box.value = made
        if startClocks {
            made.schedule = ZoteroSchedule(library: library, connected: { [weak made] in made?.connected() ?? false })
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak made] in
                MainActor.assumeIsolated {
                    guard let made, made.connected() else { return }
                    Task { @MainActor in await library.autoSync() }
                }
            }
        }
        return made
    }

    func connected() -> Bool { (zotero?.key()) != nil }

    /// A window came to the front: a sync when the last one ended over 2 minutes ago.
    public func windowFocused() { schedule?.focus() }

    /// The app quits: every Downloads wait ends.
    public func willQuit() { library?.stopWatching(); schedule?.stop() }

    private func zt() throws -> ZoteroConnection {
        guard let zotero else { throw ZoteroError("Zotero is not available") }
        return zotero
    }

    private func withSync(_ status: ZoteroStatus) -> ZoteroStatus {
        var out = status
        out.sync = (library != nil && status.connected) ? library!.status() : nil
        return out
    }

    public func status() -> ZoteroStatus {
        guard let zotero else { return .unavailable }
        return withSync(zotero.status())
    }

    public func connect() async throws -> ZoteroStatus { withSync(try await zt().connect()) }
    public func cancel() throws -> ZoteroStatus { withSync(try zt().cancel()) }

    public func disconnect() async throws -> ZoteroStatus {
        let status = await try zt().disconnect()
        library?.clear()
        return withSync(status)
    }

    /// Starts a sync and answers at once; its progress follows on `engelbart:zotero`.
    public func sync() throws -> ZoteroStatus {
        guard let zotero, zotero.status().connected else { throw ZoteroError("Zotero is not connected") }
        library?.startSync()
        return withSync(zotero.status())
    }

    private func zoteroRoot() -> String? {
        guard let library, let zotero, zotero.status().connected else { return nil }
        return library.rootPath()
    }

    /// A level of the library for the @ menu: My Library and each group at the top.
    public func list(_ rel: String? = nil) -> ZoteroListing {
        guard let root = zoteroRoot() else { return .error("Zotero is not connected") }
        return ZoteroMirror.listLibraries(root, jsSlice(rel ?? "", 4096))
    }

    private func parse(_ value: String) throws -> (ref: String, parsed: ZoteroRef) {
        guard value.count <= 64, let parsed = ZoteroMirror.parseRef(value) else { throw ZoteroError("item key is invalid") }
        return (value, parsed)
    }

    /// What a mention's chip opens; an item opened in the browser is waited for in Downloads (`waiting`).
    public func open(_ key: String) async throws -> ZoteroOpenTarget {
        guard zoteroRoot() != nil, let library else { return .error("Zotero is not connected") }
        let (ref, parsed) = try parse(key)
        guard let lib = library.library(parsed.group) else { return .error("Zotero is not connected") }
        let target = await ZoteroMirror.openTarget(lib.root, parsed.key, library: (parsed.group, lib.name), storageDir: lib.storageDir ?? ZoteroMirror.defaultStorage(),
                                                   download: lib.download, openAccess: lib.openAccess)
        if case .external(let url, _) = target, library.awaitDownload(ref) { return .external(url: url, waiting: true) }
        return target
    }

    public func waiting() -> [String] { zoteroRoot() != nil ? (library?.waitingFor() ?? []) : [] }

    /// A pdf dropped on a chip made the item's pdf → { path, source } or { error }.
    public func attach(_ key: String, file: String) throws -> JSONValue {
        guard zoteroRoot() != nil, let library else { return ["error": "Zotero is not connected"] }
        let (ref, _) = try parse(key)
        guard file.count <= 4096, file.hasPrefix("/") else { throw ZoteroError("file must be an absolute path") }
        do {
            guard let copy = try library.attach(ref, file) else { return ["error": "The PDF could not be kept."] }
            return ["path": .string(copy.path), "source": .string(copy.source)]
        } catch {
            let words = error.localizedDescription
            return ["error": .string(words.isEmpty ? "The PDF could not be kept." : words)]
        }
    }
}

// MARK: - what the renderer derived from these (Connections.jsx zoteroSyncLine, model/zotero.js, useZoteroStatus.js)

public struct ZoteroSyncLine: Equatable, Sendable {
    public var text: String
    public var busy: Bool
    public var error: Bool
    public var groups: String
}

public enum ZoteroChips {
    /// What the Zotero row says of the mirror → { text, busy, error, groups }, or nil.
    public static func syncLine(_ sync: ZoteroSyncStatus?) -> ZoteroSyncLine? {
        guard let sync else { return nil }
        if sync.state == "syncing" { return ZoteroSyncLine(text: "Syncing…", busy: true, error: false, groups: "") }
        let problems = sync.problems.filter { !$0.name.isEmpty }
        var groups = problems.prefix(2).map { "\($0.name): \($0.error.isEmpty ? "could not be synced." : $0.error)" }.joined(separator: " ")
        if problems.count > 2 { groups += " And \(problems.count - 2) more \(problems.count - 2 == 1 ? "group" : "groups") could not be synced." }
        if sync.state == "error" { return ZoteroSyncLine(text: sync.error.isEmpty ? "The library could not be synced." : sync.error, busy: false, error: true, groups: groups) }
        if sync.state == "synced" {
            let count = sync.groups
            return ZoteroSyncLine(text: "Synced · \(sync.items) \(sync.items == 1 ? "item" : "items")\(count > 0 ? " · \(count) \(count == 1 ? "group" : "groups")" : "")",
                                  busy: false, error: false, groups: groups)
        }
        return nil
    }

    public enum ChipAction: Equatable, Sendable { case pdf(String), external(String), error(String) }

    /// What a chip does with zotero-open's answer: a pdf opens in the paper viewer, a page in the default browser.
    public static func chipAction(_ target: ZoteroOpenTarget?, name: String = "") -> ChipAction {
        switch target {
        case .file(let path, _)? where !path.isEmpty: return .pdf(path)
        case .external(let url, _)? where re("^https?://", .caseInsensitive).test(url): return .external(url)
        case .error(let words)? where !words.isEmpty: return .error(words)
        default: return .error("\"\(name.isEmpty ? "This item" : name)\" could not be opened")
        }
    }

    /// The refs main is looking for a free copy of (`engelbart:zotero-finding`), or waiting for in Downloads
    /// (`engelbart:zotero-waiting`): a set updated by each event. Seeded with zotero-waiting's answer.
    @MainActor
    public final class RefSet: ObservableObject {
        @Published public private(set) var refs: Set<String> = []
        private var token: EventHub.Token?
        private let flag: String

        public init(channel: String, flag: String, seed: [String] = [], hub: EventHub = .shared) {
            self.flag = flag
            refs = Set(seed)
            token = hub.on(channel) { [weak self] payload in
                MainActor.assumeIsolated {
                    guard let self, let key = payload["key"]?.string else { return }
                    let on = payload[self.flag]?.truthy ?? false
                    if self.refs.contains(key) == on { return }
                    if on { self.refs.insert(key) } else { self.refs.remove(key) }
                }
            }
        }

        public static func finding(hub: EventHub = .shared) -> RefSet { RefSet(channel: "engelbart:zotero-finding", flag: "finding", hub: hub) }
        public static func waiting(seed: [String] = [], hub: EventHub = .shared) -> RefSet { RefSet(channel: "engelbart:zotero-waiting", flag: "waiting", seed: seed, hub: hub) }
    }
}
