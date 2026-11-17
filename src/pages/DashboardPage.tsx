import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import DashboardCanvas from '../components/dashboard/DashboardCanvas'
import { PrintDashboardDialog, ShareDashboardDialog } from '../components/dashboard/DashboardDialogs'
import { buttonClass, secondaryButtonClass } from '../components/form'
import { useAuth } from '../lib/auth'
import { askText, confirmAction } from '../lib/confirm'
import { loadChartSettings } from '../lib/dashboardCharts'
import { dashData, updatedText } from '../lib/dashboardData'
import { showDate, todayISO } from '../lib/dates'
import { friendlyError } from '../lib/format'
import type { Layouts } from '../lib/gridLayout'
import { usePermissions } from '../lib/permissions'
import { supabase } from '../lib/supabase'
import { PRINT_KEY } from '../lib/useChart'
import { starterDashboard, type Dashboard, type Widget } from '../lib/widgets'
import { ACTION } from '../lib/wording'

const STARTER = 'starter'
/** Tables whose changes refresh the widgets (row security decides what each person receives). */
const LIVE_TABLES = ['orders', 'payments', 'order_machines', 'board_cards', 'notices', 'crates', 'time_off_requests', 'company_events']

/** The live data: a new snapshot when something changes (realtime), every 2 minutes, and when the window comes back. */
function useLiveData() {
  const [data, setData] = useState(() => dashData())
  const fresh = useCallback(() => setData(dashData()), [])
  const timer = useRef<number | undefined>(undefined)
  const bump = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fresh, 2500)
  }, [fresh])
  useEffect(() => {
    if (!supabase) return
    let channel = supabase.channel(`dashboard-live-${Math.random().toString(36).slice(2)}`)
    for (const t of LIVE_TABLES) channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, bump)
    channel.subscribe()
    const every = window.setInterval(fresh, 120000)
    const onFocus = () => document.visibilityState === 'visible' && bump()
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      supabase?.removeChannel(channel)
      window.clearInterval(every)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [bump, fresh])
  return { data, refresh: fresh }
}

/** The dashboard: the person's dashboards as tabs, each a grid of widgets they are allowed to see. */
export default function DashboardPage() {
  const { can } = usePermissions()
  const { session } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [list, setList] = useState<Dashboard[] | null>(null)
  const [editing, setEditing] = useState<{
    widgets: Widget[]
    layouts: Layouts
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [printing, setPrinting] = useState(false)
  const { data, refresh } = useLiveData()
  const canCustomize = can('dashboard.charts.customize', 'edit')
  const canTabs = can('dashboard.tabs', 'edit')

  const load = useCallback(async () => {
    if (!supabase) return
    const { data: rows, error } = await supabase.rpc('my_dashboards')
    if (error) toast.error(friendlyError(error))
    let ds = ((rows as Dashboard[] | null) ?? []).map((d) => ({
      ...d,
      widgets: d.widgets ?? [],
      layouts: d.layouts ?? {},
    }))
    if (!ds.length) {
      // No saved dashboard and no template: start from the old dashboard and the old "My Charts".
      const email = session?.user.email?.toLowerCase()
      const old = email ? await supabase.from('user_preferences').select('dashboard').eq('user_email', email).maybeSingle() : null
      const settings = await loadChartSettings()
      const start = starterDashboard((k) => can(k), (old?.data?.dashboard as Parameters<typeof starterDashboard>[1]) ?? null, settings.defaults)
      ds = [
        {
          id: STARTER,
          name: 'Overview',
          sort_order: 0,
          is_default: true,
          widgets: start.widgets,
          layouts: start.layouts,
          template_id: null,
          locked: false,
          shared_by_name: null,
        },
      ]
    }
    setList(ds)
  }, [session, can])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (!list)
    return (
      <Can permission="dashboard">
        <div className="p-8 text-center text-slate-500">Loading…</div>
      </Can>
    )
  const current = list.find((d) => d.id === params.get('tab')) ?? list.find((d) => d.is_default) ?? list[0]
  const shown = editing ?? {
    widgets: current.widgets,
    layouts: current.layouts,
  }
  const editable = canCustomize && !current.locked
  const choose = (id: string) => {
    if (editing) return toast.error('Select Done or Cancel first.')
    setParams(id === (list.find((d) => d.is_default) ?? list[0]).id ? {} : { tab: id }, { replace: true })
  }

  async function save(d: Dashboard, patch: { name?: string; widgets?: Widget[]; layouts?: Layouts }) {
    if (!supabase) return null
    const p =
      d.id === STARTER
        ? {
            name: patch.name ?? d.name,
            widgets: patch.widgets ?? d.widgets,
            layouts: patch.layouts ?? d.layouts,
          }
        : { id: d.id, ...patch }
    const { data: id, error } = await supabase.rpc('save_dashboard', { p })
    if (error) {
      toast.error(friendlyError(error))
      return null
    }
    return id as string
  }
  async function done() {
    if (!editing) return
    setBusy(true)
    const id = await save(current, editing)
    setBusy(false)
    if (!id) return
    setEditing(null)
    await load()
    if (current.id === STARTER) setParams({}, { replace: true })
    toast.success('Dashboard saved.')
  }
  async function rpc(name: string, args: Record<string, unknown>, ok?: string) {
    if (!supabase) return null
    const { data: res, error } = await supabase.rpc(name, args)
    if (error) {
      toast.error(friendlyError(error))
      return null
    }
    if (ok) toast.success(ok)
    await load()
    return res ?? true
  }
  const saved = current.id !== STARTER

  async function newDashboard() {
    const name = await askText('Name of the new dashboard, for example “Production”', { label: 'Name', confirmLabel: ACTION.create })
    if (!name) return
    if (!saved) await save(current, {})
    const id = await save({ ...current, id: STARTER }, { name, widgets: [], layouts: {} })
    if (!id) return
    await load()
    setParams({ tab: id }, { replace: true })
    setEditing({ widgets: [], layouts: {} })
  }
  async function rename() {
    const name = await askText('New name of this dashboard', {
      initial: current.name,
      label: 'Name',
      confirmLabel: ACTION.save,
    })
    if (name && (await save(current, { name }))) load()
  }
  async function move(dir: -1 | 1) {
    const ids = list!.map((d) => d.id)
    const i = ids.indexOf(current.id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    rpc('reorder_dashboards', { p_ids: ids })
  }
  async function remove() {
    if (!(await confirmAction(`Permanently delete the dashboard “${current.name}”?`, { danger: true, confirmLabel: ACTION.permanentlyDelete }))) return
    if (await rpc('delete_dashboard', { p_id: current.id }, 'Dashboard deleted.')) setParams({}, { replace: true })
  }
  async function reset() {
    if (!(await confirmAction(`Reset “${current.name}” to its template? Your changes to it are replaced.`, { confirmLabel: 'Reset to Template' }))) return
    const id = await rpc('reset_dashboard', { p_id: current.id }, 'Dashboard reset to the template.')
    if (typeof id === 'string') setParams({ tab: id }, { replace: true })
  }
  async function saveNote(widgetId: string, text: string) {
    const ws = current.widgets.map((w) => (w.id === widgetId ? { ...w, text } : w))
    if (await save(current, { widgets: ws })) setList(list!.map((d) => (d.id === current.id ? { ...d, widgets: ws } : d)))
  }
  function print(title: string, ids: string[]) {
    try {
      sessionStorage.setItem(
        PRINT_KEY,
        JSON.stringify({
          title,
          widgets: current.widgets.filter((w) => ids.includes(w.id)),
        }),
      )
    } catch {
      return toast.error('This browser does not allow the printable page. Allow site data for this page and try again.')
    }
    navigate('/dashboard/print')
  }
  const small = 'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm hover:bg-slate-50 disabled:opacity-50'

  return (
    <Can permission="dashboard">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-sm text-slate-600">
              {showDate(todayISO(), 'EEEE, MMMM d, yyyy')} · {updatedText(data.loadedAt)}
              <Can permission="dashboard.refresh">
                {' · '}
                <button type="button" className="underline" onClick={refresh}>
                  Refresh Now
                </button>
              </Can>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {editing ? (
              <Can permission="dashboard.charts.customize" level="edit">
                <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setEditing(null)}>
                  {ACTION.cancel}
                </button>
                <button type="button" className={buttonClass} disabled={busy} onClick={done}>
                  {busy ? ACTION.saving : ACTION.done}
                </button>
              </Can>
            ) : (
              <>
                <Can permission="dashboard.charts.print">
                  <button type="button" className={secondaryButtonClass} onClick={() => setPrinting(true)}>
                    {ACTION.print}
                  </button>
                </Can>
                <Can permission="dashboard.charts.customize" level="edit">
                  {editable && (
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() =>
                        setEditing({
                          widgets: current.widgets,
                          layouts: current.layouts,
                        })
                      }
                    >
                      Edit Dashboard
                    </button>
                  )}
                </Can>
              </>
            )}
          </div>
        </div>

        {/* Tabs: one per dashboard */}
        {(list.length > 1 || canTabs) && (
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-200" role="tablist" aria-label="Dashboards">
            {list.map((d) => (
              <Can key={d.id} permission="dashboard.switch">
                <button
                  type="button"
                  role="tab"
                  aria-selected={d.id === current.id}
                  onClick={() => choose(d.id)}
                  className={`-mb-px max-w-[14rem] truncate border-b-2 px-3 py-2 text-sm ${d.id === current.id ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
                >
                  {d.name}
                  {d.is_default && list.length > 1 && <span className="ml-1 text-xs font-normal text-slate-500">(default)</span>}
                </button>
              </Can>
            ))}
            <Can permission="dashboard.tabs" level="edit">
              {!editing && (
                <button type="button" className="px-2 py-2 text-sm text-blue-700 underline" onClick={newDashboard}>
                  + New Dashboard
                </button>
              )}
            </Can>
          </div>
        )}

        {/* What can be done with this dashboard */}
        {!editing && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {current.locked && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">Locked by an admin</span>}
            {current.shared_by_name && <span className="text-xs text-slate-500">A copy shared by {current.shared_by_name}</span>}
            <Can permission="dashboard.tabs" level="edit">
              {saved && !current.locked && (
                <button type="button" className={small} onClick={rename}>
                  Rename
                </button>
              )}
              {saved && (
                <button type="button" className={small} onClick={() => rpc('duplicate_dashboard', { p_id: current.id, p_name: null }, 'Dashboard duplicated.')}>
                  Duplicate
                </button>
              )}
              {saved && !current.is_default && (
                <button type="button" className={small} onClick={() => rpc('set_default_dashboard', { p_id: current.id }, `“${current.name}” opens first now.`)}>
                  Make Default
                </button>
              )}
              {saved && list.length > 1 && (
                <>
                  <button type="button" className={small} aria-label="Move this tab left" disabled={list[0].id === current.id} onClick={() => move(-1)}>
                    ←
                  </button>
                  <button type="button" className={small} aria-label="Move this tab right" disabled={list.at(-1)!.id === current.id} onClick={() => move(1)}>
                    →
                  </button>
                </>
              )}
              {saved && !current.locked && (
                <button type="button" className={`${small} text-red-700`} onClick={remove}>
                  {ACTION.permanentlyDelete}
                </button>
              )}
            </Can>
            <Can permission="dashboard.share" level="edit">
              {saved && (
                <button type="button" className={small} onClick={() => setSharing(true)}>
                  Share a Copy
                </button>
              )}
            </Can>
            <Can permission="dashboard.reset" level="edit">
              {current.template_id && (
                <button type="button" className={small} onClick={reset}>
                  Reset to Template
                </button>
              )}
            </Can>
          </div>
        )}

        <DashboardCanvas
          widgets={shown.widgets}
          layouts={shown.layouts}
          editing={!!editing}
          data={data}
          onChange={(widgets, layouts) => setEditing({ widgets, layouts })}
          onNote={saveNote}
          canEditNote={editable && saved}
        />

        {sharing && <ShareDashboardDialog dashboardId={current.id} name={current.name} onClose={() => setSharing(false)} />}
        {printing && <PrintDashboardDialog widgets={current.widgets} name={current.name} onClose={() => setPrinting(false)} onPrint={print} />}
      </div>
    </Can>
  )
}
