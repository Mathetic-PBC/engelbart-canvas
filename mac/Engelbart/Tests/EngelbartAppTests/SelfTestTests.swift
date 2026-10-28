import AppKit
import XCTest
@testable import EngelbartApp

/// The driver's own parsing (SelfTest.swift): key specs, key codes and menu paths.
@MainActor
final class SelfTestTests: XCTestCase {
    func testKeyCodes() {
        XCTAssertEqual(SelfTest.keyCode("Escape")?.0, 53)
        XCTAssertEqual(SelfTest.keyCode("Enter")?.1, "\r")
        XCTAssertEqual(SelfTest.keyCode("n")?.0, 45)
        XCTAssertEqual(SelfTest.keyCode("F")?.0, 3, "a letter in either case")
        XCTAssertNil(SelfTest.keyCode("Hyper"))
    }

    func testKeyEvents() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        let e = SelfTest.keyEvent("cmd+shift+n", window: window)
        XCTAssertEqual(e?.keyCode, 45)
        XCTAssertEqual(e?.modifierFlags.contains(.command), true)
        XCTAssertEqual(e?.modifierFlags.contains(.shift), true)
        XCTAssertEqual(e?.characters, "N")
        XCTAssertEqual(e?.charactersIgnoringModifiers, "n")
        XCTAssertEqual(SelfTest.keyEvent("Escape", window: window, up: true)?.type, .keyUp)
        XCTAssertNil(SelfTest.keyEvent("super+x", window: window))
    }

    func testMenuPaths() {
        let bar = NSMenu()
        let file = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        let sub = NSMenu(title: "File")
        sub.addItem(NSMenuItem(title: "New Window", action: nil, keyEquivalent: "N"))
        file.submenu = sub
        bar.addItem(file)
        XCTAssertEqual(SelfTest.menuItem("File/New Window", in: bar)?.keyEquivalent, "N")
        XCTAssertNil(SelfTest.menuItem("File/Nope", in: bar))
    }

    func testMainMenuMatchesElectron() {
        let slots = ScreenSlots()
        let manager = WindowManager(slots: slots, paths: AppPaths(environment: ["ENGELBART_ROOT_DIR": NSTemporaryDirectory()]), headless: true)
        let quit = QuitController()
        let menu = MainMenu(manager: manager, quit: quit, slots: slots, paths: manager.paths)
        let app = menu.appMenu().items.map(\.title)
        XCTAssertEqual(app, ["About Engelbart", "", "Set Up Tools…", "", "Services", "", "Hide Engelbart", "Hide Others", "Show All", "", "Quit Engelbart"])
        let file = menu.fileMenu().items
        XCTAssertEqual(file.map(\.title), ["New Window", "", "Reveal Engelbart Folder", "", "Close Window"])
        XCTAssertEqual([file[0].keyEquivalent, file[4].keyEquivalent], ["N", "W"], "⇧⌘N, ⇧⌘W: ⌘W stays the tabs'")
        let edit = menu.editMenu().items
        XCTAssertEqual(edit.map(\.title), ["Undo", "Redo", "", "Cut", "Copy", "Paste", "Select All", "", "Find"])
        XCTAssertEqual(edit[8].submenu?.items.map(\.title), ["Find…", "Find Next", "Find Previous"])
        XCTAssertEqual(edit[8].submenu?.items.map(\.keyEquivalent), ["f", "g", "G"])
        let view = menu.viewMenu().items
        XCTAssertEqual(view.map(\.title), ["Reload", "Toggle Developer Tools", "", "Agent Trace", "", "Toggle Full Screen"])
        XCTAssertEqual(view[3].keyEquivalentModifierMask, [.command, .option], "⌥⌘T")
        XCTAssertEqual(view[5].keyEquivalentModifierMask, [.command, .control], "⌃⌘F")
        XCTAssertEqual(menu.windowMenu().items.map(\.title), ["Minimize", "Zoom", "", "Bring All to Front"])
        XCTAssertEqual(menu.dockMenu().items.map(\.title), ["New Window"])
        // The updater's item appears only while updates are enabled, disabled while it has no action.
        slots.updateMenuItem = { UpdateMenuItem(label: "Downloading Update… 40%", action: nil) }
        let withUpdate = menu.appMenu().items
        XCTAssertEqual(withUpdate[1].title, "Downloading Update… 40%")
        XCTAssertFalse(withUpdate[1].isEnabled)
    }
}
