import EngelbartCore
import Foundation

/// The Store's resource bundle (fixtures, welcome.png, the pglite dump script) in a build folder and in the signed app:
/// `Bundle.module` alone looks at the .app's root, which a signed app cannot hold (see Core's ResourceBundle).
enum StoreResources {
    static var bundle: Bundle { ResourceBundle.named("Store_EngelbartStore", fallback: Bundle.module) }
}
