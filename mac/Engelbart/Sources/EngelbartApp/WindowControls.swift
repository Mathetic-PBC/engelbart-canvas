import EngelbartUI
import SwiftUI

/// The controls on every screen, fixed top-right (ui/WindowControls.jsx): the sandbox notification bell, the Settings gear,
/// then what `children` adds (the Connect chip; the Test pill in a developer's copy). `bare`: onboarding's screens, which
/// show no bell, and the gear only while test mode is on, for its Test data (From Amitav, 2026-10-15). The Agents button is
/// stashed (2026-10-15, David): off the top bar for now.
struct WindowControls: View {
    @ObservedObject var model: RootModel
    let context: WindowContext
    let slots: ScreenSlots

    var bare: Bool { model.phase == .create }

    var body: some View {
        HStack(spacing: 8) {
            if !bare, let bell = slots.notificationBell { bell(model, context) }
            if !bare || (model.config?.testMode == true) {
                SettingsGearButton(expanded: model.settingsPage != nil) { model.settingsPage = "" }
            }
            if let chip = slots.connectChip { chip(model, context) }
            if let config = model.config, config.testModeAvailable {
                TestToggle(testMode: config.testMode, busy: model.busy, dataRoot: config.dataRoot, testRoot: config.testRoot) {
                    Task { await model.toggleTest() }
                }
            }
        }
        .padding(.top, 13).padding(.trailing, 16)
        .accessibilityElement(children: .contain)
        .driveID("window-controls")
    }
}

/// Test mode's pill (ui/TestToggle.jsx): small caps, "Test · on" filled ink / "Test · off" outline; what its gear
/// offered is Settings ▸ Test data since 2026-10-06, so there is one gear.
struct TestToggle: View {
    let testMode: Bool
    let busy: Bool
    let dataRoot: String
    let testRoot: String
    let onToggle: () -> Void

    static func tooltip(testMode: Bool, dataRoot: String, testRoot: String) -> String {
        testMode ? "Test mode is on — everything lives in \(AppPaths.shown(URL(fileURLWithPath: testRoot)))"
            : "Test mode is off — everything lives in \(AppPaths.shown(URL(fileURLWithPath: dataRoot)))"
    }

    var body: some View {
        EButton(testMode ? .filled : .outline, size: .sm, caps: true, title: Self.tooltip(testMode: testMode, dataRoot: dataRoot, testRoot: testRoot),
                action: onToggle) {
            Text("Test · \(testMode ? "on" : "off")")
        }
        .disabled(busy)
        .driveID("test-toggle")
    }
}
