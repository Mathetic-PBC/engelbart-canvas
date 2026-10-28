import Foundation

// How one address is spelled wherever a page is matched or filed (src/shared/address-key.cjs): "is it open already" for
// the Stage's tabs and the tabs the host keeps (state.json `stages`), which library row a page is and where its ink is
// kept. The Store has its own copy (address-key is shared); the two must agree, as the Electron tests hold them to.

public enum StageAddressKey {
    private static let tracking = SRx(#"^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref)$"#, "i")

    /// A query without its tracking parameters, the rest as written (not re-encoded): '' when none is left.
    static func cleanSearch(_ search: String) -> String {
        let body = search.hasPrefix("?") ? String(search.dropFirst()) : search
        let kept = body.components(separatedBy: "&").filter { part in
            guard !part.isEmpty else { return false }
            var name = part.components(separatedBy: "=").first ?? ""
            name = (name.replacingOccurrences(of: "+", with: " ").removingPercentEncoding) ?? name
            return !tracking.test(name)
        }
        return kept.isEmpty ? "" : "?" + kept.joined(separator: "&")
    }

    /// http or https, www. or not, a trailing slash, a #fragment, tracking parameters: one address. Another scheme loses
    /// its #fragment only; anything that is no URL is as it came.
    public static func addressKey(_ value: String?) -> String {
        let v = JSStr.trim(value ?? "")
        if v.isEmpty || v == "about:blank" { return "" }
        guard let u = JSURL(v) else { return v }
        if u.protocol != "http:" && u.protocol != "https:" { return SRx("#.*$").replace(u.href, with: "", global: false) }
        let host = SRx(#"^www\."#).replace(u.host.lowercased(), with: "", global: false)
        let path = SRx(#"\/+$"#).replace(u.pathname, with: "", global: false)
        return host + path + cleanSearch(u.search)
    }

    private static let previewHost = SRx(#"(?:^|\.)e2b\.(?:app|dev)$"#, "i")

    /// Whether `value` is a local server or a sandbox preview: localhost, 127.x, ::1, 0.0.0.0, *.localhost, *.e2b.app.
    public static func isPreviewAddress(_ value: String?) -> Bool {
        guard let u = JSURL(JSStr.trim(value ?? "")), u.protocol == "http:" || u.protocol == "https:" else { return false }
        var host = u.hostname.lowercased()
        if host.hasPrefix("[") { host.removeFirst() }
        if host.hasSuffix("]") { host.removeLast() }
        if host.hasSuffix(".") { host.removeLast() }
        return host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "0.0.0.0"
            || SRx(#"^127(?:\.\d{1,3}){3}$"#).test(host) || previewHost.test(host)
    }
}

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

// Web addresses as mentions name them (src/renderer/model/web-name.js). (Doc ports the same file; the Stage keeps its own
// so it never waits on another package.)
public enum StageWebName {
    public static func isAddress(_ value: String?) -> Bool { SRx(#"^https?:\/\/\S+$"#, "i").test(JSStr.trim(value ?? "")) }
    static func key(_ value: String?) -> String {
        var s = JSStr.trim(value ?? "")
        s = SRx(#"^https?:\/\/"#, "i").replace(s, with: "", global: false)
        s = SRx(#"^www\."#, "i").replace(s, with: "", global: false)
        s = SRx("#.*$").replace(s, with: "", global: false)
        s = SRx(#"\/+$"#).replace(s, with: "", global: false)
        return s.lowercased()
    }
    public static func sameAddress(_ a: String?, _ b: String?) -> Bool { let k = key(a); return !k.isEmpty && k == key(b) }
    public static func webLabel(_ url: String?) -> String {
        let raw = JSStr.trim(url ?? "")
        var shown: String
        if let u = JSURL(raw), !u.hostname.isEmpty {
            let path = u.pathname.removingPercentEncoding ?? u.pathname
            shown = SRx(#"^www\."#, "i").replace(u.host, with: "", global: false) + SRx(#"\/+$"#).replace(path, with: "", global: false)
        } else {
            shown = SRx(#"\/+$"#).replace(SRx(#"[?#].*$"#).replace(SRx(#"^https?:\/\/"#, "i").replace(raw, with: "", global: false), with: "", global: false), with: "", global: false)
        }
        shown = JSStr.trim(SRx(#"\s+"#).replace(SRx(#"[\[\]\n]"#).replace(shown, with: ""), with: " "))
        if JSStr.len(shown) > 60 { return JSStr.slice(shown, 0, 59) + "…" }
        return shown.isEmpty ? "Untitled page" : shown
    }
    public static func webName(_ name: String?, _ url: String?) -> String {
        let n = JSStr.trim(SRx(#"\s+"#).replace(SRx(#"[\[\]]"#).replace(name ?? "", with: ""), with: " "))
        if !n.isEmpty && !isAddress(n) && !(url.map { sameAddress(n, $0) } ?? false) { return JSStr.slice(n, 0, 200) }
        return webLabel((url?.isEmpty == false) ? url : n)
    }
}
