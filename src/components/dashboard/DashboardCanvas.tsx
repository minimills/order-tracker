// @permission-scope dashboard
/* Every widget drawn here was checked with widgetAllowed() (its own catalog key); edit controls only show with dashboard.charts.customize. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import Can from '../Can'
import { secondaryButtonClass } from '../form'
import type { DashData } from '../../lib/dashboardData'
import { breakpointFor, COLS, GAP, layoutFor, place, ROW_HEIGHT, type Breakpoint, type Item, type Layouts } from '../../lib/gridLayout'
import { usePermissions } from '../../lib/permissions'
import { colourHex, healthFor, healthState, newWidgetId, widgetAllowed, widgetDef, widgetTitle, type Health, type Widget } from '../../lib/widgets'
import { loadChartSettings } from '../../lib/dashboardCharts'
import { WidgetLibraryDialog, WidgetSettingsDialog } from './DashboardDialogs'
import WidgetBody from './WidgetBody'
import { HealthColour } from '../../lib/healthColour'
import { updatedText } from '../../lib/dashboardData'

type Drag = { id: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: Item; base: Item[] }

/**
 * The dashboard grid. Not editing: the widgets in their places (the layout of
 * this screen size, or one worked out from the computer layout). Editing: drag
 * a widget's top bar to move it, drag the corner to resize it, or use the
 * arrow and size buttons (keyboard and touch); the others make room and
 * everything floats up into gaps.
 */
export default function DashboardCanvas({
  widgets,
  layouts,
  editing,
  data,
  onChange,
  onNote,
  canEditNote,
  showAll = false,
}: {
  widgets: Widget[]
  layouts: Layouts
  editing: boolean
  data: DashData
  onChange: (widgets: Widget[], layouts: Layouts) => void
  onNote?: (id: string, text: string) => void
  canEditNote?: boolean
  /** Template editor: offer every widget (people only ever see what they are allowed). */
  showAll?: boolean
}) {
  const { can } = usePermissions()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [preview, setPreview] = useState<Item[] | null>(null)
  const [settingsFor, setSettingsFor] = useState<Widget | null>(null)
  const [library, setLibrary] = useState(false)
  // Good / bad colours: the number each widget reports, judged by its setting.
  const [companyHealth, setCompanyHealth] = useState<Record<string, Health>>({})
  const [values, setValues] = useState<Record<string, number | null>>({})
  useEffect(() => {
    loadChartSettings().then((s) => setCompanyHealth(s.health ?? {}))
  }, [])
  const report = useCallback((id: string, v: number | null) => setValues((m) => (m[id] === v ? m : { ...m, [id]: v })), [])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const bp: Breakpoint = breakpointFor(width || 1200)
  const cols = COLS[bp]
  const shown = widgets.filter((w) => showAll || widgetAllowed(widgetDef(w.key), can))
  const ids = shown.map((w) => w.id)
  const sizeOf = (id: string) => {
    const d = widgetDef(widgets.find((w) => w.id === id)?.key ?? '')
    return { w: d?.w ?? 4, h: d?.h ?? 3 }
  }
  const items = preview ?? layoutFor(layouts, bp, ids, sizeOf)
  const cellW = width ? (width - GAP * (cols - 1)) / cols : 0
  const stepX = cellW + GAP
  const stepY = ROW_HEIGHT + GAP
  const height = items.reduce((m, it) => Math.max(m, it.y + it.h), 0) * stepY

  const commit = (next: Item[]) => onChange(widgets, { ...layouts, [bp]: next })

  function start(e: ReactPointerEvent, id: string, mode: Drag['mode']) {
    if (!editing) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ id, mode, startX: e.clientX, startY: e.clientY, orig: items.find((it) => it.i === id)!, base: items })
  }
  function moveTo(e: ReactPointerEvent) {
    if (!drag || !stepX) return
    const dx = Math.round((e.clientX - drag.startX) / stepX)
    const dy = Math.round((e.clientY - drag.startY) / stepY)
    const patch = drag.mode === 'move' ? { x: drag.orig.x + dx, y: drag.orig.y + dy } : { w: drag.orig.w + dx, h: drag.orig.h + dy }
    setPreview(place(drag.base, drag.id, patch, cols))
  }
  function end() {
    if (drag && preview) commit(preview)
    setDrag(null)
    setPreview(null)
  }
  const nudge = (id: string, patch: (it: Item) => Partial<Item>) => {
    const it = items.find((x) => x.i === id)!
    commit(place(items, id, patch(it), cols))
  }

  // Escape stops a drag.
  useEffect(() => {
    if (!drag) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (setDrag(null), setPreview(null))
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [drag])

  const remove = (id: string) => {
    const next = widgets.filter((w) => w.id !== id)
    const lay: Layouts = {}
    for (const k of Object.keys(layouts) as Breakpoint[]) lay[k] = (layouts[k] ?? []).filter((it) => it.i !== id)
    onChange(next, lay)
  }
  const addWidget = (key: string) => {
    const w: Widget = { id: newWidgetId(), key }
    onChange([...widgets, w], layouts)
  }
  const btn = 'rounded border border-slate-300 bg-white px-1.5 text-xs leading-5 text-slate-700 hover:bg-slate-50'

  return (
    <div>
      {editing && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-blue-300 bg-blue-50 p-2 text-sm text-blue-900">
          <button type="button" className={secondaryButtonClass} onClick={() => setLibrary(true)}>
            + Add Widget
          </button>
          <span>
            Drag a widget by its top bar to move it, or by the corner to resize it. This layout is saved for {bp === 'lg' ? 'computers' : bp === 'md' ? 'tablets' : 'phones'}.
          </span>
        </div>
      )}
      {shown.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          {widgets.length > 0 ? 'The widgets on this dashboard are not shown because you are not allowed to see them.' : `This dashboard has no widgets${editing ? '. Select Add Widget to start.' : ' yet.'}`}
        </p>
      )}
      {shown.length > 0 && shown.length < widgets.length && (
        <p className="mb-2 text-xs text-slate-500">
          {widgets.length - shown.length} widget{widgets.length - shown.length === 1 ? ' is' : 's are'} not shown because you are not allowed to see {widgets.length - shown.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      <div
        ref={box}
        className={`relative ${editing ? 'rounded-lg [background-image:linear-gradient(to_right,rgb(148_163_184/0.15)_1px,transparent_1px)]' : ''}`}
        style={{ height, ...(editing && stepX ? { backgroundSize: `${stepX}px 100%` } : {}) }}
        onPointerMove={moveTo}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {width > 0 &&
          items.map((it) => {
            const w = shown.find((x) => x.id === it.i)
            if (!w) return null
            const def = widgetDef(w.key)
            const dragging = drag?.id === it.i
            const state = healthState(values[w.id], healthFor(w, companyHealth))
            const tone =
              state === 'bad' ? 'widget-bad border-2 border-red-600 bg-red-50' : state === 'good' ? 'widget-good border-2 border-green-600 bg-green-50' : 'border border-slate-200 bg-white'
            return (
              <section
                key={it.i}
                aria-label={widgetTitle(w)}
                className={`widget-frame absolute flex flex-col overflow-hidden rounded-xl shadow-sm ${tone} ${dragging ? 'z-20 opacity-90 shadow-lg ring-2 ring-blue-400' : 'transition-[left,top,width,height] duration-150'}`}
                style={{ left: it.x * stepX, top: it.y * stepY, width: it.w * cellW + (it.w - 1) * GAP, height: it.h * ROW_HEIGHT + (it.h - 1) * GAP }}
              >
                <header
                  className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-100 px-3 py-1.5 ${editing ? 'cursor-move touch-none select-none' : ''}`}
                  style={{ borderTop: `3px solid ${colourHex(w.colour)}` }}
                  onPointerDown={(e) => (e.target as HTMLElement).closest('button') === null && start(e, it.i, 'move')}
                >
                  <h2 className="min-w-[6rem] flex-1 truncate text-sm font-semibold">{widgetTitle(w)}</h2>
                  {state !== 'neutral' && (
                    <span className={`shrink-0 rounded-full px-2 text-[11px] font-semibold text-white ${state === 'bad' ? 'bg-red-700' : 'bg-green-700'}`}>
                      {state === 'bad' ? 'Needs attention' : 'Good'}
                    </span>
                  )}
                  {editing && (
                    <span className="flex shrink-0 items-center gap-1">
                      <button type="button" className={btn} aria-label={`Settings of ${widgetTitle(w)}`} onClick={() => setSettingsFor(w)}>
                        Settings
                      </button>
                      <button type="button" className={btn} aria-label={`Remove ${widgetTitle(w)}`} onClick={() => remove(w.id)}>
                        ✕
                      </button>
                    </span>
                  )}
                </header>
                <div className={`widget-body min-h-0 flex-1 overflow-auto px-3 py-2 ${state === 'bad' ? 'bg-red-50' : state === 'good' ? 'bg-green-50' : 'bg-white'}`}>
                  <HealthColour.Provider value={state === 'bad' ? '#b91c1c' : state === 'good' ? '#15803d' : null}>
                    <WidgetBody widget={w} data={data} onNote={(text) => onNote?.(w.id, text)} canEditNote={canEditNote && !editing} onValue={(v) => report(w.id, v)} />
                  </HealthColour.Provider>
                </div>
                {editing ? (
                  <footer className="flex flex-wrap items-center gap-1 border-t border-slate-100 bg-slate-50 px-2 py-1">
                    <button type="button" className={btn} aria-label="Move left" onClick={() => nudge(it.i, (x) => ({ x: x.x - 1 }))}>
                      ←
                    </button>
                    <button type="button" className={btn} aria-label="Move up" onClick={() => nudge(it.i, (x) => ({ y: Math.max(0, x.y - 1) }))}>
                      ↑
                    </button>
                    <button type="button" className={btn} aria-label="Move down" onClick={() => nudge(it.i, (x) => ({ y: x.y + x.h }))}>
                      ↓
                    </button>
                    <button type="button" className={btn} aria-label="Move right" onClick={() => nudge(it.i, (x) => ({ x: x.x + 1 }))}>
                      →
                    </button>
                    <span className="ml-1 text-[11px] text-slate-500">
                      {it.w}×{it.h}
                    </span>
                    <button type="button" className={btn} aria-label="Narrower" onClick={() => nudge(it.i, (x) => ({ w: x.w - 1 }))}>
                      −W
                    </button>
                    <button type="button" className={btn} aria-label="Wider" onClick={() => nudge(it.i, (x) => ({ w: x.w + 1 }))}>
                      +W
                    </button>
                    <button type="button" className={btn} aria-label="Shorter" onClick={() => nudge(it.i, (x) => ({ h: x.h - 1 }))}>
                      −H
                    </button>
                    <button type="button" className={btn} aria-label="Taller" onClick={() => nudge(it.i, (x) => ({ h: x.h + 1 }))}>
                      +H
                    </button>
                    <span
                      role="presentation"
                      title="Drag to resize"
                      className="ml-auto h-5 w-5 shrink-0 cursor-se-resize touch-none rounded-sm [background:linear-gradient(135deg,transparent_50%,rgb(100_116_139)_50%,rgb(100_116_139)_60%,transparent_60%,transparent_70%,rgb(100_116_139)_70%,rgb(100_116_139)_80%,transparent_80%)]"
                      onPointerDown={(e) => start(e, it.i, 'resize')}
                    />
                  </footer>
                ) : (
                  def?.kind !== 'note' && <footer className="px-3 pb-1 text-[11px] text-slate-500">{updatedText(data.loadedAt)}</footer>
                )}
              </section>
            )
          })}
      </div>

      <Can permission="dashboard.charts.customize" level="edit">
        {library && <WidgetLibraryDialog showAll={showAll} have={widgets.map((w) => w.key)} onAdd={addWidget} onClose={() => setLibrary(false)} />}
        {settingsFor && (
          <WidgetSettingsDialog
            widget={settingsFor}
            size={items.find((it) => it.i === settingsFor.id)}
            cols={cols}
            data={data}
            onClose={() => setSettingsFor(null)}
            onSave={(next, size) => {
              const ws = widgets.map((w) => (w.id === next.id ? next : w))
              const lay = size ? { ...layouts, [bp]: place(items, next.id, size, cols) } : layouts
              onChange(ws, lay)
              setSettingsFor(null)
            }}
          />
        )}
      </Can>
    </div>
  )
}
