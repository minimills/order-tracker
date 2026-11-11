// @permission-scope notices.events.post
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { todayISO } from '../../lib/dates'
import { EVENT_COLOURS, REMINDER_CHOICES, type CompanyEvent, type EventColour } from '../../lib/events'
import { friendlyError } from '../../lib/format'
import { useAudienceChoices, type Audience } from '../../lib/notices'
import { isEmptyRichText } from '../../lib/richText'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import RichTextEditor from '../RichTextEditor'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'

type Target = Pick<Audience, 'target_type' | 'target'>
const halifaxParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
/** A stored time as Halifax date ("2026-11-12") and time ("14:00"). */
function halifax(iso: string | null) {
  if (!iso) return { date: '', time: '' }
  const p = Object.fromEntries(halifaxParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

/** Create or change an event (people with "post events"). The database checks every permission again. */
export default function EventDialog({ event, audience, onClose, onSaved }: { event: CompanyEvent | null; audience: { target_type: Target['target_type']; target: string }[]; onClose: () => void; onSaved: () => void }) {
  const choices = useAudienceChoices(false)
  const [people, setPeople] = useState<{ email: string; name: string }[]>([])
  const start = halifax(event?.starts_at ?? null)
  const end = halifax(event?.ends_at ?? null)
  const [title, setTitle] = useState(event?.title ?? '')
  const [allDay, setAllDay] = useState(event?.all_day ?? false)
  const [date, setDate] = useState(event ? (event.all_day ? event.start_date : start.date) : todayISO())
  const [endDate, setEndDate] = useState(event?.all_day && event.end_date !== event.start_date ? event.end_date : '')
  const [startTime, setStartTime] = useState(start.time || '09:00')
  const [endTime, setEndTime] = useState(end.time)
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [colour, setColour] = useState<EventColour | null>(event?.colour ?? null)
  const [everyone, setEveryone] = useState(event?.audience_everyone ?? true)
  const [targets, setTargets] = useState<Target[]>(audience.map((a) => ({ target_type: a.target_type, target: a.target })))
  const [pick, setPick] = useState<{ type: Target['target_type']; target: string }>({ type: 'department', target: '' })
  const [rsvp, setRsvp] = useState(event?.rsvp_enabled ?? false)
  const [remind, setRemind] = useState<number[]>(event?.remind_minutes ?? [1440, 60])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase?.rpc('event_people_choices').then(({ data }) => setPeople((data as typeof people) ?? []))
  }, [])

  const nameOf = (t: Target) => (t.target_type === 'user' ? (people.find((p) => p.email === t.target)?.name ?? t.target) : choices.nameOf(t))
  const has = (t: Target) => targets.some((x) => x.target_type === t.target_type && x.target === t.target)
  const pickList =
    pick.type === 'user'
      ? people.map((p) => ({ id: p.email, name: p.name }))
      : pick.type === 'group'
        ? choices.groups.map((g) => ({ id: g.id, name: g.name }))
        : choices.departments.map((d) => ({ id: d.id, name: d.name }))

  async function save() {
    if (!supabase) return
    if (!title.trim()) return setError('Enter a title.')
    if (!date) return setError('Choose the date.')
    if (allDay && endDate && endDate < date) return setError('The last day must be on or after the first day.')
    if (!allDay && !startTime) return setError('Enter the start time.')
    if (!allDay && endTime && endTime <= startTime) return setError('The end time must be after the start time.')
    if (!everyone && targets.length === 0) return setError('Choose who the event is for.')
    if (remind.length > 5) return setError('Choose up to 5 reminders.')
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.rpc('save_company_event', {
      p: {
        id: event?.id ?? null,
        title: title.trim(),
        description: isEmptyRichText(description) ? '' : description,
        location: location.trim() || null,
        all_day: allDay,
        start_date: date,
        end_date: allDay ? endDate || date : null,
        // Times are Halifax time (the database turns them into exact moments).
        starts_at: allDay ? null : `${date} ${startTime} America/Halifax`,
        ends_at: allDay || !endTime ? null : `${date} ${endTime} America/Halifax`,
        colour,
        everyone,
        audience: everyone ? [] : targets.map((t) => ({ type: t.target_type, target: t.target })),
        rsvp_enabled: rsvp,
        remind_minutes: remind,
      },
    })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    toast.success(event ? 'Event updated.' : 'Event added.')
    onSaved()
  }

  return (
    <Modal
      title={event ? 'Edit Event' : 'Add an Event'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <Can permission="notices.events.post" level="edit">
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : event ? ACTION.save : 'Add Event'}
            </button>
          </Can>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" htmlFor="ev-title">
          <input id="ev-title" className={inputClass} maxLength={200} placeholder="for example Monthly safety meeting" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day (or several days)
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={allDay ? 'First day' : 'Date'} htmlFor="ev-date">
            <input id="ev-date" type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {allDay ? (
            <Field label="Last day (optional)" htmlFor="ev-end-date" hint="Leave empty for one day.">
              <input id="ev-end-date" type="date" className={inputClass} min={date} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
          ) : (
            <>
              <Field label="Starts" htmlFor="ev-start">
                <input id="ev-start" type="time" className={inputClass} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </Field>
              <Field label="Ends (optional)" htmlFor="ev-end">
                <input id="ev-end" type="time" className={inputClass} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        {!allDay && <p className="-mt-2 text-xs text-slate-500">Times are Halifax time.</p>}

        <Field label="Location (optional)" htmlFor="ev-loc">
          <input id="ev-loc" className={inputClass} maxLength={300} placeholder="for example Lunch room" value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">Description (optional)</span>
          <RichTextEditor value={description} onChange={setDescription} label="Description" minHeight="5rem" />
        </div>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">Colour (optional)</legend>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={colour === null}
              onClick={() => setColour(null)}
              className={`h-8 rounded border border-slate-300 px-2 text-xs ${colour === null ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
            >
              None
            </button>
            {EVENT_COLOURS.map((c) => (
              <button
                key={c.value}
                type="button"
                title={c.label}
                aria-label={c.label}
                aria-pressed={colour === c.value}
                onClick={() => setColour(c.value)}
                style={{ backgroundColor: c.stripe }}
                className={`h-8 w-8 rounded ${colour === c.value ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">Who is it for</legend>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="ev-aud" className="h-4 w-4" checked={everyone} onChange={() => setEveryone(true)} />
              Everyone
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="ev-aud" className="h-4 w-4" checked={!everyone} onChange={() => setEveryone(false)} />
              Chosen people, groups and departments
            </label>
            {!everyone && (
              <div className="rounded-md border border-slate-200 p-3">
                <div className="flex flex-wrap gap-2">
                  <select aria-label="Type" className={`${narrowInputClass} w-36`} value={pick.type} onChange={(e) => setPick({ type: e.target.value as Target['target_type'], target: '' })}>
                    <option value="user">A person</option>
                    <option value="group">A group</option>
                    <option value="department">A department</option>
                  </select>
                  <select aria-label="Which" className={`${narrowInputClass} min-w-40 flex-1`} value={pick.target} onChange={(e) => setPick({ ...pick, target: e.target.value })}>
                    <option value="">Select…</option>
                    {pickList.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={!pick.target}
                    onClick={() => {
                      const t = { target_type: pick.type, target: pick.target }
                      if (!has(t)) setTargets([...targets, t])
                      setPick({ ...pick, target: '' })
                    }}
                  >
                    {ACTION.add}
                  </button>
                </div>
                {targets.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">Nobody chosen yet.</p>
                ) : (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {targets.map((t) => (
                      <li key={`${t.target_type}:${t.target}`} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs">
                        <span className="text-slate-500">{t.target_type === 'user' ? 'Person' : t.target_type === 'group' ? 'Group' : 'Department'}:</span> {nameOf(t)}
                        <button
                          type="button"
                          className="rounded-full px-1.5 hover:bg-slate-200"
                          aria-label={`${ACTION.remove} ${nameOf(t)}`}
                          onClick={() => setTargets(targets.filter((x) => !(x.target_type === t.target_type && x.target === t.target)))}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={rsvp} onChange={(e) => setRsvp(e.target.checked)} />
          <span>
            Ask people to answer Going, Not going or Maybe
            <span className="block text-xs text-slate-500">You see the list of answers; everyone sees the totals.</span>
          </span>
        </label>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">Reminders (in the app and by phone push)</legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {REMINDER_CHOICES.map((r) => (
              <label key={r.minutes} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={remind.includes(r.minutes)}
                  onChange={(e) => setRemind(e.target.checked ? [...remind, r.minutes] : remind.filter((m) => m !== r.minutes))}
                />
                {r.label}
              </label>
            ))}
          </div>
          {allDay && <p className="mt-1 text-xs text-slate-500">All-day events are counted from 8:00 a.m. on the first day.</p>}
        </fieldset>

        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
