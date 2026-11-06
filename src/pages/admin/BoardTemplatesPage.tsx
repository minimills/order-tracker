// @permission-scope admin.board_templates
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import ColourPicker from '../../components/boards/ColourPicker'
import { buttonClass, Field, inputClass, secondaryButtonClass } from '../../components/form'
import { BOARD_COLOURS, LABEL_COLOURS, textOn, type BoardTemplate } from '../../lib/boards'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type Draft = { id: string | null; name: string; description: string; colour: string; stages: string; labels: string; checklists: string }

const toDraft = (t: BoardTemplate | null): Draft =>
  t
    ? {
        id: t.id,
        name: t.name,
        description: t.description ?? '',
        colour: t.colour,
        stages: t.stages.join('\n'),
        labels: t.labels.map((l) => `${l.name} ${l.colour}`).join('\n'),
        checklists: t.checklists.map((c) => [c.title, ...c.items.map((i) => `- ${i}`)].join('\n')).join('\n\n'),
      }
    : { id: null, name: '', description: '', colour: BOARD_COLOURS[0], stages: 'To do\nDoing\nDone', labels: '', checklists: '' }

/** "Urgent #dc2626" per line → labels (colour optional). */
function parseLabels(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const m = l.match(/^(.*?)\s*(#[0-9a-fA-F]{6})?$/)!
      return { name: m[1].trim(), colour: m[2] ?? LABEL_COLOURS[i % LABEL_COLOURS.length] }
    })
    .filter((l) => l.name)
}
/** Blocks separated by an empty line: first line = title, "- task" lines = tasks. */
function parseChecklists(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length)
    .map((b) => ({ title: b[0].replace(/^-\s*/, ''), items: b.slice(1).map((l) => l.replace(/^-\s*/, '')).filter(Boolean) }))
}

/** Admin → Board templates: what new boards start with. Save a board as a template from the board itself. */
export default function BoardTemplatesPage() {
  const [templates, setTemplates] = useState<BoardTemplate[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase!.from('board_templates').select('*').order('name')
    if (error) toast.error(friendlyError(error))
    setTemplates((data as BoardTemplate[]) ?? [])
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  async function save() {
    if (!draft || !supabase) return
    if (!draft.name.trim()) return toast.error('Give the template a name.')
    const row = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      colour: draft.colour,
      stages: draft.stages.split('\n').map((s) => s.trim()).filter(Boolean),
      labels: parseLabels(draft.labels),
      checklists: parseChecklists(draft.checklists),
    }
    setBusy(true)
    const { error } = draft.id ? await supabase.from('board_templates').update(row).eq('id', draft.id) : await supabase.from('board_templates').insert(row)
    setBusy(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Template saved.')
    setDraft(null)
    load()
  }

  async function archive(t: BoardTemplate) {
    const { error } = await supabase!.from('board_templates').update({ archived: !t.archived }).eq('id', t.id)
    if (error) return toast.error(friendlyError(error))
    load()
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <AdminPageHeader title="Board templates">
        What a new board can start with: its stages, labels and ready-made checklists. To copy a board you have set up, open
        it and press “Save as template”. Changing a template does not change boards already made from it.
      </AdminPageHeader>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        <button type="button" className={buttonClass} onClick={() => setDraft(toDraft(null))}>
          + New template
        </button>
      </div>

      {draft && (
        <section className="space-y-3 rounded-lg border border-blue-200 bg-white p-4">
          <h2 className="font-semibold">{draft.id ? 'Edit template' : 'New template'}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="bt-name">
              <input id="bt-name" className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Description" htmlFor="bt-desc">
              <input id="bt-desc" className={inputClass} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
          </div>
          <Field label="Colour">
            <ColourPicker colours={BOARD_COLOURS} value={draft.colour} onChange={(c) => setDraft({ ...draft, colour: c })} label="Template colour" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Stages (one per line, left to right)" htmlFor="bt-stages">
              <textarea id="bt-stages" rows={6} className={inputClass} value={draft.stages} onChange={(e) => setDraft({ ...draft, stages: e.target.value })} />
            </Field>
            <Field label="Labels (one per line, colour optional)" htmlFor="bt-labels" hint="e.g. Urgent #dc2626">
              <textarea id="bt-labels" rows={6} className={inputClass} value={draft.labels} onChange={(e) => setDraft({ ...draft, labels: e.target.value })} />
            </Field>
            <Field label="Ready-made checklists" htmlFor="bt-lists" hint="Title, then “- task” lines; empty line between checklists.">
              <textarea id="bt-lists" rows={6} className={inputClass} value={draft.checklists} onChange={(e) => setDraft({ ...draft, checklists: e.target.value })} />
            </Field>
          </div>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={save} disabled={busy}>
              Save template
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <ul className="space-y-3">
        {templates
          .filter((t) => showArchived || !t.archived)
          .map((t) => (
            <li key={t.id} className={`rounded-lg border border-slate-200 bg-white p-4 ${t.archived ? 'opacity-60' : ''}`} style={{ borderLeft: `6px solid ${t.colour}` }}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{t.name}</div>
                  {t.description && <div className="text-sm text-slate-600">{t.description}</div>}
                </div>
                <div className="flex gap-2">
                  {!t.archived && (
                    <button type="button" className={secondaryButtonClass} onClick={() => setDraft(toDraft(t))}>
                      Edit
                    </button>
                  )}
                  <button type="button" className={secondaryButtonClass} onClick={() => archive(t)}>
                    {t.archived ? 'Bring back' : 'Archive'}
                  </button>
                </div>
              </div>
              <div className="mt-2 text-sm">
                <span className="text-slate-500">Stages:</span> {t.stages.join(' → ') || 'none'}
              </div>
              {t.labels.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.labels.map((l) => (
                    <span key={l.name} className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ backgroundColor: l.colour, color: textOn(l.colour) }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {t.checklists.length > 0 && (
                <div className="mt-1 text-sm">
                  <span className="text-slate-500">Checklists:</span> {t.checklists.map((c) => `${c.title} (${c.items.length})`).join(', ')}
                </div>
              )}
            </li>
          ))}
      </ul>
    </div>
  )
}
