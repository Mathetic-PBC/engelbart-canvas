// Adding to a workspace what the library already holds (MATH-67, 2026-10-06). Main refuses a second row for the same
// thing (library.addItem throws "Already in the library as “…”"); the sidebar's Add context and its + beside Files mean
// "have it in this workspace", so that refusal is answered with the row the library has, and the caller links it.

const ALREADY = /Already in the library as “/;

/**
 * `api.addLibraryItem`, except that something the library holds comes back as its row. Anything else that refuses (a
 * path with nothing at it, a format not read), and an "already" whose row cannot be found, still throws what main said.
 */
export async function addOrFind(api, input, options) {
  try {
    return await api.addLibraryItem(input, options);
  } catch (error) {
    if (!ALREADY.test(String((error && error.message) || ''))) throw error;
    const found = await api.lookupLibraryItem(input).catch(() => null);
    if (found && found.row) return found.row;
    throw error;
  }
}
