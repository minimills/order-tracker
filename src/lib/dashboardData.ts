import { chartData } from './dashboardCharts'
import { todayISO } from './dates'
import { fetchAll } from './fetchAll'
import { supabase } from './supabase'
import type { OrderSummaryRow, PaymentRow } from './types'

/**
 * Everything the dashboard widgets read, each source loaded once per refresh
 * and shared by the widgets that need it. Every query runs with the person's
 * own permissions (row security), so a widget never shows more than they may see.
 */
export type DashData = ReturnType<typeof dashData>

export type MyTask = { id: string; title: string; due_date: string | null; board_id: string; board_name: string }
export type CalendarRow = { source: string; kind: string; title: string; customer: string | null; start_date: string; end_date: string; start_at: string | null; end_at: string | null; link: string | null }

export function dashData() {
  const charts = chartData()
  const cache = new Map<string, Promise<unknown>>()
  const once = <T,>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch(() => [] as unknown as T))
    return cache.get(key) as Promise<T>
  }
  const today = todayISO()
  return {
    ...charts,
    loadedAt: new Date(),
    summary: () => once('summary', async () => (await fetchAll<OrderSummaryRow>(() => supabase!.from('order_summary').select('*').eq('archived', false).order('id'))).data),
    payDue: () =>
      once('payDue', async () =>
        (
          await fetchAll<PaymentRow>(() =>
            supabase!.from('payment_overview').select('*').gt('remaining', 0).eq('order_archived', false).neq('stage', 'Cancelled').order('due_date', { nullsFirst: false }).order('id'),
          )
        ).data,
      ),
    orderMachines: () => charts.machines(),
    myTasks: (email: string) =>
      once('myTasks', async () => {
        const a = await supabase!.from('board_card_assignees').select('card_id').eq('user_email', email)
        const ids = ((a.data as { card_id: string }[] | null) ?? []).map((r) => r.card_id)
        if (!ids.length) return [] as MyTask[]
        const [c, b] = await Promise.all([
          supabase!.from('board_cards').select('id, title, due_date, board_id').in('id', ids.slice(0, 300)).eq('archived', false).is('finished_at', null),
          charts.boards(),
        ])
        const names = new Map(b.map((x) => [x.id, x.name]))
        return ((c.data as Omit<MyTask, 'board_name'>[] | null) ?? [])
          .filter((t) => names.has(t.board_id))
          .map((t) => ({ ...t, board_name: names.get(t.board_id)! }))
          .sort((x, y) => (x.due_date ?? '9999').localeCompare(y.due_date ?? '9999'))
      }),
    // My own calendar (and entries shared with me): asking for everyone needs "other people's calendars".
    calendarToday: (email: string) =>
      once('calendar', async () => ((await supabase!.rpc('calendar_entries', { p_from: today, p_to: today, p_tech: email || null })).data as CalendarRow[] | null) ?? []),
    events: () =>
      once('events', async () =>
        ((await supabase!.rpc('my_company_events', { p_past: false })).data as { id: string; title: string; start_date: string; end_date: string; starts_at: string | null; all_day: boolean; location: string | null }[] | null) ?? [],
      ),
    holidays: () =>
      once('holidays', async () =>
        ((
          await supabase!
            .from('company_holidays')
            .select('id, name, start_date, end_date, kind')
            .eq('hidden', false)
            .gte('end_date', today)
            .lte('start_date', `${today.slice(0, 4)}-12-31`)
            .order('start_date')
        ).data as { id: string; name: string; start_date: string; end_date: string; kind: string }[] | null) ?? [],
      ),
    notices: () =>
      once('notices', async () =>
        ((
          await supabase!
            .from('notices')
            .select('id, title, priority, category, created_at, pinned')
            .eq('archived', false)
            .lte('show_from', today)
            .order('pinned', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(30)
        ).data as { id: string; title: string; priority: string; category: string | null; created_at: string; pinned: boolean }[] | null) ?? [],
      ),
    chats: () =>
      once('chats', async () =>
        ((await supabase!.rpc('my_chat_conversations')).data as { id: string; name: string; unread: number; mentions: number; last_text: string | null; last_message_at: string | null; my_archived: boolean; hidden: boolean }[] | null) ?? [],
      ),
    cratesFull: () =>
      once('cratesFull', async () =>
        (await fetchAll<{ crated_on: string; plywood_sheets: number | null; build_hours: number | null }>(() => supabase!.from('crate_report').select('crated_on, plywood_sheets, build_hours').order('id'))).data,
      ),
    labour: (from: string, to: string) =>
      once(`labour:${from}:${to}`, async () => {
        const { data, error } = await supabase!.rpc('labour_cost_weeks', { p_from: from < '2000-01-01' ? '2000-01-01' : from, p_to: to > '2100-01-01' ? '2100-01-01' : to })
        if (error) throw error
        return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
          department_id: r.department_id as string | null,
          week_start: String(r.week_start),
          cost_total: Number(r.cost_total),
          cost_overtime: Number(r.cost_overtime),
          paid_hours: Number(r.paid_regular) + Number(r.paid_overtime) + Number(r.vacation) + Number(r.sick) + Number(r.stat),
          worked: Number(r.worked),
        }))
      }),
    machineTypes: () => once('machineTypes', async () => ((await supabase!.from('machine_types').select('name').eq('archived', false).order('name')).data as { name: string }[] | null) ?? []),
  }
}

/** "Updated 2:35 p.m." (Halifax time). */
export function updatedText(d: Date) {
  return `Updated ${d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Halifax' })}`
}
