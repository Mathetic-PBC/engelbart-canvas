import AppKit
import EngelbartDoc

// Pastes into the editor's own fields (DocEditor followPaste, fieldPaste): a picture pasted into a follow-up (or a card's
// field) is saved as one pasted into the document is (the host's pasteImage) and named in the field as
// `[Attachment n]`, numbered on from the document's pictures; sendFollow writes it into the line as a picture token.
// Text copied from a PDF goes in without the page's layout (PdfPaste.pdfText); any other text is the field's own paste.

extension DocEditorView {
    static let fieldImageTypes: [(NSPasteboard.PasteboardType, String)] = [(.png, "image/png"), (NSPasteboard.PasteboardType("public.jpeg"), "image/jpeg"),
                                                                           (NSPasteboard.PasteboardType("com.compuserve.gif"), "image/gif"), (NSPasteboard.PasteboardType("org.webmproject.webp"), "image/webp"), (.tiff, "image/png")]

    /// A paste into field `field` of thread `from` (nil: a field that takes no pictures, Send to Discover). → taken.
    @discardableResult
    func fieldPaste(_ pb: NSPasteboard, field: NSTextView, from: Int?) -> Bool {
        if let from, let host {
            var pictures: [(Data, String)] = []
            for item in pb.pasteboardItems ?? [] {
                for (type, mime) in DocEditorView.fieldImageTypes {
                    guard let data = item.data(forType: type) else { continue }
                    pictures.append((type == .tiff ? (NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) ?? data) : data, mime)); break
                }
            }
            if !pictures.isEmpty {
                for (data, mime) in pictures {
                    let draft = core.followImages[from] ?? []
                    let inDoc = Rx(#"\]\(img:"#).matchAll(core.text).count
                    let n = max(inDoc + draft.count, draft.map { $0.n }.max() ?? 0) + 1
                    core.followImages[from] = draft + [(n: n, id: nil)] // holds the number while it saves
                    host.docEditor(self, pasteImage: data, mime: mime, label: "Attachment \(n)") { [weak self] id in
                        guard let self else { return }
                        let held = (self.core.followImages[from] ?? []).filter { $0.n != n }
                        guard let id else { self.core.followImages[from] = held; return }
                        self.core.followImages[from] = held + [(n: n, id: id)]
                        self.writeIntoField(from, token: "[Attachment \(n)]")
                    }
                }
                return true
            }
        }
        guard let raw = pb.string(forType: .string)?.replacingOccurrences(of: "\r", with: ""), !raw.isEmpty else { return false }
        let text = PdfPaste.pdfText(raw)
        if text == raw { return false }
        field.insertText(text, replacementRange: field.selectedRange())
        return true
    }

    /// `token` typed into thread `from`'s field where its caret is (the field as it is now), else after what it holds.
    func writeIntoField(_ from: Int, token: String) {
        let live = overlays.compactMap { ($0 as? ReplyFieldView)?.from == from ? ($0 as! ReplyFieldView).field : nil }.first
            ?? overlays.compactMap { v -> NSTextView? in guard let c = v as? CardView, let f = c.field, c.from == from else { return nil }; return f }.first
        if let field = live {
            let r = field.selectedRange(), before = (field.string as NSString).substring(to: min(r.location, (field.string as NSString).length))
            field.insertText("\(before.isEmpty || Rx(#"\s$"#).test(before) ? "" : " ")\(token) ", replacementRange: r)
            core.followText[from] = field.string
        } else {
            let text = core.followText[from] ?? ""
            core.followText[from] = "\(text)\(text.isEmpty || Rx(#"\s$"#).test(text) ? "" : " ")\(token) "
        }
    }
}
