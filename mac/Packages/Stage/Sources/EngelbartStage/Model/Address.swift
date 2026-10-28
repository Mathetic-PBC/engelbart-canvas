import Foundation

// What the Stage's address means (src/renderer/model/address.js): nothing, a sandbox, a file, a page on disk, a local
// server, the web, or words to search for. Local servers speak http unless the address says otherwise; the web gets
// https; anything that names no host is a Google search. Whether a typed path is an html file to render is the host's to
// say (resolve-page-file): a path here is a `file` until it answers, and a `disk` page once it has a file: address.

public struct AddressKind: Equatable, Sendable {
    public enum Kind: String, Sendable { case blank, sandbox, disk, file, local, web }
    public var kind: Kind
    /// The address to load (disk, local, web).
    public var url: String?
    /// A typed path (file).
    public var path: String?
    /// A sandbox's name.
    public var name: String?
}

public enum StageAddress {
    /// The window event by which the rest of the app (a link in the terminal) asks for a page in a new tab: { url }.
    public static let openInBrowserEvent = "engelbart:open-in-browser"

    private static let fileRx = SRx(#"^(\.{0,2}\/|~\/|\/)|^[\w.-]+\.(md|txt|py|js|ts|json|csv|html|css|pdf)$"#, "i")
    private static let schemeRx = SRx(#"^https?:\/\/"#, "i")
    private static let diskRx = SRx(#"^file:\/\/"#, "i")
    static let search = "https://www.google.com/search?q="

    /// A name the web could resolve: dotted with a lettered last label, or an IP address.
    static func isWebHost(_ host: String) -> Bool {
        if SRx(#"^\[[0-9a-f:.]+\]$"#, "i").test(host) || SRx(#"^\d{1,3}(\.\d{1,3}){3}$"#).test(host) { return true }
        return SRx(#"^([a-z0-9-]+\.)+(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,}$"#, "i").test(host)
    }

    /// This machine, the local network, or a bare name with a port (`devbox:8080`).
    public static func isLocalHost(_ host: String, hasPort: Bool) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h.hasSuffix(".localhost") || h.hasSuffix(".local") || h == "[::1]" || h == "0.0.0.0" { return true }
        if SRx(#"^127(\.\d{1,3}){3}$"#).test(h) || SRx(#"^10(\.\d{1,3}){3}$"#).test(h) || SRx(#"^192\.168(\.\d{1,3}){2}$"#).test(h) || SRx(#"^169\.254(\.\d{1,3}){2}$"#).test(h) { return true }
        if SRx(#"^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$"#).test(h) { return true }
        return hasPort && SRx(#"^[a-z0-9-]+$"#).test(h)
    }

    public static func kindOf(_ input: String?) -> AddressKind {
        let u = JSStr.trim(input ?? "")
        if u.isEmpty || u == "about:blank" { return AddressKind(kind: .blank) }
        if SRx(#"^sandbox:"#, "i").test(u) {
            let name = SRx(#"^sandbox:\/*"#, "i").replace(u, with: "", global: false)
            return AddressKind(kind: .sandbox, name: name.isEmpty ? "sandbox" : name)
        }
        if diskRx.test(u) { return AddressKind(kind: .disk, url: u) }
        if fileRx.test(u) { return AddressKind(kind: .file, path: u) }
        if let port = SRx(#"^:?(\d{2,5})(\/.*)?$"#).match(u) {
            return AddressKind(kind: .local, url: "http://localhost:\(port[1] ?? "")\(port[2] ?? "")")
        }
        let scheme = schemeRx.match(u).map { $0.str.lowercased() } ?? ""
        let afterScheme = JSStr.slice(u, JSStr.len(scheme))
        var authority = SRx(#"[/?#]"#).match(afterScheme).map { JSStr.slice(afterScheme, 0, $0.index) } ?? afterScheme
        authority = SRx(#"^[^@]*@"#).replace(authority, with: "", global: false)
        let host: String
        if authority.hasPrefix("[") {
            let close = JSStr.indexOf(authority, "]")
            host = JSStr.slice(authority, 0, close + 1)
        } else {
            host = authority.components(separatedBy: ":").first ?? ""
        }
        let hasPort = SRx(#":\d+$"#).test(authority)
        if isLocalHost(host, hasPort: hasPort) {
            let rest = SRx(#"^0\.0\.0\.0(?=[:/?#]|$)"#).replace(afterScheme, with: "localhost", global: false)
            return AddressKind(kind: .local, url: "\(scheme.isEmpty ? "http://" : scheme)\(rest)")
        }
        if !scheme.isEmpty { return AddressKind(kind: .web, url: u) }
        if SRx(#"\s"#).test(u) || !isWebHost(host) { return AddressKind(kind: .web, url: search + JSStr.encodeURIComponent(u)) }
        return AddressKind(kind: .web, url: "https://\(u)")
    }

    /// The address as shown: without its scheme when typing it back would lead to the same place.
    public static func stripScheme(_ u: String?) -> String {
        guard let u, !u.isEmpty, u != "about:blank" else { return "" }
        if diskRx.test(u) {
            let rest = SRx(#"^[^/]*"#).replace(diskRx.replace(u, with: "", global: false), with: "", global: false)
            return JSStr.decodeURIComponent(rest) ?? u
        }
        let bare = SRx(#"^([^/?#]+)\/$"#).replace(schemeRx.replace(u, with: "", global: false), with: "$1", global: false)
        let back = kindOf(bare).url
        if let back, back == u || "\(back)/" == u { return bare }
        return u
    }
}
