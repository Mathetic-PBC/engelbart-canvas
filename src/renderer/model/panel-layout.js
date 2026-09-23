// The right pane can take all of the editor's space, but retains a usable
// minimum width when the divider is dragged in the other direction.
export function panelSplit(clientX, left, width) {
  const available = Math.max(1, width);
  const maximum = 1 - Math.min(0.4, 300 / available);
  return Math.max(0, Math.min(maximum, (clientX - left) / available));
}

export function panelColumns(rail, split) {
  return `${rail}px 1px minmax(0, ${split}fr) 1px minmax(0, ${1 - split}fr)`;
}

// Keep Hudson's fixed right-pane width while dragging the sidebar, and allow
// the E2B pane to cover the document completely when its own edge is dragged.
export function workspacePanels(viewWidth, railWidth, rightWidth = null) {
  const usable = Math.max(0, viewWidth - 2);
  const railMin = Math.min(220, usable);
  const railMax = Math.min(520, Math.max(railMin, usable - 320));
  const rail = Math.max(railMin, Math.min(railMax, railWidth));
  const available = usable - rail;
  const right = Math.max(Math.min(320, available), Math.min(available, rightWidth ?? Math.round(available / 2)));
  return { rail, right, available, documentWidth: available - right, columns: `${rail}px 1px minmax(0, 1fr) 1px ${right}px` };
}
