// Thin access to the preload bridge. Every call goes to the main process, which owns
// the filesystem and the databases.

const bridge = window.engelbartAPI;
if (!bridge) throw new Error('Engelbart bridge is unavailable');

export const api = bridge;

export function errorMessage(error) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(error || 'Unknown error');
}
