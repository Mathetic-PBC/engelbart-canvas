import Foundation

// Web addresses as mentions name them (src/renderer/model/web-name.js, 2026-10-17). A page's title can be its address: a
// mention never carries that: a name that is the address, with or without its scheme, becomes the address's host and path.

public enum WebName {
    /// Whether `value` is a web address as it stands.
    public static func isAddress(_ value: String?) -> Bool { Rx(#"^https?:\/\/\S+$"#, "i").test((value ?? "").trimmed) }

    static func addressKey(_ value: String?) -> String {
        var s = (value ?? "").trimmed
        s = Rx(#"^https?:\/\/"#, "i").replace(s, with: "")
        s = Rx(#"^www\."#, "i").replace(s, with: "")
        s = Rx(#"#.*$"#).replace(s, with: "")
        s = Rx(#"\/+$"#).replace(s, with: "")
        return s.lowercased()
    }

    /// Whether two addresses are the same page: scheme, `www.`, a trailing slash and the fragment aside.
    public static func sameAddress(_ a: String?, _ b: String?) -> Bool { let k = addressKey(a); return !k.isEmpty && k == addressKey(b) }

    /// An address as a mention shows it: host and path, no scheme, `www.`, query, fragment or trailing slash; cut at 60.
    public static func webLabel(_ url: String?) -> String {
        let raw = (url ?? "").trimmed
        var shown: String
        if let u = URLComponents(string: raw), let scheme = u.scheme, !scheme.isEmpty, let host = u.percentEncodedHost, !host.isEmpty || scheme == "file" {
            var path = u.percentEncodedPath
            if path.isEmpty && (scheme == "http" || scheme == "https") { path = "/" }
            let decoded = path.decodeURI ?? path
            let port = u.port.map { ":\($0)" } ?? ""
            shown = Rx(#"^www\."#, "i").replace(host.lowercased() + port, with: "") + Rx(#"\/+$"#).replace(decoded, with: "")
        } else {
            shown = Rx(#"^https?:\/\/"#, "i").replace(raw, with: "")
            shown = Rx(#"[?#].*$"#).replace(shown, with: "")
            shown = Rx(#"\/+$"#).replace(shown, with: "")
        }
        shown = Rx(#"[\[\]\n]"#).replace(shown, with: "")
        shown = Rx(#"\s+"#).replace(shown, with: " ").trimmed
        if shown.len > 60 { return shown.slice(0, 59) + "…" }
        return shown.isEmpty ? "Untitled page" : shown
    }

    /// The name a web page is mentioned by: `name` (its title), unless it is missing or is its address.
    public static func webName(_ name: String?, _ url: String?) -> String {
        let n = Rx(#"\s+"#).replace(Rx(#"[\[\]]"#).replace(name ?? "", with: ""), with: " ").trimmed
        if !n.isEmpty && !isAddress(n) && !(url.map { !$0.isEmpty && sameAddress(n, $0) } ?? false) { return n.slice(0, 200) }
        return webLabel((url?.isEmpty ?? true) ? n : url)
    }
}
