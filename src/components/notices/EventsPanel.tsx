// @permission-scope notices.events
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useCompany } from '../../lib/company'
import { confirmAction } from '../../lib/confirm'
import {
  countdown,
  downloadIcs,
  googleCalendarUrl,
  loadEvents,
  RSVP_LABEL,
  stripeOf,
  whenText,
  type CompanyEvent,
  type Rsvp,
  type RsvpRow,
} from '../../lib/events'
import { friendlyError } from '../../lib/format'
import { useAudienceChoices, type Audience } from '../../lib/notices'
import { supabase } from '../../lib/supabase'
import { ACTION, confirmText } from '../../lib/wording'
import Can from '../Can'
import Icon from '../Icon'
import RichText from '../RichText'
import { Modal, secondaryButtonClass } from '../form'
import EventDialog from './EventDialog'

type EventAudience = { event_id: string; target_type: Audience['target_type']; target: string }

/** Upcoming events meant for me (below Upcoming Holidays), with the countdown, RSVP and "Add to My Calendar". */
export default function EventsPanel({ highlightId, onMissing }: { highlightId: string | null; onMissing: () => void }) {
  const [list, setList] = useState<CompanyEvent[] | null>(null)
  const [audience, setAudience] = useState<EventAudience[]>([])
  const [open, setOpen] = useState<string | null>(highlightId)
  const [editing, setEditing] = useState<CompanyEvent | 'new' | null>(null)
  const choices = useAudienceChoices(false)

  const load = useCallback(async () => {
    try {
      const events = await loadEvents(false)
      setList(events)
      if (events.length && supabase) {
        const { data } = await supabase.from('company_event_audience').select('event_id, target_type, target').in('event_id', events.map((e) => e.id))
        setAudience((data as EventAudience[]) ?? [])
      }
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
      setList([])
    }
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  // A link to one event (from a reminder): open it, or look in the Archive if it is over.
  useEffect(() => {
    if (!highlightId || !list) return
    if (list.some((e) => e.id === highlightId)) {
      // oxlint-disable-next-line react/set-state-in-effect
      setOpen(highlightId)
      window.setTimeout(() => document.getElementById(`event-${highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100)
    } else onMissing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, list])

  const audienceText = (e: CompanyEvent) =>
    e.audience_everyone ? 'Everyone' : audience.filter((a) => a.event_id === e.id).map(choices.nameOf).join(', ') || 'Chosen people'

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label="Upcoming events">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
          <Icon name="calendar" /> Upcoming Events
        </h2>
        <Can permission="notices.events.post" level="edit">
          <button type="button" className="text-xs font-medium text-slate-700 underline" onClick={() => setEditing('new')}>
            Add Event
          </button>
        </Can>
      </div>
      {list === null ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : list.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No upcoming events.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {list.map((e) => (
            <EventItem
              key={e.id}
              event={e}
              open={open === e.id}
              highlight={highlightId === e.id}
              audienceText={audienceText(e)}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
              onEdit={() => setEditing(e)}
              onChanged={load}
            />
          ))}
        </ul>
      )}
      {editing && (
        <EventDialog
          event={editing === 'new' ? null : editing}
          audience={editing === 'new' ? [] : audience.filter((a) => a.event_id === editing.id)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </section>
  )
}

/** One event: a line with the countdown; opens to show the details. */
function EventItem({
  event: e,
  open,
  highlight,
  audienceText,
  onToggle,
  onEdit,
  onChanged,
  past = false,
}: {
  event: CompanyEvent
  open: boolean
  highlight: boolean
  audienceText: string
  onToggle: () => void
  onEdit?: () => void
  onChanged: () => void
  past?: boolean
}) {
  const company = useCompany()
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState(false)
  const when = countdown(e)
  const today = when.today && !past

  async function run(fn: () => PromiseLike<{ error: { message?: string; code?: string } | null }>, done?: string) {
    setBusy(true)
    const { error } = await fn()
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    if (done) toast.success(done)
    onChanged()
  }
  const answer = (r: Rsvp) => run(() => supabase!.rpc('set_event_rsvp', { p_event: e.id, p_response: e.my_response === r ? null : r }))
  async function archive() {
    if (!e.archived && !(await confirmAction(confirmText.archive('this event'), { confirmLabel: ACTION.archive }))) return
    await run(() => supabase!.rpc('archive_company_event', { p_event: e.id, p_archived: !e.archived }), e.archived ? 'Event restored.' : 'Event archived.')
  }

  return (
    <li
      id={`event-${e.id}`}
      className={`rounded-md border-l-4 ${today ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-white'} ${highlight ? 'outline outline-2 outline-offset-2 outline-blue-500' : ''}`}
      style={{ borderLeftColor: stripeOf(e.colour) }}
    >
      <button type="button" className="w-full px-2.5 py-2 text-left" onClick={onToggle} aria-expanded={open}>
        <span className="block font-medium text-slate-900">{e.title}</span>
        <span className="block text-xs text-slate-500">
          <span className={`font-semibold ${today ? 'text-red-700' : 'text-slate-700'}`}>{past ? (e.archived ? 'Archived' : 'Past') : when.text}</span>
          {' · '}
          {whenText(e)}
          {e.location && ` · ${e.location}`}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-slate-100 px-2.5 pb-2.5 pt-2 text-sm">
          {e.description_text && <RichText value={e.description} className="text-sm" />}
          <div className="text-xs text-slate-600">
            <div>Organizer: {e.organizer_name ?? 'someone who has left'}</div>
            <div>For: {audienceText}</div>
          </div>

          {e.rsvp_enabled && (
            <div>
              <div className="text-xs text-slate-600">
                {e.going} going · {e.maybe} maybe · {e.not_going} not going
              </div>
              {!past && (
                <Can permission="notices.events.rsvp" level="edit">
                  <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Your answer">
                    {(['going', 'maybe', 'not_going'] as Rsvp[]).map((r) => (
                      <button
                        key={r}
                        type="button"
                        disabled={busy}
                        aria-pressed={e.my_response === r}
                        onClick={() => answer(r)}
                        className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                          e.my_response === r ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white hover:bg-slate-50'
                        }`}
                      >
                        {RSVP_LABEL[r]}
                      </button>
                    ))}
                  </div>
                </Can>
              )}
            </div>
          )}

          {!past && (
            <Can permission="notices.events.calendar">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="text-slate-600">Add to My Calendar:</span>
                <button type="button" className="underline" onClick={() => downloadIcs(e, company.name)}>
                  Apple or Outlook
                </button>
                <a href={googleCalendarUrl(e)} target="_blank" rel="noopener noreferrer" className="underline">
                  Google Calendar
                </a>
              </div>
            </Can>
          )}

          {e.can_manage && (
            <Can permission="notices.events.post" level="edit">
              <div className="flex flex-wrap gap-x-3 text-xs">
                {e.rsvp_enabled && (
                  <button type="button" className="underline" onClick={() => setAnswers(true)}>
                    Who Answered
                  </button>
                )}
                {!past && onEdit && (
                  <button type="button" className="underline" onClick={onEdit}>
                    {ACTION.edit}
                  </button>
                )}
                {(!past || e.archived) && (
                  <button type="button" className="underline" disabled={busy} onClick={archive}>
                    {e.archived ? ACTION.restore : ACTION.archive}
                  </button>
                )}
              </div>
            </Can>
          )}
        </div>
      )}
      {answers && <RsvpListDialog event={e} onClose={() => setAnswers(false)} />}
    </li>
  )
}

/** The organizer's list: who is going, maybe, not going, and who hasn't answered. */
function RsvpListDialog({ event, onClose }: { event: CompanyEvent; onClose: () => void }) {
  const [rows, setRows] = useState<RsvpRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    supabase?.rpc('event_rsvp_list', { p_event: event.id }).then(({ data, error: e }) => {
      if (e) setError(friendlyError(e))
      else setRows((data as RsvpRow[]) ?? [])
    })
  }, [event.id])
  const groups: { title: string; rows: RsvpRow[] }[] = rows
    ? [
        { title: 'Going', rows: rows.filter((r) => r.response === 'going') },
        { title: 'Maybe', rows: rows.filter((r) => r.response === 'maybe') },
        { title: 'Not going', rows: rows.filter((r) => r.response === 'not_going') },
        { title: 'No answer yet', rows: rows.filter((r) => !r.response) },
      ]
    : []
  return (
    <Modal
      title="Who Answered"
      onClose={onClose}
      footer={
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          {ACTION.close}
        </button>
      }
    >
      <p className="text-sm text-slate-600">{event.title}</p>
      {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
      {!rows && !error && <p className="mt-3 text-sm text-slate-500">Loading…</p>}
      <div className="mt-3 space-y-3 text-sm">
        {groups.map((g) => (
          <div key={g.title}>
            <h3 className="font-medium">
              {g.title} ({g.rows.length})
            </h3>
            {g.rows.length === 0 ? (
              <p className="text-xs text-slate-500">Nobody.</p>
            ) : (
              <ul className="mt-0.5 text-slate-700">
                {g.rows.map((r) => (
                  <li key={r.email}>{r.name}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

/** Archive tab: events that are over (or archived), with the same search as notices. */
export function PastEvents({ search, highlightId }: { search: string; highlightId: string | null }) {
  const [list, setList] = useState<CompanyEvent[] | null>(null)
  const [open, setOpen] = useState<string | null>(highlightId)
  const choices = useAudienceChoices(false)
  const [audience, setAudience] = useState<EventAudience[]>([])
  const load = useCallback(async () => {
    try {
      const events = await loadEvents(true)
      setList(events)
      if (events.length && supabase) {
        const { data } = await supabase.from('company_event_audience').select('event_id, target_type, target').in('event_id', events.map((e) => e.id))
        setAudience((data as EventAudience[]) ?? [])
      }
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
      setList([])
    }
  }, [])
  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  const q = search.trim().toLowerCase()
  const shown = (list ?? []).filter((e) => !q || `${e.title} ${e.description_text} ${e.location ?? ''} ${e.organizer_name ?? ''}`.toLowerCase().includes(q))
  if (list === null || (list.length === 0 && !q)) return null
  return (
    <section aria-label="Past events" className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Past Events</h2>
      {shown.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-center text-sm text-slate-500">No past events match this search.</p>
      ) : (
        <ul className="space-y-1.5 rounded-lg border border-slate-200 bg-white p-3">
          {shown.map((e) => (
            <EventItem
              key={e.id}
              event={e}
              past
              open={open === e.id}
              highlight={highlightId === e.id}
              audienceText={e.audience_everyone ? 'Everyone' : audience.filter((a) => a.event_id === e.id).map(choices.nameOf).join(', ') || 'Chosen people'}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
              onChanged={load}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
