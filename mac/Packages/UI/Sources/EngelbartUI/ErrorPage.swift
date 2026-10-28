import SwiftUI

/// A screen that failed reads as a message, not a blank window (ui/ErrorBoundary.jsx): the red micro-caps label, the
/// message (500 17px), the details in a mono box, and Reload. SwiftUI has no render exceptions to catch; a screen that
/// cannot load (a slot whose package threw, a model that failed to open) shows this in its place.
public struct ErrorPage: View {
    let title: String
    let message: String
    let details: String
    let onReload: (() -> Void)?

    public init(title: String = "Renderer error", message: String, details: String = "", onReload: (() -> Void)? = nil) {
        self.title = title; self.message = message; self.details = details; self.onReload = onReload
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(title).textStyle(.microcap).foregroundStyle(Color(Palette.del))
                Text(message).font(Fonts.swiftUISans(17, weight: 500)).tracking(-0.2).foregroundStyle(Color(Palette.ink)).padding(.top, 10)
                if !details.isEmpty {
                    Text(details)
                        .font(Fonts.swiftUIMono(12)).lineSpacing(12 * 0.6 - 3)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14))
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color(Palette.gray50)))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(Palette.bd), lineWidth: 1))
                        .padding(.top, 14)
                }
                if let onReload {
                    EButton("Reload", .outline, size: .sm, action: onReload).padding(.top, 14)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 64, leading: 24, bottom: 24, trailing: 24))
        }
        .background(Color.white)
    }
}
