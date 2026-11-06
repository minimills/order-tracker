// @permission-scope admin.users
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { friendlyError } from '../../lib/format'
import { allowedBy, type Perms } from '../../lib/permissions'
import { CATALOG, CATALOG_BY_KEY, GROUPS, type Group, type Level, type PermissionItem } from '../../lib/permissions/catalog'
import { START_PAGES } from '../../lib/permissions/nav'
import { supabase } from '../../lib/supabase'
import type { Department } from '../../lib/types'
import { buttonClass, inputClass, secondaryButtonClass } from '../form'
import { askText, confirmAction } from '../../lib/confirm'
import Icon from '../Icon'

export type Template = { id: string; name: string; perms: Perms }
export type OtherUser = { email: string; name: string | null; perms: Perms }

type Props = {
  email: string
  name: string | null
  initial: Perms
  departments: Department[]
  /** Departments this person is in (their presets are offered first). */
  memberOf: string[]
  templates: Template[]
  otherUsers: OtherUser[]
  /** Catalog keys the admin has already reviewed (others get a "New" badge). */
  reviewed: Set<string>
  onReviewed: (keys: string[]) => void
  onTemplatesChanged: () => void
  onClose: () => void
  onSaved: () => void
}

const levelsOf = (i: PermissionItem) => i.levels
const label = (key: string) => CATALOG_BY_KEY.get(key)?.label ?? key

/** Allow or remove a permission, keeping "edit includes view". */
function setTick(perms: Perms, item: PermissionItem, level: Level, on: boolean): Perms {
  const next = { ...perms }
  const cur = next[item.key]
  if (level === 'edit') {
    if (on) next[item.key] = 'edit'
    else if (cur === 'edit') {
      if (item.levels.includes('view')) next[item.key] = 'view'
      else delete next[item.key]
    }
  } else if (on) {
    if (cur !== 'edit') next[item.key] = 'view'
  } else delete next[item.key]
  return next
}

function hasTick(perms: Perms, item: PermissionItem, level: Level) {
  return level === 'edit' ? perms[item.key] === 'edit' : perms[item.key] === 'view' || perms[item.key] === 'edit'
}

/** Permissions only for keys that are still in the catalog, with levels they support. */
function cleanPerms(p: Perms): Perms {
  const out: Perms = {}
  for (const [k, v] of Object.entries(p ?? {})) {
    const item = CATALOG_BY_KEY.get(k)
    if (!item) continue
    if (v === 'edit' && item.levels.includes('edit')) out[k] = 'edit'
    else if (v === 'edit' || v === 'view') out[k] = item.levels.includes('view') ? 'view' : 'edit'
  }
  return out
}

function GroupCheckbox({
  items,
  perms,
  level,
  onChange,
}: {
  items: PermissionItem[]
  perms: Perms
  level: Level
  onChange: (on: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const applicable = items.filter((i) => levelsOf(i).includes(level))
  const ticked = applicable.filter((i) => hasTick(perms, i, level)).length
  const all = applicable.length > 0 && ticked === applicable.length
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = ticked > 0 && !all
  }, [ticked, all])
  if (applicable.length === 0) return <span />
  return (
    <label className="flex items-center justify-center gap-1 text-xs text-slate-600">
      <input
        ref={ref}
        type="checkbox"
        className="h-4 w-4"
        checked={all}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={`Select all ${level === 'view' ? 'View' : 'Edit'}`}
      />
      all
    </label>
  )
}

/**
 * Checkboxes for every item in the permissions catalog, with View and Edit
 * columns, grouped like the app's menu. Only full admins use this.
 */
export default function PermissionEditor(props: Props) {
  const { email, departments, templates, otherUsers, reviewed } = props
  const [perms, setPerms] = useState<Perms>(() => cleanPerms(props.initial))
  const [source, setSource] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [onlyNew, setOnlyNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [shortcut, setShortcut] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<Group>>(() => new Set(GROUPS))
  const dirty = JSON.stringify(perms) !== JSON.stringify(cleanPerms(props.initial))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !saving && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, saving])

  const newKeys = CATALOG.filter((i) => !reviewed.has(i.key)).map((i) => i.key)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = CATALOG.filter((i) => {
    if (onlyNew && reviewed.has(i.key)) return false
    const text = `${i.group} ${i.section} ${i.label} ${i.key}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  const shownByGroup = GROUPS.map((g) => ({ group: g, items: shown.filter((i) => i.group === g) })).filter((g) => g.items.length)

  // ---- Shortcuts --------------------------------------------------------
  const deptSorted = [...departments.filter((d) => !d.archived)].sort(
    (a, b) => Number(props.memberOf.includes(b.id)) - Number(props.memberOf.includes(a.id)) || a.sort_order - b.sort_order,
  )
  async function applyShortcut(value: string) {
    const [kind, id] = value.split(':')
    let next: Perms | null = null
    let name = ''
    if (kind === 'dept') {
      const d = departments.find((x) => x.id === id)
      next = (d?.default_permissions as Perms) ?? {}
      name = `department preset “${d?.name}”`
    } else if (kind === 'tpl') {
      const t = templates.find((x) => x.id === id)
      next = t?.perms ?? {}
      name = `template “${t?.name}”`
    } else if (kind === 'user') {
      const u = otherUsers.find((x) => x.email === id)
      next = u?.perms ?? {}
      name = `copied from ${u?.email}`
    } else if (kind === 'all') {
      next = Object.fromEntries(
        CATALOG.filter((i) => i.group !== 'Admin').map((i) => [i.key, i.levels.includes('edit') ? 'edit' : 'view']),
      ) as Perms
      name = 'everything except Admin'
    } else if (kind === 'none') {
      next = {}
      name = 'nothing'
    }
    if (next === null) return
    if (Object.keys(perms).length && !(await confirmAction(`Replace the current permissions with ${name}?`))) return
    setPerms(cleanPerms(next))
    setSource(name)
  }

  async function saveTemplate() {
    if (!supabase) return
    const n = await askText('Enter a name for this template (for example, “Shop floor”). An existing template with the same name is replaced.', { label: 'Template name', confirmLabel: 'Save Template' })
    if (!n) return
    const { error } = await supabase.rpc('save_permission_template', { p_name: n.trim(), p_perms: perms })
    if (error) return toast.error(friendlyError(error))
    toast.success(`Template “${n.trim()}” saved.`)
    props.onTemplatesChanged()
  }

  async function saveAsDepartmentPreset(deptId: string) {
    if (!supabase || !deptId) return
    const d = departments.find((x) => x.id === deptId)
    if (!(await confirmAction(`Use these permissions as the preset for the ${d?.name} department? People already in the department are not changed.`))) return
    const { error } = await supabase.rpc('set_department_permissions', { p_department_id: deptId, p_perms: perms })
    if (error) return toast.error(friendlyError(error))
    toast.success(`Preset saved for ${d?.name}.`)
    props.onTemplatesChanged()
  }

  async function deleteTemplate(id: string) {
    if (!supabase) return
    const t = templates.find((x) => x.id === id)
    if (!(await confirmAction(`Permanently delete the template “${t?.name}”? People who started from it keep their permissions.`, { confirmLabel: 'Permanently Delete', danger: true }))) return
    const { error } = await supabase.from('permission_templates').delete().eq('id', id)
    if (error) return toast.error(friendlyError(error))
    toast.success('Template deleted.')
    setShortcut('')
    props.onTemplatesChanged()
  }

  async function save() {
    if (!supabase) return
    setSaving(true)
    const { error } = await supabase.rpc('set_user_permissions', {
      p_email: email,
      p_perms: perms,
      p_source: source ? `${source}, then edited` : 'set manually',
    })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success(`Permissions saved for ${email}.`)
    props.onSaved()
  }

  // ---- Live preview -----------------------------------------------------
  const preview = useMemo(() => {
    const menu = START_PAGES.filter(
      (p) => (!p.permission || allowedBy(perms, p.permission, p.level)) && (!p.anyOf || p.anyOf.some((k) => allowedBy(perms, k, p.level))),
    )
    const byGroup = GROUPS.map((g) => ({
      group: g,
      items: CATALOG.filter((i) => i.group === g && hasTick(perms, i, 'view') && allowedBy(perms, i.key, 'view')).map((i) => ({
        item: i,
        edit: allowedBy(perms, i.key, 'edit') && i.levels.includes('edit'),
      })),
    })).filter((g) => g.items.length)
    // Allowed, but hidden because what it needs isn't allowed.
    const blocked = CATALOG.filter((i) => hasTick(perms, i, 'view') && !allowedBy(perms, i.key, 'view')).map((i) => ({
      item: i,
      missing: [i.requires, ...(i.needs ?? [])].filter((k): k is string => !!k && !allowedBy(perms, k, 'view')),
    }))
    return { menu, byGroup, blocked }
  }, [perms])

  const tickedCount = Object.keys(perms).length

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-50" role="dialog" aria-modal="true" aria-label={`Permissions for ${email}`}>
      {/* ---------- Top bar ---------- */}
      <div className="border-b border-slate-200 bg-white px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">What {props.name || email} can see and do</h2>
            <p className="text-xs text-slate-500">
              {email} · {tickedCount} item{tickedCount === 1 ? '' : 's'} allowed. Nothing that is not allowed is shown.
              {source && <> Started from {source}.</>}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={secondaryButtonClass} onClick={props.onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className={buttonClass} onClick={save} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save Permissions'}
            </button>
          </div>
        </div>

        {/* Shortcuts and search */}
        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
          <input
            type="search"
            className={inputClass}
            placeholder="Search, for example “voltage”, “column”, “payments”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search permissions"
          />
          <div className="flex gap-1">
            <select
              aria-label="Start from"
              className={inputClass}
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
            >
              <option value="">Start From…</option>
              <optgroup label="Department presets">
                {deptSorted.map((d) => (
                  <option key={d.id} value={`dept:${d.id}`}>
                    {d.name}
                    {props.memberOf.includes(d.id) ? ' (their department)' : ''}
                    {Object.keys(d.default_permissions ?? {}).length === 0 ? ' – empty' : ''}
                  </option>
                ))}
              </optgroup>
              {templates.length > 0 && (
                <optgroup label="Templates">
                  {templates.map((t) => (
                    <option key={t.id} value={`tpl:${t.id}`}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {otherUsers.length > 0 && (
                <optgroup label="Copy from another user">
                  {otherUsers.map((u) => (
                    <option key={u.email} value={`user:${u.email}`}>
                      {u.name ? `${u.name} (${u.email})` : u.email}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Other">
                <option value="all:">Everything except Admin</option>
                <option value="none:">Nothing</option>
              </optgroup>
            </select>
            <button type="button" className={secondaryButtonClass} disabled={!shortcut} onClick={() => applyShortcut(shortcut)}>
              Apply
            </button>
            {shortcut.startsWith('tpl:') && (
              <button type="button" className="px-1 text-xs text-red-700 underline" onClick={() => deleteTemplate(shortcut.slice(4))}>
                Permanently Delete
              </button>
            )}
          </div>
          <button type="button" className={secondaryButtonClass} onClick={saveTemplate}>
            Save as Template…
          </button>
          <select
            aria-label="Save as department preset"
            className={inputClass}
            value=""
            onChange={(e) => saveAsDepartmentPreset(e.target.value)}
          >
            <option value="">Save as Department Preset…</option>
            {departments
              .filter((d) => !d.archived)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </div>

        {newKeys.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900">
            <span>
              <span className="mr-1 rounded bg-blue-600 px-1.5 py-0.5 text-xs font-semibold text-white">New</span>
              {newKeys.length} item{newKeys.length === 1 ? ' has' : 's have'} been added to the app since you last reviewed.
              They are not permitted for anyone until you allow them.
            </span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Show only new
            </label>
            <button type="button" className="underline" onClick={() => props.onReviewed(CATALOG.map((i) => i.key))}>
              Mark as Reviewed
            </button>
          </div>
        )}
      </div>

      {/* ---------- Tree + preview ---------- */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="space-y-3 p-4 md:p-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {shownByGroup.length === 0 && <p className="text-sm text-slate-500">Nothing matches “{query}”.</p>}
          {shownByGroup.map(({ group, items }) => {
            const open = openGroups.has(group) || words.length > 0 || onlyNew
            const sections = [...new Set(items.map((i) => i.section))]
            const tickedInGroup = items.filter((i) => hasTick(perms, i, 'view')).length
            return (
              <section key={group} className="rounded-lg border border-slate-200 bg-white">
                <div className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-2 border-b border-slate-100 px-3 py-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left font-semibold"
                    onClick={() =>
                      setOpenGroups((s) => {
                        const n = new Set(s)
                        if (n.has(group)) n.delete(group)
                        else n.add(group)
                        return n
                      })
                    }
                    aria-expanded={open}
                  >
                    <span className="text-slate-400">{open ? '▾' : '▸'}</span>
                    {group}
                    <span className="text-xs font-normal text-slate-500">
                      {tickedInGroup} of {items.length}
                    </span>
                  </button>
                  <GroupCheckbox
                    items={items}
                    perms={perms}
                    level="view"
                    onChange={(on) => setPerms((p) => items.reduce((acc, i) => (i.levels.includes('view') ? setTick(acc, i, 'view', on) : acc), p))}
                  />
                  <GroupCheckbox
                    items={items}
                    perms={perms}
                    level="edit"
                    onChange={(on) => setPerms((p) => items.reduce((acc, i) => (i.levels.includes('edit') ? setTick(acc, i, 'edit', on) : acc), p))}
                  />
                </div>
                {open && (
                  <div>
                    <div className="grid grid-cols-[1fr_3.5rem_3.5rem] gap-2 px-3 pt-2 text-xs font-medium text-slate-500">
                      <span />
                      <span className="text-center">View</span>
                      <span className="text-center">Edit</span>
                    </div>
                    {sections.map((section) => (
                      <div key={section} className="pb-1">
                        <div className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">{section}</div>
                        <ul>
                          {items
                            .filter((i) => i.section === section)
                            .map((i) => {
                              const missing = [i.requires, ...(i.needs ?? [])].filter(
                                (k): k is string => !!k && !allowedBy(perms, k, 'view'),
                              )
                              const on = hasTick(perms, i, 'view')
                              return (
                                <li
                                  key={i.key}
                                  className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50"
                                >
                                  <div className="min-w-0">
                                    <span>{i.label}</span>
                                    {!reviewed.has(i.key) && (
                                      <span className="ml-2 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">New</span>
                                    )}
                                    {i.db && (
                                      <span className="ml-2 text-xs text-slate-400" title="Also enforced by the database">
                                        <Icon name="lock" className="h-3.5 w-3.5" />
                                      </span>
                                    )}
                                    <div className="font-mono text-[11px] text-slate-400">{i.key}</div>
                                    {i.hint && <div className="text-xs text-slate-500">{i.hint}</div>}
                                    {on && missing.length > 0 && (
                                      <div className="text-xs text-amber-700">Not visible until you also allow: {missing.map(label).join(', ')}</div>
                                    )}
                                  </div>
                                  <div className="flex justify-center">
                                    {i.levels.includes('view') && (
                                      <input
                                        type="checkbox"
                                        className="h-5 w-5"
                                        aria-label={`${i.label}: view`}
                                        checked={hasTick(perms, i, 'view')}
                                        onChange={(e) => setPerms((p) => setTick(p, i, 'view', e.target.checked))}
                                      />
                                    )}
                                  </div>
                                  <div className="flex justify-center">
                                    {i.levels.includes('edit') && (
                                      <input
                                        type="checkbox"
                                        className="h-5 w-5"
                                        aria-label={`${i.label}: edit`}
                                        checked={hasTick(perms, i, 'edit')}
                                        onChange={(e) => setPerms((p) => setTick(p, i, 'edit', e.target.checked))}
                                      />
                                    )}
                                  </div>
                                </li>
                              )
                            })}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
          <p className="pb-4 text-xs text-slate-500">
            The lock symbol means the rule is also enforced by the database. “Edit” includes “View”. “All” allows every item shown in that group.
          </p>
        </div>

        {/* Live preview */}
        <aside className="border-t border-slate-200 bg-white p-4 md:p-6 lg:w-96 lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <h3 className="font-semibold">What This User Will See</h3>
          <div className="mt-3">
            <div className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Menu</div>
            {preview.menu.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">
                No pages allowed yet. They can sign in but will see “No Pages Enabled Yet”.
              </p>
            ) : (
              <>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {preview.menu.map((m) => (
                    <li key={m.to}>
                      <span aria-hidden="true">{m.icon}</span> {m.label}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-slate-500">After signing in they land on: {preview.menu[0].label}</p>
              </>
            )}
          </div>
          {preview.blocked.length > 0 && (
            <div className="mt-4 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              <div className="font-semibold">Allowed but Not Visible Yet</div>
              <ul className="mt-1 space-y-0.5">
                {preview.blocked.map(({ item, missing }) => (
                  <li key={item.key}>
                    {item.group} › {item.section}: {item.label} – also allow {missing.map(label).join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 space-y-3">
            {preview.byGroup.map(({ group, items }) => (
              <div key={group}>
                <div className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{group}</div>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {items.map(({ item, edit }) => (
                    <li key={item.key} className="flex justify-between gap-2">
                      <span className="min-w-0">{item.label}</span>
                      <span className={`shrink-0 text-xs ${edit ? 'text-green-700' : 'text-slate-500'}`}>{edit ? 'can change' : 'sees'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
