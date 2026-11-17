/**
 * The dashboard grid: where each widget sits (x, y in cells; w, h in cells).
 * Pure functions, no React: moving or resizing pushes the widgets in the way
 * down, then everything floats up so there are no gaps ("snaps neatly").
 */

export type Item = { i: string; x: number; y: number; w: number; h: number }
export type Breakpoint = 'lg' | 'md' | 'sm'
export type Layouts = Partial<Record<Breakpoint, Item[]>>

/** Columns per screen size: computer 12, tablet 6, phone 2. */
export const COLS: Record<Breakpoint, number> = { lg: 12, md: 6, sm: 2 }
export const ROW_HEIGHT = 64
export const GAP = 12

/** The screen size for a width in pixels (of the dashboard area, not the window). */
export function breakpointFor(width: number): Breakpoint {
  return width >= 900 ? 'lg' : width >= 560 ? 'md' : 'sm'
}

const overlaps = (a: Item, b: Item) => a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function clamp(it: Item, cols: number): Item {
  const w = Math.max(1, Math.min(cols, Math.round(it.w)))
  return { ...it, w, h: Math.max(1, Math.min(20, Math.round(it.h))), x: Math.max(0, Math.min(cols - w, Math.round(it.x))), y: Math.max(0, Math.round(it.y)) }
}

/** Floats every widget up as far as it goes (top to bottom, left to right). */
export function compact(items: Item[], cols: number): Item[] {
  const sorted = items.map((it) => clamp(it, cols)).sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: Item[] = []
  for (const it of sorted) {
    let cur = { ...it }
    while (cur.y > 0 && !placed.some((p) => overlaps({ ...cur, y: cur.y - 1 }, p))) cur = { ...cur, y: cur.y - 1 }
    while (placed.some((p) => overlaps(cur, p))) cur = { ...cur, y: cur.y + 1 }
    placed.push(cur)
  }
  return placed
}

/** Puts one widget at a place or size; the widgets it lands on move down, then everything floats up. */
export function place(items: Item[], id: string, patch: Partial<Item>, cols: number): Item[] {
  const moved = clamp({ ...items.find((it) => it.i === id)!, ...patch }, cols)
  let others = items.filter((it) => it.i !== id).map((it) => clamp(it, cols))
  // Push down what is in the way (and what that pushes, and so on).
  const queue: Item[] = [moved]
  let guard = 0
  while (queue.length && guard++ < 500) {
    const top = queue.shift()!
    others = others.map((o) => {
      if (!overlaps(top, o)) return o
      const pushed = { ...o, y: top.y + top.h }
      queue.push(pushed)
      return pushed
    })
  }
  // The moved widget keeps its spot; the others float up around it.
  const rest = compact([moved, ...others], cols)
  return rest
}

/** The next free place for a new widget (at the bottom, left). */
export function addAtBottom(items: Item[], id: string, w: number, h: number, cols: number): Item[] {
  const y = items.reduce((m, it) => Math.max(m, it.y + it.h), 0)
  return compact([...items, { i: id, x: 0, y, w: Math.min(w, cols), h }], cols)
}

/**
 * A layout for a smaller (or larger) screen worked out from another one:
 * widths scale with the columns, and the widgets fill the rows in the same order.
 */
export function deriveLayout(from: Item[], fromCols: number, cols: number): Item[] {
  const sorted = [...from].sort((a, b) => a.y - b.y || a.x - b.x)
  const out: Item[] = []
  for (const it of sorted) {
    let w = Math.max(1, Math.round((it.w * cols) / fromCols))
    if (cols === 2) w = it.w <= Math.ceil(fromCols / 4) ? 1 : 2 // phones: small boxes two side by side, the rest full width
    w = Math.min(cols, w)
    // first free spot, row by row
    let spot: Item | null = null
    for (let y = 0; !spot && y < 400; y++) {
      for (let x = 0; x + w <= cols; x++) {
        const cand = { i: it.i, x, y, w, h: it.h }
        if (!out.some((p) => overlaps(cand, p))) {
          spot = cand
          break
        }
      }
    }
    out.push(spot ?? { i: it.i, x: 0, y: out.length * 2, w, h: it.h })
  }
  return compact(out, cols)
}

/**
 * The layout to show for a screen size: the saved one when there is one,
 * else worked out from the computer layout. Widgets missing from it are added
 * at the bottom; widgets that no longer exist are dropped.
 */
export function layoutFor(layouts: Layouts, bp: Breakpoint, ids: string[], sizeOf: (id: string) => { w: number; h: number }): Item[] {
  const cols = COLS[bp]
  let base = layouts[bp]
  if (!base?.length) {
    const lg = layouts.lg?.length ? layouts.lg : layouts.md?.length ? layouts.md : null
    const fromCols = layouts.lg?.length ? COLS.lg : COLS.md
    base = lg ? deriveLayout(lg, fromCols, cols) : []
  }
  let items = base.filter((it) => ids.includes(it.i))
  for (const id of ids) {
    if (items.some((it) => it.i === id)) continue
    const s = sizeOf(id)
    const w = bp === 'lg' ? s.w : bp === 'md' ? Math.max(1, Math.round((s.w * COLS.md) / COLS.lg)) : s.w <= 3 ? 1 : 2
    items = addAtBottom(items, id, w, s.h, cols)
  }
  return compact(items, cols)
}
