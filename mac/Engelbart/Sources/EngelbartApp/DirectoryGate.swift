import EngelbartUI
import SwiftUI

/// The project exists but does not know where its code lives: nothing else works until it does (App.jsx DirectoryGate,
/// 2026-09-18). A modal over the blurred, inert workspace.
struct DirectoryGate: View {
    let project: ProjectTree.Project
    let error: String
    let pickFolder: () async -> String?
    let onChosen: (String) async -> Void
    let onHome: () -> Void
    @State private var busy = false

    var body: some View {
        ZStack {
            Color(Palette.veilLight).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Where does this project's code live?")
                        .textStyle(TextStyle(20, weight: 500, lineHeight: 1.3, tracking: -0.2))
                        .foregroundStyle(Color(Palette.ink))
                    if let missing = project.directoryMissing, !missing.isEmpty {
                        Text("\(missing) is no longer there.")
                            .font(Fonts.swiftUIMono(13)).lineSpacing(13 * 0.6 - 4)
                            .foregroundStyle(Color(Palette.del))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                HStack(spacing: 14) {
                    EButton(busy ? "Choosing…" : "Choose folder…", .blue) { choose() }
                        .opacity(busy ? 0.6 : 1)
                        .disabled(busy)
                        .keyboardShortcut(.defaultAction)
                        .driveID("directory-gate-choose")
                    EButton("All projects", .ghost, action: onHome).driveID("directory-gate-home")
                }
                if !error.isEmpty {
                    Text(error).textStyle(TextStyle(12.5, lineHeight: 1.5)).foregroundStyle(Color(Palette.del))
                }
            }
            .padding(28)
            .frame(maxWidth: 480, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(Palette.bd2), lineWidth: 1))
            .compositingGroup().shadow(color: .black.opacity(0x1f / 255.0), radius: 20, x: 0, y: 12)
            .rise(0.2)
            .padding(24)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Choose the project's code directory")
            .accessibilityAddTraits(.isModal)
            .driveID("directory-gate")
        }
    }

    private func choose() {
        guard !busy else { return }
        busy = true
        Task {
            if let chosen = await pickFolder() { await onChosen(chosen) }
            busy = false
        }
    }
}
