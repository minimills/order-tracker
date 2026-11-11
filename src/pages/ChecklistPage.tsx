import { useCallback, useEffect, useRef, useState } from 'react'
import { useBreadcrumbs } from '../lib/breadcrumbs'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import Can from '../components/Can'
import SignaturePad, { type SignaturePadHandle } from '../components/checklist/SignaturePad'
import { buttonClass, inputClass, secondaryButtonClass } from '../components/form'
import {
  checklistStatusText,
  groupBySection,
  showDateTime,
  SIGNATURE_BUCKET,
  signatureUrl,
  type Checklist,
  type ChecklistItem,
  type ChecklistStatusRow,
} from '../lib/checklists'
import { fetchAll } from '../lib/fetchAll'
import { friendlyError } from '../lib/format'
import { usePermissions } from '../lib/permissions'
import { useStageLabels } from '../lib/stages'
import { supabase } from '../lib/supabase'
import RichText from '../components/RichText'
import RichTextEditor from '../components/RichTextEditor'
import SerialNumber from '../components/SerialNumber'
import { askText } from '../lib/confirm'
import Icon from '../components/Icon'

type OrderInfo = { id: string; order_code: string; customer_name: string; customer_company: string | null; stage: string }

const NEW_SECTION = '__new'

/* @layout-helper */
function PhotoSpot({ label }: { label: string }) {
  return (
    <div className="mt-1 inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">
      <Icon name="camera" className="h-3 w-3" /> {label} – available in a future update
    </div>
  )
}

/** A note box that saves by itself a moment after you stop typing (and when you leave it). */
/* @layout-helper */
function NoteBox({
  value,
  disabled,
  placeholder,
  rows = 1,
  onSave,
}: {
  value: string | null
  disabled: boolean
  placeholder: string
  rows?: number
  onSave: (text: string) => Promise<boolean>
}) {
  const [text, setText] = useState(value ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timer = useRef<number | undefined>(undefined)
  const saved = useRef(value ?? '')

  async function flush(next = text) {
    window.clearTimeout(timer.current)
    if (next.trim() === saved.current.trim()) return
    setState('saving')
    const ok = await onSave(next)
    if (ok) saved.current = next
    setState(ok ? 'saved' : 'idle')
  }

  return (
    <div className="relative">
      <textarea
        rows={rows}
        className={`${inputClass} resize-y py-1.5`}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          setState('idle')
          window.clearTimeout(timer.current)
          const v = e.target.value
          timer.current = window.setTimeout(() => flush(v), 900)
        }}
        onBlur={() => flush()}
      />
      {state !== 'idle' && (
        <span className="absolute right-2 bottom-1 text-[10px] text-slate-400">{state === 'saving' ? 'Saving…' : 'Saved'}</span>
      )}
    </div>
  )
}

/** A formatted note box that saves by itself a moment after you stop typing. */
/* @layout-helper */
function RichNoteBox({
  value,
  disabled,
  placeholder,
  onSave,
}: {
  value: string | null
  disabled: boolean
  placeholder: string
  onSave: (html: string) => Promise<boolean>
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<string | null>(null)
  const saved = useRef(value ?? '')

  async function flush() {
    window.clearTimeout(timer.current)
    const next = pending.current
    if (next === null || next === saved.current) return
    pending.current = null
    setState('saving')
    const ok = await onSave(next)
    if (ok) saved.current = next
    setState(ok ? 'saved' : 'idle')
  }

  return (
    <div>
      <RichTextEditor
        label="General notes"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(html) => {
          pending.current = html
          setState('idle')
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(flush, 900)
        }}
        onBlur={flush}
      />
      <div className="mt-1 h-4 text-right text-xs text-slate-400">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}</div>
    </div>
  )
}

/**
 * A machine's final check: mark each item complete (or not applicable), notes, general notes and
 * sign-off. Everything saves straight away, so it can be done over several days.
 */
export default function ChecklistPage() {
  const { machineId } = useParams()
  const { can } = usePermissions()
  const label = useStageLabels()
  const [status, setStatus] = useState<ChecklistStatusRow | null>(null)
  const [order, setOrder] = useState<OrderInfo | null>(null)
  // Orders > Order 86 > Carder - Large LCR-2073 (this machine's final check)
  useBreadcrumbs(
    status && [
      { label: 'Orders', to: '/orders' },
      ...(order ? [{ label: `Order ${order.order_code}`, to: `/orders/${order.id}` }] : []),
      { label: [status.machine_type, status.serial_number].filter(Boolean).join(' ') },
    ],
  )
  const [checklist, setChecklist] = useState<Checklist | null>(null)
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [sigUrl, setSigUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [onlyOpen, setOnlyOpen] = useState(false)
  // One-off item
  const [newSection, setNewSection] = useState('')
  const [newSectionName, setNewSectionName] = useState('')
  const [newText, setNewText] = useState('')
  // Sign-off
  const [fullName, setFullName] = useState('')
  const pad = useRef<SignaturePadHandle>(null)

  const canTick = can('checklist.tick', 'edit')

  const load = useCallback(async () => {
    if (!supabase || !machineId) return
    const s = await supabase.from('machine_checklist_status').select('*').eq('machine_id', machineId).maybeSingle()
    if (s.error || !s.data) {
      setError(s.error ? friendlyError(s.error) : 'This machine could not be found.')
      setLoading(false)
      return
    }
    const st = s.data as ChecklistStatusRow
    const [o, c] = await Promise.all([
      supabase.from('order_summary').select('id, order_code, customer_name, customer_company, stage').eq('id', st.order_id).maybeSingle(),
      supabase.from('machine_checklists').select('*').eq('machine_id', machineId).maybeSingle(),
    ])
    const cl = (c.data as Checklist | null) ?? null
    const it = cl
      ? await fetchAll<ChecklistItem>(() =>
          supabase!.from('machine_checklist_items').select('*').eq('checklist_id', cl.id).order('sort_order').order('id'),
        )
      : { data: [] as ChecklistItem[], error: null }
    const e = o.error ?? c.error ?? it.error
    if (e) toast.error(friendlyError(e))
    setStatus(st)
    setOrder((o.data as OrderInfo | null) ?? null)
    setChecklist(cl)
    setItems(it.data)
    setSigUrl(cl?.signature_path ? await signatureUrl(cl.signature_path) : null)
    setError(null)
    setLoading(false)
  }, [machineId])

  useEffect(() => {
    // load() only sets state after the database answers.
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (loading)
    return (
      <Can permission="checklist">
        <div className="p-8 text-center text-slate-500">Loading…</div>
      </Can>
    )
  if (error || !status)
    return (
      <Can permission="checklist">
        <p className="p-8 text-center text-slate-700">{error}</p>
      </Can>
    )

  const locked = Boolean(checklist?.signed_at)
  const editable = canTick && !locked
  const completed = items.filter((i) => i.status !== 'open').length
  const openCount = items.length - completed
  const pct = items.length ? Math.round((completed / items.length) * 100) : 0
  const sections = groupBySection(items)
  const sectionNames = sections.map((s) => s.section)

  // ---- Saving ---------------------------------------------------------------
  async function setItemStatus(item: ChecklistItem, next: ChecklistItem['status']) {
    if (!supabase || !editable) return
    const before = items
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status: next } : i)))
    const { data, error: e } = await supabase.from('machine_checklist_items').update({ status: next }).eq('id', item.id).select().single()
    if (e) {
      setItems(before)
      return toast.error(friendlyError(e))
    }
    setItems((list) => list.map((i) => (i.id === item.id ? (data as ChecklistItem) : i)))
  }

  async function saveItemNotes(item: ChecklistItem, text: string) {
    if (!supabase) return false
    const { data, error: e } = await supabase
      .from('machine_checklist_items')
      .update({ notes: text.trim() || null })
      .eq('id', item.id)
      .select()
      .single()
    if (e) {
      toast.error(friendlyError(e))
      return false
    }
    setItems((list) => list.map((i) => (i.id === item.id ? (data as ChecklistItem) : i)))
    return true
  }

  async function saveGeneralNotes(text: string) {
    if (!supabase || !checklist) return false
    const { error: e } = await supabase.from('machine_checklists').update({ general_notes: text || null }).eq('id', checklist.id)
    if (e) {
      toast.error(friendlyError(e))
      return false
    }
    return true
  }

  async function start() {
    if (!supabase || !machineId) return
    setBusy(true)
    const { error: e } = await supabase.rpc('start_checklist', { p_machine_id: machineId })
    setBusy(false)
    if (e) return toast.error(friendlyError(e))
    toast.success('Final check started. Each change is saved automatically.')
    load()
  }

  async function addItem() {
    if (!supabase || !checklist) return
    const section = newSection === NEW_SECTION ? newSectionName.trim() : newSection
    if (!section) return toast.error('Select or enter a section.')
    if (!newText.trim()) return toast.error('Enter the item.')
    setBusy(true)
    const { error: e } = await supabase.rpc('add_checklist_item', { p_checklist_id: checklist.id, p_section: section, p_text: newText.trim() })
    setBusy(false)
    if (e) return toast.error(friendlyError(e))
    setNewText('')
    toast.success('Item added to this machine’s checklist.')
    load()
  }

  async function sign() {
    if (!supabase || !checklist) return
    if (openCount > 0) return toast.error(`${openCount} item${openCount === 1 ? ' is' : 's are'} still need to be marked complete or not applicable.`)
    if (fullName.trim().length < 3) return toast.error('Enter your full name.')
    if (!pad.current || pad.current.isEmpty()) return toast.error('Sign in the box using your finger or the mouse.')
    setBusy(true)
    const png = await pad.current.toPng()
    if (!png) {
      setBusy(false)
      return toast.error('The signature image is too large. Clear it and sign a little smaller.')
    }
    const path = `${checklist.id}/${Date.now()}.png`
    const up = await supabase.storage.from(SIGNATURE_BUCKET).upload(path, png, { contentType: 'image/png' })
    if (up.error) {
      setBusy(false)
      return toast.error(`The signature could not be saved: ${up.error.message}`)
    }
    const { error: e } = await supabase.rpc('sign_checklist', { p_checklist_id: checklist.id, p_full_name: fullName.trim(), p_signature_path: path })
    setBusy(false)
    if (e) return toast.error(friendlyError(e))
    toast.success('Final check signed and locked.')
    load()
  }

  async function unlock() {
    if (!supabase || !checklist) return
    const reason = await askText('Why does this signed final check need to be unlocked? The reason is recorded.', { label: 'Reason for unlocking', confirmLabel: 'Unlock' })
    if (!reason) return
    setBusy(true)
    const { error: e } = await supabase.rpc('unlock_checklist', { p_checklist_id: checklist.id, p_reason: reason.trim() })
    setBusy(false)
    if (e) return toast.error(friendlyError(e))
    toast.success('Final check unlocked. It must be signed again.')
    load()
  }

  return (
    <Can permission="checklist">
      <div className="mx-auto max-w-6xl space-y-5 pb-16">
        {/* ---------- Header ---------- */}
        <div>
          {order && (
            <Can
              permission="order.page"
              fallback={<div className="text-sm text-slate-600">Order {order.order_code}</div>}
            >
              <Link to={`/orders/${order.id}`} className="text-sm text-slate-600 underline">
                ← Order {order.order_code}
              </Link>
            </Can>
          )}
          <h1 className="mt-1 text-2xl font-semibold">
            Final check · {status.machine_type}{' '}
            {status.serial_number && <SerialNumber serial={status.serial_number} />}
          </h1>
          {order && (
            <p className="text-slate-600">
              {order.customer_name}
              {order.customer_company && ` · ${order.customer_company}`} · {label(order.stage)}
            </p>
          )}
        </div>

        {/* ---------- Progress ---------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className={`font-semibold ${locked ? 'text-green-700' : ''}`}>{checklistStatusText(status)}</div>
              {checklist && (
                <div className="text-xs text-slate-500">
                  Started by {checklist.started_by_name ?? '—'} on {showDateTime(checklist.started_at)}
                </div>
              )}
            </div>
            {checklist && (
              <div className="text-right">
                <div className="text-2xl font-semibold tabular-nums">
                  {completed} / {items.length}
                </div>
                <div className="text-xs text-slate-500">completed or not applicable</div>
              </div>
            )}
          </div>
          {checklist && (
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={`h-full ${locked ? 'bg-green-600' : 'bg-blue-600'}`} style={{ width: `${pct}%` }} />
            </div>
          )}
          {!checklist && (
            <div className="mt-3">
              {!status.ready ? (
                <p className="text-sm text-amber-800">Mark this machine as built on the Order page first.</p>
              ) : (
                <Can
                  permission="checklist.start"
                  level="edit"
                  fallback={<p className="text-sm text-slate-500">This final check has not been started.</p>}
                >
                  <button type="button" className={buttonClass} disabled={busy} onClick={start}>
                    Start Final Check
                  </button>
                  <p className="mt-1 text-xs text-slate-500">
                    The items are copied from the current checklist templates (general items plus those for this machine type).
                  </p>
                </Can>
              )}
            </div>
          )}
        </section>

        {checklist && (
          <>
            {/* ---------- Items ---------- */}
            <Can permission="checklist.filters">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
                Show only items still to do ({openCount})
              </label>
              <div className="flex gap-3 text-sm">
                <button type="button" className="underline" onClick={() => setCollapsed(new Set())}>
                  Expand All Sections
                </button>
                <button type="button" className="underline" onClick={() => setCollapsed(new Set(sectionNames))}>
                  Collapse All
                </button>
              </div>
            </div>
            </Can>

            {sections.map(({ section, items: list }) => {
              const shown = onlyOpen ? list.filter((i) => i.status === 'open') : list
              const done = list.filter((i) => i.status !== 'open').length
              const isClosed = collapsed.has(section)
              if (onlyOpen && shown.length === 0) return null
              return (
                <section key={section} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                  <Can
                    permission="checklist.filters"
                    fallback={
                      <div className="flex w-full items-center justify-between gap-2 bg-slate-50 px-4 py-2.5">
                        <span className="font-semibold">{section}</span>
                        <span className="text-sm text-slate-500 tabular-nums">
                          {done} / {list.length}
                        </span>
                      </div>
                    }
                  >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 bg-slate-50 px-4 py-2.5 text-left"
                    aria-expanded={!isClosed}
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s)
                        if (n.has(section)) n.delete(section)
                        else n.add(section)
                        return n
                      })
                    }
                  >
                    <span className="font-semibold">
                      <span className="mr-1 text-slate-400">{isClosed ? '▸' : '▾'}</span>
                      {section}
                    </span>
                    <span className={`text-sm tabular-nums ${done === list.length ? 'text-green-700' : 'text-slate-500'}`}>
                      {done} / {list.length}
                    </span>
                  </button>
                  </Can>
                  {!isClosed && (
                    <div>
                      <div className="hidden grid-cols-[3rem_minmax(0,2fr)_4.5rem_minmax(0,1.5fr)_10rem] gap-3 border-b border-slate-100 px-4 py-1.5 text-xs text-slate-500 md:grid">
                        <span>Completed</span>
                        <span>Item</span>
                        <span>Not Applicable</span>
                        <Can permission="checklist.col.notes">
                          <span>Notes</span>
                        </Can>
                        <Can permission="checklist.col.who">
                          <span>Who / when</span>
                        </Can>
                      </div>
                      <ul className="divide-y divide-slate-100">
                        {shown.map((item) => (
                          <li
                            key={item.id}
                            className={`grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3 md:grid-cols-[3rem_minmax(0,2fr)_4.5rem_minmax(0,1.5fr)_10rem] md:items-start ${
                              item.status === 'na' ? 'bg-slate-50' : ''
                            }`}
                          >
                            <div className="row-span-3 md:row-span-1">
                              <Can
                                permission="checklist.tick"
                                level="edit"
                                fallback={
                                  <span className="text-xs font-medium text-slate-600">
                                    {item.status === 'done' ? 'Completed' : item.status === 'na' ? 'Not applicable' : 'Open'}
                                  </span>
                                }
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`Mark complete: ${item.item_text}`}
                                  className="h-7 w-7 accent-green-700"
                                  checked={item.status === 'done'}
                                  disabled={!editable}
                                  onChange={(e) => setItemStatus(item, e.target.checked ? 'done' : 'open')}
                                />
                              </Can>
                            </div>
                            <div className={item.status === 'na' ? 'text-slate-500 line-through' : ''}>
                              {item.item_text}
                              {item.is_one_off && (
                                <span className="ml-2 rounded bg-purple-100 px-1.5 py-0.5 text-[11px] text-purple-800 no-underline">
                                  added for this machine{item.added_by_name ? ` by ${item.added_by_name}` : ''}
                                </span>
                              )}
                              <Can permission="checklist.photos">
                                <div>
                                  <PhotoSpot label="Photos for this item" />
                                </div>
                              </Can>
                            </div>
                            <div>
                              <Can
                                permission="checklist.tick"
                                level="edit"
                                fallback={item.status === 'na' ? <span className="text-sm font-medium">Not applicable</span> : null}
                              >
                                <button
                                  type="button"
                                  disabled={!editable}
                                  onClick={() => setItemStatus(item, item.status === 'na' ? 'open' : 'na')}
                                  className={`rounded-md border px-2.5 py-1.5 text-sm font-medium ${
                                    item.status === 'na' ? 'border-slate-700 bg-slate-700 text-white' : 'border-slate-300 bg-white text-slate-600'
                                  } disabled:opacity-60`}
                                  aria-pressed={item.status === 'na'}
                                >
                                  Not Applicable
                                </button>
                              </Can>
                            </div>
                            <Can permission="checklist.col.notes">
                              <div className="col-start-2 md:col-start-auto">
                                <Can
                                  permission="checklist.tick"
                                  level="edit"
                                  fallback={<p className="text-sm text-slate-700">{item.notes}</p>}
                                >
                                  <NoteBox
                                    value={item.notes}
                                    disabled={!editable}
                                    placeholder="Note (optional)"
                                    onSave={(t) => saveItemNotes(item, t)}
                                  />
                                </Can>
                              </div>
                            </Can>
                            <Can permission="checklist.col.who">
                              <div className="col-start-2 text-xs text-slate-500 md:col-start-auto">
                                {item.status_at && (
                                  <div>
                                    {item.status === 'na' ? 'Not applicable' : 'Completed'} by {item.status_by_name} · {showDateTime(item.status_at)}
                                  </div>
                                )}
                                {item.notes_at && (
                                  <div>
                                    Note: {item.notes_by_name} · {showDateTime(item.notes_at)}
                                  </div>
                                )}
                              </div>
                            </Can>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )
            })}

            {/* ---------- One-off item ---------- */}
            {!locked && (
              <Can permission="checklist.add_item" level="edit">
                <section className="rounded-lg border border-slate-200 bg-white p-4">
                  <h2 className="font-semibold">Add an Item for This Machine Only</h2>
                  <p className="text-xs text-slate-500">It is added to this checklist, not to the templates.</p>
                  <div className="mt-3 grid gap-2 md:grid-cols-[14rem_1fr_auto]">
                    <select aria-label="Section" className={inputClass} value={newSection} onChange={(e) => setNewSection(e.target.value)}>
                      <option value="">Section…</option>
                      {sectionNames.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                      <option value={NEW_SECTION}>New section…</option>
                    </select>
                    {newSection === NEW_SECTION && (
                      <input
                        aria-label="New section name"
                        className={`${inputClass} md:col-span-3 md:row-start-2`}
                        placeholder="New section name"
                        value={newSectionName}
                        onChange={(e) => setNewSectionName(e.target.value)}
                      />
                    )}
                    <input aria-label="Item" className={inputClass} placeholder="What to check" value={newText} onChange={(e) => setNewText(e.target.value)} />
                    <button type="button" className={secondaryButtonClass} onClick={addItem} disabled={busy}>
                      Add Item
                    </button>
                  </div>
                </section>
              </Can>
            )}

            {/* ---------- General notes + photos ---------- */}
            <Can permission="checklist.general_notes">
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="mb-2 font-semibold">General Notes for This Machine</h2>
                <Can
                  permission="checklist.tick"
                  level="edit"
                  fallback={<RichText value={checklist.general_notes} className="text-sm text-slate-700" />}
                >
                  <RichNoteBox
                    value={checklist.general_notes}
                    disabled={!editable}
                    placeholder="Anything about this machine's final check"
                    onSave={saveGeneralNotes}
                  />
                </Can>
                <Can permission="checklist.photos">
                  <PhotoSpot label="Photos for the Whole Checklist" />
                </Can>
              </section>
            </Can>

            {/* ---------- Sign-off ---------- */}
            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="mb-2 font-semibold">Sign-Off</h2>
              {locked ? (
                <div className="space-y-3">
                  <p className="text-green-800">
                    Signed by <strong>{checklist.signed_name}</strong> on {showDateTime(checklist.signed_at)}. This checklist
                    is locked.
                  </p>
                  {sigUrl && <img src={sigUrl} alt={`Signature of ${checklist.signed_name}`} className="max-h-32 rounded border border-slate-200 bg-white" />}
                  <div className="flex flex-wrap gap-2">
                    <Can permission="checklist.print">
                      <Link to={`/checklists/${machineId}/print`} target="_blank" className={secondaryButtonClass}>
                        Print or Save as PDF
                      </Link>
                    </Can>
                    <Can permission="checklist.unlock" level="edit">
                      <button type="button" className="text-sm text-red-700 underline" disabled={busy} onClick={unlock}>
                        Unlock…
                      </button>
                    </Can>
                  </div>
                </div>
              ) : (
                <Can
                  permission="checklist.sign"
                  level="edit"
                  fallback={<p className="text-sm text-slate-500">This final check has not been signed.</p>}
                >
                  {openCount > 0 && (
                    <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {openCount} item{openCount === 1 ? ' is' : 's are'} still need to be marked complete or not applicable before signing.
                    </p>
                  )}
                  <div className="space-y-3">
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium text-slate-700">Your full name</span>
                      <input
                        className={`${inputClass} max-w-md`}
                        value={fullName}
                        autoComplete="name"
                        onChange={(e) => setFullName(e.target.value)}
                        disabled={openCount > 0}
                      />
                    </label>
                    <div>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium text-slate-700">Sign here using your finger or the mouse</span>
                        <button type="button" className="text-sm underline" onClick={() => pad.current?.clear()}>
                          Clear
                        </button>
                      </div>
                      <SignaturePad ref={pad} disabled={openCount > 0} />
                    </div>
                    <p className="text-xs text-slate-500">The date and time are saved automatically. Signing locks the checklist.</p>
                    <button type="button" className={buttonClass} onClick={sign} disabled={busy || openCount > 0}>
                      {busy ? 'Saving…' : 'Sign and Lock'}
                    </button>
                  </div>
                </Can>
              )}
            </section>
          </>
        )}
      </div>
    </Can>
  )
}
