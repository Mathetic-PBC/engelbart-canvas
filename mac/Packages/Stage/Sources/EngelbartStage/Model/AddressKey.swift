import Foundation
import EngelbartDoc

// How one address is spelled wherever a page is matched or filed (src/shared/address-key.cjs): "is it open already" for
// the Stage's tabs and the tabs the host keeps (state.json `stages`), which library row a page is and where its ink is
// kept. The Store has its own copy (address-key is shared); the two must agree, as the Electron tests hold them to.

// Every website opens on the Stage (2026-09-29), GitHub's included. Signing in to GitHub is the exception: its pages go
// to the person's default browser, where their login, saved passwords and passkeys already are (src/shared/github.cjs).
public enum GitHubPages {
    static let hosts: Set<String> = ["github.com", "www.github.com", "gist.github.com"]
    static let signIn = [
        SRx(#"^\/(login|logout|session|sessions|signup|join|password_reset)(\/|$)"#),
        SRx(#"^\/login\/(oauth|device)(\/|$)"#),
        SRx(#"^\/auth(\/|$)"#),
        SRx(#"^\/apps\/[^/]+\/installations(\/|$)"#),
        SRx(#"^\/settings\/(installations|connections\/applications|apps\/authorizations)(\/|$)"#),
    ]
    /// The cookies that say who is signed in to GitHub.
    public static let sessionCookies = ["user_session", "__Host-user_session_same_site"]

    public static func isSignIn(_ value: String?) -> Bool {
        guard let url = JSURL(value ?? ""), url.protocol == "https:" || url.protocol == "http:", hosts.contains(url.hostname),
              url.username.isEmpty, url.password.isEmpty else { return false }
        return signIn.contains { $0.test(url.pathname) }
    }

    /// A GitHub page (not a sign-in page) redirected to GitHub's /login: GitHub no longer takes the sign-in held.
    public static func endedSession(from: String?, to: String?) -> Bool {
        guard let page = JSURL(from ?? ""), let login = JSURL(to ?? ""), page.protocol == "https:", hosts.contains(page.hostname),
              !isSignIn(from) else { return false }
        return isSignIn(to) && login.hostname == "github.com" && SRx(#"\/+$"#).replace(login.pathname, with: "", global: false) == "/login"
    }
}

