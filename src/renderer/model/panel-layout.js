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
