import Foundation
import EngelbartStore

// Adding to a project what the library already holds (MATH-67, 2026-10-06; src/renderer/model/add-or-find.js). The Store
// refuses a second row for the same thing (StoreError code EXISTS, "Already in the library as “…”", carrying the row);
// the sidebar's adds mean "have it here", so that refusal is answered with the row the library has.

public enum AddOrFind {
    static let ALREADY = "Already in the library as “"

    /// `add(input)`, except that something the library holds comes back as its row: the refusal's own row, else what
    /// `lookup(input)` finds. Anything else that refuses, and an "already" whose row cannot be found, still throws.
    public static func addOrFind(_ input: String, add: (String) async throws -> LibraryRow, lookup: (String) async throws -> Library.Lookup) async throws -> LibraryRow {
        do {
            return try await add(input)
        } catch {
            let message = (error as? StoreError)?.message ?? error.localizedDescription
            guard message.contains(ALREADY) || (error as? StoreError)?.code == "EXISTS" else { throw error }
            if let row = (error as? StoreError)?.row { return row }
            if let found = try? await lookup(input), let row = found.row { return row }
            throw error
        }
    }
}
