import Foundation

/// An error whose message is the Electron code's text, word for word (the pane shows it as `# …`).
public struct TerminalError: Error, LocalizedError, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}

/// `error instanceof Error ? error.message : String(error)` (sessions.js errorMessage).
func errorText(_ error: Error) -> String {
    if let error = error as? TerminalError { return error.message }
    if let error = error as? LocalizedError, let text = error.errorDescription { return text }
    return String(describing: error)
}
