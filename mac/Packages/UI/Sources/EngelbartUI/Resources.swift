import Foundation
// ResourceBundle lives in Core (every package needs it, not only those that depend on UI). Re-exported so the packages
// that reached it through EngelbartUI keep compiling unchanged.
@_exported import EngelbartCore

extension ResourceBundle {
    /// EngelbartUI's own resources (fonts, images, icons).
    public static var ui: Bundle { named("UI_EngelbartUI", fallback: Bundle.module) }
}
