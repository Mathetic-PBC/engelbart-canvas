import Foundation

/// One Engelbart per user-data folder (index.cjs:599-603 `requestSingleInstanceLock`, `second-instance` → showWindow). The
/// first copy holds an exclusive `flock` on `<userData>/SingleInstance.lock` for as long as it runs; a second launch
/// cannot take it, tells the first (a distributed notification named for the folder) to show a window, and exits.
public final class SingleInstance {
    private var fd: Int32 = -1
    public let lockFile: URL
    public let notification: Notification.Name
    private var observer: NSObjectProtocol?

    public init(userData: URL) {
        lockFile = userData.appendingPathComponent("SingleInstance.lock")
        // The folder's path in the name, so copies on different folders never hear each other.
        let key = userData.standardizedFileURL.path.data(using: .utf8)!.base64EncodedString()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        notification = Notification.Name("com.mathetic.engelbart.swift.second-instance.\(key)")
    }

    /// Takes the lock. False: another copy holds it.
    public func acquire() -> Bool {
        try? FileManager.default.createDirectory(at: lockFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        fd = open(lockFile.path, O_CREAT | O_RDWR, 0o644)
        guard fd >= 0 else { return true } // a folder that cannot be written: run anyway, as Electron does without its lock file
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd); fd = -1
            return false
        }
        let pid = "\(getpid())\n"
        ftruncate(fd, 0)
        _ = pid.withCString { write(fd, $0, strlen($0)) }
        return true
    }

    /// The second launch: asks the first to show a window.
    public func announceSecondLaunch() {
        DistributedNotificationCenter.default().postNotificationName(notification, object: nil, userInfo: nil, deliverImmediately: true)
    }

    /// The first copy: `show` runs on the main queue whenever another launch was turned away.
    public func onSecondLaunch(_ show: @escaping () -> Void) {
        observer = DistributedNotificationCenter.default().addObserver(forName: notification, object: nil, queue: .main) { _ in show() }
    }

    deinit {
        if let observer { DistributedNotificationCenter.default().removeObserver(observer) }
        if fd >= 0 { flock(fd, LOCK_UN); close(fd) }
    }
}
