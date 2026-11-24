// @permission-scope notices.post.everyone, notices.post.department, notices.manage
import { useState } from 'react'
import { toast } from 'sonner'
import { todayISO } from '../../lib/dates'
import { friendlyError } from '../../lib/format'
import { NOTE_COLOURS, PRIORITY, refreshNoticeUnread, refreshUrgentNotices, useAudienceChoices, type Audience, type Notice, type Priority } from '../../lib/notices'
import { usePermissions } from '../../lib/permissions'
import { isEmptyRichText } from '../../lib/richText'
import { supabase } from '../../lib/supabase'
import { useOptionList } from '../../lib/useOptionList'
import { ACTION } from '../../lib/wording'
import Can from '../Can'
import RichTextEditor from '../RichTextEditor'
import { buttonClass, Field, inputClass, Modal, narrowInputClass, secondaryButtonClass } from '../form'
import { tr } from '../../i18n'

type Target = Pick<Audience, 'target_type' | 'target'>

/** Post a new notice, or change one. The database checks every permission again. */
export default function NoticeDialog({ notice, audience, onClose, onSaved }: { notice: Notice | null; audience: Audience[]; onClose: () => void; onSaved: (id: string) => void }) {
  const { can } = usePermissions()
  const toEveryone = can('notices.post.everyone', 'edit')
  const choices = useAudienceChoices(toEveryone)
  const categories = useOptionList('notice_category', notice?.category)
  const [title, setTitle] = useState(notice?.title ?? '')
  const [body, setBody] = useState(notice?.body ?? '')
  const [colour, setColour] = useState(notice?.colour ?? 'yellow')
  const [category, setCategory] = useState(notice?.category ?? '')
  const [priority, setPriority] = useState<Priority>(notice?.priority ?? 'normal')
  const [everyone, setEveryone] = useState(notice ? notice.audience_everyone : toEveryone)
  const [targets, setTargets] = useState<Target[]>(audience.map((a) => ({ target_type: a.target_type, target: a.target })))
  const [showFrom, setShowFrom] = useState(notice?.show_from ?? todayISO())
  const [showUntil, setShowUntil] = useState(notice?.show_until ?? '')
  const [comments, setComments] = useState(notice?.comments_enabled ?? true)
  const [pinned, setPinned] = useState(notice?.pinned ?? false)
  const [pick, setPick] = useState<{ type: Target['target_type']; target: string }>({ type: toEveryone ? 'user' : 'department', target: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const has = (t: Target) => targets.some((x) => x.target_type === t.target_type && x.target === t.target)
  const toggle = (t: Target) => setTargets(has(t) ? targets.filter((x) => !(x.target_type === t.target_type && x.target === t.target)) : [...targets, t])
  const myDepartments = choices.departments.filter((d) => choices.myDepartments.includes(d.id))
  const allowedPriority = { normal: true, important: can('notices.priority.important', 'edit'), urgent: can('notices.priority.urgent', 'edit') }
  const priorities = (['normal', 'important', 'urgent'] as Priority[]).filter((p) => allowedPriority[p] || p === notice?.priority)

  async function save() {
    if (!supabase) return
    if (!title.trim()) return setError(tr("Enter a title."))
    if (!everyone && targets.length === 0) return setError(tr("Choose who the notice is for."))
    if (showUntil && showUntil < showFrom) return setError(tr("The \"show until\" date must be on or after the \"show from\" date."))
    setBusy(true)
    setError(null)
    const { data, error: e } = await supabase.rpc('save_notice', {
      p: {
        id: notice?.id ?? null,
        title: title.trim(),
        body: isEmptyRichText(body) ? '' : body,
        colour,
        category: category || null,
        priority,
        everyone,
        audience: everyone ? [] : targets.map((t) => ({ type: t.target_type, target: t.target })),
        show_from: showFrom,
        show_until: showUntil || null,
        comments_enabled: comments,
        pinned,
      },
    })
    setBusy(false)
    if (e) return setError(friendlyError(e))
    void refreshUrgentNotices()
    void refreshNoticeUnread()
    toast.success(
      notice ? tr("Notice updated.") : showFrom > todayISO() ? tr("Notice scheduled. It will show on the board from the chosen date.") : tr("Notice posted."),
    )
    onSaved(data as string)
  }

  const pickList =
    pick.type === 'user'
      ? choices.people.map((p) => ({ id: p.email, name: p.name }))
      : pick.type === 'group'
        ? choices.groups.map((g) => ({ id: g.id, name: g.name }))
        : choices.departments.map((d) => ({ id: d.id, name: d.name }))

  return (
    <Modal
      title={notice ? tr("Edit Notice") : tr("Post a Notice")}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            {ACTION.cancel}
          </button>
          <Can anyOf={['notices.post.everyone', 'notices.post.department', 'notices.manage']} level="edit">
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              {busy ? ACTION.saving : notice ? ACTION.save : tr("Post Notice")}
            </button>
          </Can>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={tr("Title")} htmlFor="nt-title">
          <input id="nt-title" className={inputClass} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">{tr("Message")}</span>
          <RichTextEditor value={body} onChange={setBody} label={tr("Message")} minHeight="8rem" placeholder={tr("Write the notice…")} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Category (optional)")} htmlFor="nt-cat">
            <select id="nt-cat" className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{tr("No category")}</option>
              {categories.options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <fieldset>
            <legend className="mb-1 block text-sm font-medium text-slate-700">{tr("Note colour")}</legend>
            <div className="flex flex-wrap gap-2">
              {NOTE_COLOURS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={colour === c.value}
                  onClick={() => setColour(c.value)}
                  style={{ backgroundColor: c.paper, borderColor: c.edge }}
                  className={`h-8 w-8 rounded border-2 ${colour === c.value ? 'ring-2 ring-slate-900 ring-offset-1' : ''}`}
                />
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">{tr("Priority")}</legend>
          <div className="space-y-1.5">
            {priorities.map((p) => (
              <label key={p} className="flex items-start gap-2 text-sm">
                <input type="radio" name="nt-priority" className="mt-0.5 h-4 w-4" checked={priority === p} onChange={() => setPriority(p)} />
                <span>
                  <span className="font-medium">{PRIORITY[p].label}</span> <span className="text-slate-500">– {PRIORITY[p].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium text-slate-700">{tr("Who is it for")}</legend>
          {toEveryone ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="nt-aud" className="h-4 w-4" checked={everyone} onChange={() => setEveryone(true)} />
                {tr("Everyone")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="nt-aud" className="h-4 w-4" checked={!everyone} onChange={() => setEveryone(false)} />
                {tr("Chosen people, groups and departments")}
              </label>
              {!everyone && (
                <div className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label={tr("Type")}
                      className={`${narrowInputClass} w-36`}
                      value={pick.type}
                      onChange={(e) => setPick({ type: e.target.value as Target['target_type'], target: '' })}
                    >
                      <option value="user">{tr("A person")}</option>
                      <option value="group">{tr("A group")}</option>
                      <option value="department">{tr("A department")}</option>
                    </select>
                    <select aria-label={tr("Which")} className={`${narrowInputClass} min-w-40 flex-1`} value={pick.target} onChange={(e) => setPick({ ...pick, target: e.target.value })}>
                      <option value="">{tr("Select…")}</option>
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
                    <p className="mt-2 text-xs text-slate-500">{tr("Nobody chosen yet.")}</p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {targets.map((t) => (
                        <li key={`${t.target_type}:${t.target}`} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs">
                          <span className="text-slate-500">{t.target_type === 'user' ? tr("Person") : t.target_type === 'group' ? tr("Group") : tr("Department")}:</span> {choices.nameOf(t)}
                          <button type="button" className="rounded-full px-1.5 hover:bg-slate-200" aria-label={`${ACTION.remove} ${choices.nameOf(t)}`} onClick={() => toggle(t)}>
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {myDepartments.length === 0 ? (
                <p className="text-sm text-amber-800">{tr("You are not in a department yet, so you cannot post a notice. Ask an administrator.")}</p>
              ) : (
                myDepartments.map((d) => {
                  const t: Target = { target_type: 'department', target: d.id }
                  return (
                    <label key={d.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="h-4 w-4" checked={has(t)} onChange={() => toggle(t)} />
                      {d.name}
                    </label>
                  )
                })
              )}
              <p className="text-xs text-slate-500">{tr("You can post to your own departments.")}</p>
            </div>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("Show from")} htmlFor="nt-from" hint={tr("A later date schedules the notice.")}>
            <input id="nt-from" type="date" className={inputClass} value={showFrom} onChange={(e) => setShowFrom(e.target.value)} />
          </Field>
          <Field label={tr("Show until (optional)")} htmlFor="nt-until" hint={tr("After this day it moves to the Archive.")}>
            <input id="nt-until" type="date" className={inputClass} value={showUntil} min={showFrom} onChange={(e) => setShowUntil(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={comments} onChange={(e) => setComments(e.target.checked)} />
            {tr("Allow comments")}
          </label>
          <Can permission="notices.pin" level="edit">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              {tr("Pin to the top of the board")}
            </label>
          </Can>
          {priority === 'urgent' && <p className="text-xs text-slate-500">{tr("Urgent notices are always shown at the top.")}</p>}
        </div>

        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
