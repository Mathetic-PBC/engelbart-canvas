import EngelbartCore
import EngelbartUI
import SwiftUI

// The guided setup (2026-10-10; port of src/renderer/ui/GuidedSetup.jsx): a new user's onboarding run for someone who has
// projects already, over what they have. Started inside a project (mode 'guided') its screens have no Create, and after
// the last one that project gets a Welcome workspace showing the walkthrough, with what the setup added as its context;
// running it again adds another. Started from all projects (mode 'new') it ends in a new project. Either way nothing they
// had is removed, and "Engelbart" in its top left goes back where it was started. Offered once by GuidedSetupOffer (in place
// of Connect your library's one-time popup), and at any time from Settings ▸ Import context, which asks for it by the event.

public enum GuidedSetup {
    /// The announcement that asks for the guided setup (App.jsx listens; Settings posts it).
    public static let startEvent = "engelbart:guided-setup"
    /// Settings ▸ Import context: ask for it.
    public static func start(_ hub: EventHub = .shared) { hub.post(startEvent) }

    /// Onboarding's mode for the app's state (App.jsx): the guided setup from a project → 'guided'; the guided setup from
    /// all projects, or someone with no projects (in the trash counts as having some) → 'new'; else + Project's 'existing'.
    public static func onboardMode(guidedFromProject: Bool, guided: Bool, returning: Bool) -> OnboardingMode {
        guidedFromProject ? .guided : (guided || !returning) ? .new : .existing
    }
    /// Where "Engelbart" in onboarding's top left goes, as its tooltip says.
    public static func backTitle(guidedFromProject: Bool) -> String { guidedFromProject ? "Back to your project" : "All projects" }
}

/// The one-time offer, over the workspace: Start runs the guided setup, Not now (or Escape) dismisses it.
public struct GuidedSetupOffer: View {
    let onStart: () -> Void
    let onDismiss: () -> Void

    public init(onStart: @escaping () -> Void, onDismiss: @escaping () -> Void) { self.onStart = onStart; self.onDismiss = onDismiss }

    public var body: some View {
        ZStack {
            Color(NSColor(srgbRed: 23 / 255, green: 23 / 255, blue: 23 / 255, alpha: 0.18))
                .contentShape(Rectangle())
                .onTapGesture(perform: onDismiss)
                .probe("guided-offer-veil", press: onDismiss)
            VStack(alignment: .leading, spacing: 0) {
                Text("New: import your context").textStyle(TextStyle(17, weight: 600, lineHeight: 1.4, tracking: -0.2)).foregroundStyle(Color(Palette.ink))
                    .accessibilityAddTraits(.isHeader)
                Text("Agents bring in the notes, chats and papers of the projects you pick, into your library.")
                    .textStyle(TextStyle(14, lineHeight: 1.6)).foregroundStyle(Color(Palette.mut))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    EButton("Not now", .outline, size: .sm, action: onDismiss).probe("guided-offer-dismiss", press: onDismiss)
                    EButton("Start", .filled, size: .sm, go: true, action: onStart).probe("guided-offer-start", press: onStart)
                }
                .padding(.top, 20)
            }
            .padding(EdgeInsets(top: 22, leading: 24, bottom: 20, trailing: 24))
            .frame(maxWidth: 400)
            .background(RoundedRectangle(cornerRadius: Radius.lg).fill(Color(Palette.bg)))
            .overlay(RoundedRectangle(cornerRadius: Radius.lg).strokeBorder(Color(Palette.bd), lineWidth: 1))
            .shadow(color: Color.black.opacity(0x24 / 255.0), radius: 24, x: 0, y: 16)
            .rise(0.16)
            .accessibilityElement(children: .contain)
            .probe("guided-offer")
            .padding(24)
        }
        // Escape, before anything else sees it (a capture-phase listener in Electron).
        .background(KeyMonitor(keyCode: 53) { onDismiss(); return true })
    }
}
