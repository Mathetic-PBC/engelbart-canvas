import Foundation
import EngelbartCore

// src/main/overleaf/editor.cjs (MATH-65, Overleaf part 1, 2026-10-07): the Overleaf project open in the Stage. No API and no
// cookie import: the person signs in to overleaf.com in the Stage once, and its editor tabs (overleaf.com/project/<id>)
// are read from the page. Overleaf's editor is CodeMirror 6, which draws only the lines in view, so the file is read from
// the editor's state: READ_SCRIPT runs in the page's main world (WKWebView evaluateJavaScript in .page content world, the
// Swift counterpart of webContents.executeJavaScript; Stage runs it), finds the EditorView behind .cm-content and returns
// state.doc.toString(), the selection, the cursor's line, and the open file's path from the file tree's selected item.
// It changes nothing and keeps nothing. A page that does not answer within READ_TIMEOUT_MS has no live read; @bart is
// then given the project's copy on disk (OverleafCopy) and told so (OverleafStage).
// Writing back (not yet): through the same view, view.dispatch({ changes }), never by writing the copy.

public struct OverleafRead: Equatable, Sendable {
    public var found: Bool
    public var text: String = ""
    public var offset: Int = 0
    public var length: Int = 0
    public var lines: Int = 0
    public var from: Int = 0
    public var to: Int = 0
    public var head: Int = 0
    public var cursorLine: Int = 0
    public var fromLine: Int = 0
    public var toLine: Int = 0
    public var selection: String = ""
    public var file: String
    public var projectName: String
}

/// What reading the editor answered: a read, or why not ('timeout', 'unreadable', 'error').
public enum OverleafLive: Equatable, Sendable {
    case read(OverleafRead)
    case failed(String)

    public var ok: Bool { if case .read = self { return true }; return false }
    public var readValue: OverleafRead? { if case .read(let r) = self { return r }; return nil }
}

public enum OverleafEditor {
    public static let readTimeoutMs: Double = 500
    public static let maxDoc = 2_000_000
    public static let maxSelection = 20_000
    static let maxName = 300
    static let maxPath = 1024
    static let projectRE = re("^/project/([0-9a-f]{24})/?$", .caseInsensitive)

    /// The Overleaf project an editor tab shows (https://(www.)overleaf.com/project/<24 hex>) → its id, lowercased; else ''.
    public static func projectId(_ value: String?) -> String {
        guard let value, let url = URLComponents(string: value), url.scheme == "https", let host = url.host,
              re("^(?:www\\.)?overleaf\\.com$", .caseInsensitive).test(host), let m = projectRE.groups(url.path), let id = m[1] else { return "" }
        return id.lowercased()
    }

    /// A tab's title without Overleaf's " - Overleaf, Online LaTeX Editor".
    public static func projectTitle(_ title: String?) -> String {
        var s = re("\\s+[-–—|]\\s+Overleaf\\b.*$", .caseInsensitive).replace(title ?? "", with: "")
        s = re("\\s+").replace(s, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return jsSlice(s, maxName)
    }

    /// Runs in the page (main world), so it is a string and uses only what a page has. Kept as the Electron code has it.
    public static let readScript = """
    (() => {
      const MAX_DOC = \(maxDoc), MAX_SELECTION = \(maxSelection);
      const isView = (v) => !!(v && v.state && v.state.doc && typeof v.state.doc.toString === 'function' && v.state.selection && typeof v.dispatch === 'function');
      const fromTile = (t) => (t && typeof t === 'object' ? [t, t.view, t.rootView && t.rootView.view, t.root && t.root.view] : []);
      // EditorView.findFromDOM, without the module: the content element's tile (cmView, cmTile in newer versions) knows its view
      const viewOf = (el) => {
        if (!el) return null;
        for (const v of [...fromTile(el.cmView), ...fromTile(el.cmTile)]) if (isView(v)) return v;
        for (const key of Object.keys(el)) for (const v of fromTile(el[key])) if (isView(v)) return v;
        return null;
      };
      const views = [];
      for (const el of document.querySelectorAll('.cm-content')) {
        const view = viewOf(el) || viewOf(el.closest && el.closest('.cm-editor'));
        if (view && !views.includes(view)) views.push(view);
      }
      const shown = (v) => { try { return !!(v.dom && v.dom.offsetParent !== null); } catch (e) { return true; } };
      const view = views.find((v) => v.hasFocus) || views.filter(shown).sort((a, b) => b.state.doc.length - a.state.doc.length)[0] || views[0] || null;

      const label = (item) => {
        const own = item.getAttribute && item.getAttribute('aria-label');
        if (own) return own;
        const button = item.querySelector && item.querySelector('.item-name-button');
        return String((button && button.textContent) || '').trim();
      };
      let file = '';
      const selected = document.querySelector('[role="tree"] [role="treeitem"][aria-selected="true"]') || document.querySelector('.file-tree [aria-selected="true"]');
      if (selected) {
        const parts = [];
        for (let item = selected; item; item = item.parentElement && item.parentElement.closest ? item.parentElement.closest('[role="treeitem"]') : null) parts.unshift(label(item));
        file = parts.filter(Boolean).join('/');
      }
      if (!file) {
        const crumbs = document.querySelector('.ol-cm-breadcrumbs');
        if (crumbs) file = String(crumbs.textContent || '').split(/\\s*[›>\\/]\\s*/).map((s) => s.trim()).filter(Boolean).join('/');
      }
      const meta = document.querySelector('meta[name="ol-projectName"]');
      const projectName = String((meta && meta.getAttribute('content')) || '').trim() || String(document.title || '');
      if (!view) return { found: false, file, projectName };

      const state = view.state, doc = state.doc, main = state.selection.main;
      const length = doc.length;
      let offset = 0, end = length;
      if (length > MAX_DOC) { offset = Math.max(0, Math.min(length - MAX_DOC, main.head - MAX_DOC / 2)); end = offset + MAX_DOC; }
      const text = offset === 0 && end === length ? doc.toString() : doc.sliceString(offset, end);
      const from = Math.min(main.from, main.to), to = Math.max(main.from, main.to);
      return {
        found: true, text, offset, length, lines: doc.lines,
        from, to, head: main.head,
        cursorLine: doc.lineAt(main.head).number, fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number,
        selection: to > from ? doc.sliceString(from, Math.min(to, from + MAX_SELECTION)) : '',
        file, projectName,
      };
    })()
    """

    static func shortText(_ value: JSONValue?, _ max: Int) -> String {
        guard let s = value?.string else { return "" }
        return jsSlice(re("[\\u0000\\r\\n]+").replace(s, with: " ").trimmingCharacters(in: .whitespacesAndNewlines), max)
    }

    static func int(_ value: JSONValue?, _ max: Double) -> Int? {
        guard let n = value?.double, n.rounded() == n, n >= 0, n <= max else { return nil }
        return Int(n)
    }

    /// What READ_SCRIPT answered, checked → a read, or nil for anything that does not add up. A file path that leaves
    /// the project (.., an absolute path) is dropped.
    public static func editorInput(_ value: JSONValue?) -> OverleafRead? {
        guard let value, value.object != nil else { return nil }
        var file = re("^/+").replace(shortText(value["file"], maxPath), with: "")
        if file.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." }) { file = "" }
        let projectName = projectTitle(value["projectName"]?.string)
        if value["found"] != .bool(true) {
            return value["found"] == .bool(false) ? OverleafRead(found: false, file: file, projectName: projectName) : nil
        }
        guard let text = value["text"]?.string, jsLength(text) <= maxDoc,
              let length = int(value["length"], 1e9), let offset = int(value["offset"], Double(length)), offset + jsLength(text) <= length,
              let lines = int(value["lines"], 1e8),
              let from = int(value["from"], Double(length)), let to = int(value["to"], Double(length)), from <= to,
              let head = int(value["head"], Double(length)), head >= offset, head <= offset + jsLength(text) else { return nil }
        guard let cursorLine = int(value["cursorLine"], Double(lines)), let fromLine = int(value["fromLine"], Double(lines)), let toLine = int(value["toLine"], Double(lines)),
              cursorLine >= 1, fromLine >= 1, toLine >= 1, fromLine <= toLine else { return nil }
        let selection = value["selection"]?.string.map { jsSlice($0, maxSelection) } ?? ""
        return OverleafRead(found: true, text: text, offset: offset, length: length, lines: lines, from: from, to: to, head: head,
                            cursorLine: cursorLine, fromLine: fromLine, toLine: toLine, selection: selection, file: file, projectName: projectName)
    }

    /// The editor of an Overleaf tab read now. `evaluate` runs the script in the page's main world (the Stage's
    /// WKWebView) and answers its value as JSON; nil when there is no such page.
    public static func readEditor(_ evaluate: (@Sendable (String) async throws -> JSONValue?)?, timeoutMs: Double = readTimeoutMs) async -> OverleafLive {
        guard let evaluate else { return .failed("error") }
        // Whichever comes first: the page's answer or the timeout. A page that never answers is left to itself (a task
        // group would wait for it), as Promise.race leaves the executeJavaScript promise.
        let once = OnceBox<OverleafLive>()
        return await withCheckedContinuation { (c: CheckedContinuation<OverleafLive, Never>) in
            once.set(c)
            Task.detached {
                let answer: OverleafLive
                do {
                    let out = try await evaluate(readScript)
                    answer = editorInput(out).map { .read($0) } ?? .failed("unreadable")
                } catch { answer = .failed("error") }
                once.resume(answer)
            }
            Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(timeoutMs * 1_000_000))
                once.resume(.failed("timeout"))
            }
        }
    }
}

/// A continuation resumed once, by whoever comes first.
final class OnceBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?
    private var done = false
    private var early: T?
    func set(_ c: CheckedContinuation<T, Never>) {
        lock.lock()
        if let early { lock.unlock(); c.resume(returning: early); return }
        continuation = c
        lock.unlock()
    }
    func resume(_ value: T) {
        lock.lock()
        if done { lock.unlock(); return }
        done = true
        guard let c = continuation else { early = value; lock.unlock(); return }
        continuation = nil
        lock.unlock()
        c.resume(returning: value)
    }
}
