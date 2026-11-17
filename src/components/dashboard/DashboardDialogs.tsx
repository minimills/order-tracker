// @permission-scope dashboard.charts.customize, dashboard.share, dashboard.charts.print
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import Can from '../Can'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'
import { CHART_TYPES, chartDef, RANGES, type ChartType, type RangeKey } from '../../lib/dashboardCharts'
import type { DashData } from '../../lib/dashboardData'
import { friendlyError } from '../../lib/format'
import type { Item } from '../../lib/gridLayout'
import { usePermissions } from '../../lib/permissions'
import { supabase } from '../../lib/supabase'
import { useDepartments } from '../../lib/useDepartments'
import { WIDGET_COLOURS, WIDGETS, widgetAllowed, widgetDef, widgetTitle, type Widget } from '../../lib/widgets'
import { ACTION } from '../../lib/wording'

/** Add Widget: only the widgets this person is allowed to see (the template editor offers all). */
export function WidgetLibraryDialog({ onAdd, onClose, showAll }: { have?: string[]; onAdd: (key: string) => void; onClose: () => void; showAll?: boolean }) {
  const { can } = usePermissions()
  const [q, setQ] = useState('')
  const [added, setAdded] = useState<string[]>([])
  const list = WIDGETS.filter((w) => (showAll || widgetAllowed(w, can)) && (!q || `${w.title} ${w.group} ${w.description}`.toLowerCase().includes(q.toLowerCase())))
  const groups = [...new Set(list.map((w) => w.group))]
  return (
    <Modal
      title="Add a Widget"
      wide
      onClose={onClose}
      footer={
        <button type="button" className={buttonClass} onClick={onClose}>
          {ACTION.close}
        </button>
      }
    >
      <input aria-label="Search widgets" placeholder="Search widgets" className={`${inputClass} mb-3`} value={q} onChange={(e) => setQ(e.target.value)} />
      {groups.length === 0 && <p className="text-sm text-slate-500">No widgets match.</p>}
      <div className="space-y-4">
        {groups.map((g) => (
          <section key={g}>
            <h3 className="mb-1 text-sm font-semibold text-slate-600">{g}</h3>
            <ul className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]">
              {list
                .filter((w) => w.group === g)
                .map((w) => (
                  <li key={w.key} className="flex items-start gap-2 rounded-md border border-slate-200 p-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{w.title}</span>
                      <span className="block text-xs text-slate-500">{w.description}</span>
                    </span>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => {
                        onAdd(w.key)
                        setAdded([...added, w.key])
                      }}
                    >
                      {added.includes(w.key) ? 'Add Again' : ACTION.add}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  )
}

/** One widget's settings: title, form, dates, compare, filters, colour, size, list length. */
export function WidgetSettingsDialog({
  widget,
  size,
  cols,
  data,
  onClose,
  onSave,
}: {
  widget: Widget
  size?: Item
  cols: number
  data: DashData
  onClose: () => void
  onSave: (w: Widget, size?: Partial<Item>) => void
}) {
  const def = widgetDef(widget.key)
  const chart = def?.kind === 'chart' ? chartDef(widget.key.slice(6)) : undefined
  const [w, setW] = useState<Widget>(widget)
  const [sz, setSz] = useState({ w: size?.w ?? def?.w ?? 4, h: size?.h ?? def?.h ?? 3 })
  const { departments } = useDepartments()
  const [opts, setOpts] = useState<{ types: string[]; countries: string[]; boards: { id: string; name: string }[] }>({ types: [], countries: [], boards: [] })
  useEffect(() => {
    Promise.all([data.machineTypes(), data.summary(), data.boards()]).then(([t, o, b]) =>
      setOpts({ types: t.map((x) => x.name), countries: [...new Set(o.map((x) => x.customer_country).filter(Boolean) as string[])].sort(), boards: b }),
    )
  }, [data])
  if (!def) return null
  const displays = (def.displays ?? []).filter((t) => !chart || chart.types.includes(t))
  const f = def.filters ?? []
  const setF = (k: string, v: string) => setW({ ...w, filters: { ...w.filters, [k]: v || undefined } })
  const range = w.range ?? (def.kind === 'chart' ? '12m' : def.key === 'kpi:average_delay' ? 'ytd' : 'month')

  return (
    <Modal
      title={`Widget Settings: ${widgetTitle(widget)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} onClick={() => onSave({ ...w, range: def.range ? (range as RangeKey) : undefined }, size && (sz.w !== size.w || sz.h !== size.h) ? sz : undefined)}>
            {ACTION.save}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Title" htmlFor="ws-title" hint={`Empty = “${def.title}”.`}>
          <input id="ws-title" className={inputClass} maxLength={60} value={w.title ?? ''} onChange={(e) => setW({ ...w, title: e.target.value })} />
        </Field>
        {displays.length > 1 && (
          <Can permission="dashboard.charts.form">
            <Field label="Form" htmlFor="ws-form">
              <select id="ws-form" className={inputClass} value={w.display ?? displays[0]} onChange={(e) => setW({ ...w, display: e.target.value as ChartType })}>
                {CHART_TYPES.filter((t) => displays.includes(t.key)).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            {w.display === 'gauge_targets' && <p className="text-xs text-slate-500">The red, amber and green targets are set by an admin in Admin → Dashboard Charts.</p>}
          </Can>
        )}
        {def.range && (
          <Can permission="dashboard.charts.dates">
            <Field label="Dates" htmlFor="ws-range">
              <select id="ws-range" className={inputClass} value={range} onChange={(e) => setW({ ...w, range: e.target.value as RangeKey })}>
                {RANGES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            {range === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="From" htmlFor="ws-from">
                  <input id="ws-from" type="date" className={inputClass} value={w.from ?? ''} onChange={(e) => setW({ ...w, from: e.target.value })} />
                </Field>
                <Field label="To" htmlFor="ws-to">
                  <input id="ws-to" type="date" className={inputClass} value={w.to ?? ''} onChange={(e) => setW({ ...w, to: e.target.value })} />
                </Field>
              </div>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!w.compare} onChange={(e) => setW({ ...w, compare: e.target.checked })} />
              Compare with the same dates last year
            </label>
          </Can>
        )}
        {f.length > 0 && (
          <Can permission="dashboard.widget.filters">
            <fieldset className="space-y-2">
              <legend className="font-medium">Filters</legend>
              {f.includes('department') && (
                <select aria-label="Department" className={inputClass} value={w.filters?.department ?? ''} onChange={(e) => setF('department', e.target.value)}>
                  <option value="">Every department</option>
                  {departments
                    .filter((d) => !d.archived)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              )}
              {f.includes('machineType') && (
                <select aria-label="Machine type" className={inputClass} value={w.filters?.machineType ?? ''} onChange={(e) => setF('machineType', e.target.value)}>
                  <option value="">Every machine type</option>
                  {opts.types.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              {f.includes('country') && (
                <select aria-label="Customer country" className={inputClass} value={w.filters?.country ?? ''} onChange={(e) => setF('country', e.target.value)}>
                  <option value="">Every country</option>
                  {opts.countries.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              {f.includes('board') && (
                <select aria-label="Board" className={inputClass} value={w.filters?.board ?? ''} onChange={(e) => setF('board', e.target.value)}>
                  <option value="">{def.kind === 'list' ? 'Every board' : 'Choose a board'}</option>
                  {opts.boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              )}
            </fieldset>
          </Can>
        )}
        {def.limit && (
          <Field label="Lines to show" htmlFor="ws-limit">
            <input id="ws-limit" type="number" min={1} max={50} className={`${narrowInputClass} w-24`} value={w.limit ?? def.limit} onChange={(e) => setW({ ...w, limit: Math.max(1, Math.min(50, Number(e.target.value) || def.limit!)) })} />
          </Field>
        )}
        <Can permission="dashboard.widget.colour">
          <fieldset>
            <legend className="mb-1 font-medium">Colour</legend>
            <div className="flex flex-wrap gap-2">
              {WIDGET_COLOURS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={(w.colour ?? 'blue') === c.key}
                  onClick={() => setW({ ...w, colour: c.key })}
                  className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${(w.colour ?? 'blue') === c.key ? 'border-slate-900 font-semibold' : 'border-slate-300'}`}
                >
                  <span className="h-3 w-3 rounded-full" style={{ background: c.hex }} aria-hidden="true" />
                  {c.label}
                </button>
              ))}
            </div>
          </fieldset>
        </Can>
        {size && (
          <fieldset>
            <legend className="mb-1 font-medium">Size on this screen</legend>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">
                Width
                <input type="number" min={1} max={cols} className={`${narrowInputClass} w-20`} value={sz.w} onChange={(e) => setSz({ ...sz, w: Math.max(1, Math.min(cols, Number(e.target.value) || 1)) })} />
                of {cols} columns
              </label>
              <label className="flex items-center gap-1">
                Height
                <input type="number" min={1} max={20} className={`${narrowInputClass} w-20`} value={sz.h} onChange={(e) => setSz({ ...sz, h: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
                rows
              </label>
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  )
}

/** Share a copy of a dashboard with other people. */
export function ShareDashboardDialog({ dashboardId, name, onClose }: { dashboardId: string; name: string; onClose: () => void }) {
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    supabase?.rpc('dashboard_share_people').then(({ data }) => setPeople((data as { email: string; name: string }[]) ?? []))
  }, [])
  async function share() {
    if (!supabase) return
    setBusy(true)
    const { data, error } = await supabase.rpc('share_dashboard', { p_id: dashboardId, p_emails: chosen })
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`A copy of “${name}” was given to ${data} ${data === 1 ? 'person' : 'people'}.`)
    onClose()
  }
  return (
    <Modal
      title="Share a Copy of This Dashboard"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} disabled={busy || chosen.length === 0} onClick={share}>
            Share ({chosen.length})
          </button>
        </>
      }
    >
      <p className="mb-2 text-sm text-slate-600">Each person gets their own copy of “{name}”. They only see the widgets they are allowed to see, and their changes do not change yours.</p>
      {people.length === 0 ? (
        <p className="text-sm text-slate-500">Nobody else can open the dashboard yet.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
          {people.map((p) => (
            <li key={p.email}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={chosen.includes(p.email)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.email] : chosen.filter((x) => x !== p.email))} />
                {p.name}
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/** Print: the whole dashboard or chosen widgets, with a title. */
export function PrintDashboardDialog({ widgets, name, onPrint, onClose }: { widgets: Widget[]; name: string; onPrint: (title: string, ids: string[]) => void; onClose: () => void }) {
  const [title, setTitle] = useState(name)
  const [ids, setIds] = useState(widgets.filter((w) => widgetDef(w.key)?.kind !== 'note').map((w) => w.id))
  return (
    <Modal
      title="Print Dashboard"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.cancel}
          </button>
          <button type="button" className={buttonClass} disabled={!ids.length} onClick={() => onPrint(title, ids)}>
            Open Printable Page
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Report title" htmlFor="pd-title">
          <input id="pd-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="flex gap-3">
          <button type="button" className="text-xs underline" onClick={() => setIds(widgets.map((w) => w.id))}>
            {ACTION.selectAll}
          </button>
          <button type="button" className="text-xs underline" onClick={() => setIds([])}>
            {ACTION.clearSelection}
          </button>
        </div>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {widgets.map((w) => (
            <li key={w.id}>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ids.includes(w.id)} onChange={(e) => setIds(e.target.checked ? [...ids, w.id] : ids.filter((x) => x !== w.id))} />
                {widgetTitle(w)}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
