/** Parse the warehouse manifest export before allocation. */
export function parseManifest(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== 'id,units,priority') throw new Error('Expected id,units,priority header');
  return lines.map(line => {
    const [id, units, priority] = line.split(',');
    return { id, units: Number(units), priority: Number(priority) };
  });
}

/** Priority first, then stable original order; a row fits entirely or is skipped. */
export function allocate(rows, capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error('Invalid capacity');
  let remaining = capacity;
  const selected = [];
  for (const row of rows.map((r, index) => ({ ...r, index })).sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    if (row.units <= remaining) { selected.push(row.id); remaining -= row.units; }
  }
  return { selected, remaining };
}
