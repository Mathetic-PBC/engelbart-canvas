import EngelbartUI
import SwiftUI

// The title-bar helpers (`.titleBar()`, `.titleLead()`, WindowChrome) live in EngelbartUI so wave-2 screens can use them.

/// The header every placeholder screen draws until its package plugs in: 54 tall, dragging the window, "Engelbart" after
/// the traffic lights.
struct PlaceholderHeader: View {
    let title: String
    var body: some View {
        HStack(spacing: 0) {
            Text(title).textStyle(.brand).foregroundStyle(Color(Palette.ink))
            Spacer()
        }
        .titleLead()
        .padding(.leading, 18)
        .frame(height: TitleBarMetrics.header)
        .frame(maxWidth: .infinity)
        .titleBar()
    }
}
