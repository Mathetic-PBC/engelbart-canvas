import EngelbartUI
import SwiftUI

/// Delete on a project card asks here first (as a Build's Reject does, BuildReject.jsx; Home.jsx DeleteProject). Escape
/// or a press outside cancels, unless it is already deleting.
struct DeleteProjectDialog: View {
    let name: String
    let busy: Bool
    let onConfirm: () -> Void
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.25)
                .contentShape(Rectangle())
                .onTapGesture { if !busy { onClose() } }
            VStack(alignment: .leading, spacing: 6) {
                Text("Delete \(name)?").textStyle(TextStyle(16, weight: 600, lineHeight: 1.4)).foregroundStyle(Color(Palette.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text("Its projects and notes go to the trash for 7 days. Your code folder is not touched.")
                    .textStyle(TextStyle(14, lineHeight: 1.6)).foregroundStyle(Color(Palette.mut))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    Button(action: onClose) {
                        Text("Cancel").dialogButtonFace(fill: Palette.bg, text: Palette.mut, border: NSColor(hex: "#e5e5e5"))
                    }
                    .buttonStyle(.plain)
                    .hover(.ink, radius: Radius.sm)
                    .disabled(busy)
                    .probe("delete-project-cancel", press: onClose)
                    Button(action: onConfirm) {
                        Text(busy ? "Deleting…" : "Delete").dialogButtonFace(fill: Palette.del, text: Palette.onAcc, border: nil)
                    }
                    .buttonStyle(.plain)
                    .hover(.dim, radius: Radius.sm)
                    .disabled(busy)
                    .opacity(busy ? 0.6 : 1)
                    .probe("delete-project-confirm", press: busy ? nil : onConfirm)
                }
                .padding(.top, 12)
            }
            .padding(20)
            .frame(maxWidth: 400)
            .background(RoundedRectangle(cornerRadius: Radius.lg).fill(Color(Palette.bg)))
            .shadow(color: Color.black.opacity(0.18), radius: 20, x: 0, y: 10)
            .rise(0.16)
            .accessibilityElement(children: .contain)
            .probe("delete-project-dialog")
            .padding(24)
        }
        .background(KeyMonitor(keyCode: 53) { if !busy { onClose() }; return true })
    }
}

extension View {
    /// The dialog's buttons: ≥34 tall, padding 9 16, radius 8, 500 13px.
    func dialogButtonFace(fill: NSColor, text: NSColor, border: NSColor?) -> some View {
        self.font(Font(Fonts.sans(13, weight: 500)))
            .foregroundStyle(Color(text))
            .padding(EdgeInsets(top: 9, leading: 16, bottom: 9, trailing: 16))
            .frame(minHeight: 34)
            .background(RoundedRectangle(cornerRadius: Radius.sm).fill(Color(fill)))
            .overlay(border.map { RoundedRectangle(cornerRadius: Radius.sm).strokeBorder(Color($0), lineWidth: 1) })
            .contentShape(Rectangle())
    }
}
