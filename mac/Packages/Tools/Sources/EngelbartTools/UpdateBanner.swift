import AppKit
import EngelbartCore
import EngelbartUI
import SwiftUI

// New versions (MATH-43, src/renderer/ui/UpdateBanner.jsx): what the updater is doing, in every window and on every
// screen. While the install command downloads the new version, how far it is (the bar runs back and forth until curl gives
// a percentage); once it is ready, Restart to Update or Later. Later hides it in every window until the state changes; the
// Engelbart menu keeps Restart to Update, and the new version is installed at the next quit. Anything else shows nothing.
// Styled as the app's error toast, in the other corner. On the workspace screen it keeps to the document's bottom-right
// corner, clear of the Stage (a page there is a native view); with the Stage full screen there is no document, and it sits
// in the window's corner.

let EDGE_RIGHT: CGFloat = 24
let EDGE_BOTTOM: CGFloat = 18

/// Whether a snapshot has anything to show.
public func showsUpdate(_ update: UpdateSnapshot?) -> Bool {
    guard let update, update.enabled else { return false }
    return update.state == "installing" || (update.state == "ready" && !update.dismissed)
}

/// What the banner says, for a snapshot; nil when it shows nothing.
public struct UpdateNoticeContent: Equatable, Sendable {
    public enum Kind: String, Sendable { case installing, ready }
    public var kind: Kind
    public var text: String
    /// Installing: the bar's width 0…100, or nil while it waits for curl's first percentage (the sliding bar).
    public var percent: Int?

    public init?(_ update: UpdateSnapshot?) {
        guard showsUpdate(update), let update else { return nil }
        let name = update.version.map { "Engelbart \($0)" } ?? "Engelbart"
        if update.state == "installing" {
            kind = .installing
            percent = update.percent
            text = "Downloading \(name)…\(update.percent.map { " \($0)%" } ?? "")"
        } else {
            kind = .ready
            percent = nil
            text = "\(name) is ready."
        }
    }
}

/// Where the banner goes: the document column's bottom-right corner on the workspace screen, else the window's.
/// `column` is in the window's content coordinates with the origin top-left (as getBoundingClientRect).
public func updateBannerCorner(window: CGSize, column: CGRect?) -> (right: CGFloat, bottom: CGFloat) {
    guard let r = column, r.width >= 1, r.height >= 1 else { return (EDGE_RIGHT, EDGE_BOTTOM) }
    return (max(EDGE_RIGHT, (window.width - r.maxX + 16).rounded()), max(EDGE_BOTTOM, (window.height - r.maxY + EDGE_BOTTOM).rounded()))
}

/// The banner's state in one window: the state now, then every change (`engelbart:update`); an event that comes before the
/// first answer wins. Later hides it here at once and asks the updater, which hides it in every window.
@MainActor
public final class UpdateBannerModel: ObservableObject {
    @Published public private(set) var update: UpdateSnapshot?
    let restartAction: () -> Void
    let laterAction: () -> Void
    var token: EventHub.Token?
    let hub: EventHub

    /// `current`: `update-state`; `restart` / `later`: `update-restart` / `update-later`.
    public init(current: @escaping () -> UpdateSnapshot?, restart: @escaping () -> Void, later: @escaping () -> Void, hub: EventHub = .shared) {
        self.restartAction = restart
        self.laterAction = later
        self.hub = hub
        token = hub.on(ToolsEvents.update) { [weak self] payload in
            guard let next = UpdateSnapshot(json: payload) else { return }
            MainActor.assumeIsolated { self?.update = next }
        }
        if update == nil { update = current() }
    }

    /// Over an `Updates` (the app's one updater).
    public convenience init(updates: Updates, hub: EventHub = .shared) {
        self.init(current: { [weak updates] in updates?.snapshot() ?? .disabled }, restart: { [weak updates] in updates?.restart() },
                  later: { [weak updates] in updates?.later() }, hub: hub)
    }

    deinit { if let token { hub.off(token) } }

    public var content: UpdateNoticeContent? { UpdateNoticeContent(update) }

    public func restart() { restartAction() }

    public func later() {
        if var current = update { current.dismissed = true; update = current }
        laterAction()
    }
}

/// The notice itself (UpdateNotice).
public struct UpdateNoticeView: View {
    let content: UpdateNoticeContent
    let onRestart: () -> Void
    let onLater: () -> Void

    public init(content: UpdateNoticeContent, onRestart: @escaping () -> Void, onLater: @escaping () -> Void) {
        self.content = content; self.onRestart = onRestart; self.onLater = onLater
    }

    public var body: some View {
        Group {
            switch content.kind {
            case .installing:
                VStack(alignment: .leading, spacing: 6) {
                    Text(content.text).font(Font(Fonts.sans(12.5))).foregroundStyle(Color(Palette.ink))
                    ProgressTrack(percent: content.percent)
                }
                .padding(.horizontal, 12).padding(.vertical, 7)
                .frame(width: 260, alignment: .leading)
            case .ready:
                HStack(spacing: 4) {
                    Text(content.text).font(Font(Fonts.sans(12.5))).foregroundStyle(Color(Palette.ink)).padding(.trailing, 6)
                    bannerButton("Restart to Update", weight: 500, rest: Palette.ink, help: "Quit and open again as the new version", action: onRestart)
                    bannerButton("Later", weight: 400, rest: Palette.fnt, help: "It is installed the next time you quit", action: onLater)
                }
                .padding(EdgeInsets(top: 5, leading: 12, bottom: 5, trailing: 6))
            }
        }
        .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(Palette.panel)))
        .overlay(RoundedRectangle(cornerRadius: Radius.sm).stroke(Color(Palette.bd), lineWidth: 1))
        .toolsRise(0.16)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.updatesFrequently)
    }

    func bannerButton(_ title: String, weight: Int, rest: NSColor, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Font(Fonts.sans(12.5, weight: weight))).lineLimit(1).fixedSize().padding(.horizontal, 6).padding(.vertical, 3)
        }
        .buttonStyle(.plain)
        .background(RoundedRectangle(cornerRadius: 5).fill(Color(Palette.panel)))
        .toolsHover(.ink, rest: rest, radius: 5)
        .help(help)
    }
}

/// The 2 pt track (#eaeaea, radius 1) and its #0070f3 bar: N% wide (200 ms linear), or a third of it sliding −100% → 300%
/// over 1.2 s ease-in-out until curl gives a percentage (`update-slide`).
struct ProgressTrack: View {
    let percent: Int?
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(Color(Palette.bd))
                if let percent {
                    Rectangle().fill(Color(Palette.acc)).frame(width: geo.size.width * CGFloat(percent) / 100)
                        .animation(.linear(duration: 0.2), value: percent)
                } else {
                    TimelineView(.animation) { context in
                        let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
                        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
                        let width = geo.size.width / 3
                        Rectangle().fill(Color(Palette.acc)).frame(width: width).offset(x: width * CGFloat(-1 + 4 * eased))
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 1))
        }
        .frame(height: 2)
    }
}

/// The banner placed in a window: give it the window's content size and, on the workspace screen, the document column's
/// frame (top-left origin); it follows both as they change.
public struct UpdateBanner: View {
    @ObservedObject var model: UpdateBannerModel
    let column: CGRect?

    public init(model: UpdateBannerModel, column: CGRect? = nil) { self.model = model; self.column = column }

    public var body: some View {
        GeometryReader { geo in
            if let content = model.content {
                let corner = updateBannerCorner(window: geo.size, column: column)
                // max-width: calc(100vw - 48px): the spacer keeps 24 pt on the left however narrow the window.
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    HStack(spacing: 0) {
                        Spacer(minLength: 24)
                        UpdateNoticeView(content: content, onRestart: model.restart, onLater: model.later)
                    }
                }
                .padding(.trailing, corner.right)
                .padding(.bottom, corner.bottom)
            }
        }
        .allowsHitTesting(model.content != nil)
    }
}
