import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePermissions } from '../lib/permissions'
import { searchSettings, type SettingEntry } from '../lib/settingsIndex'
import Can from './Can'
import Icon from './Icon'

/** "Find a setting" box: type a few words, then open the page and jump to the setting. */
export default function SettingsSearch({ className = '' }: { className?: string }) {
  const navigate = useNavigate()
  const { can, canAny } = usePermissions()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const allowed = (e: SettingEntry) => (!e.permission || can(e.permission, e.level)) && (!e.anyOf || canAny(e.anyOf, e.level))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => searchSettings(q, allowed), [q, can, canAny])

  function go(e: SettingEntry) {
    setOpen(false)
    setQ('')
    navigate(e.find ? `${e.to}?find=${encodeURIComponent(e.find)}` : e.to)
  }

  return (
    <Can permission="settings.search">
      <div
        ref={box}
        className={`relative w-full sm:w-80 ${className}`}
        onBlur={(e) => !box.current?.contains(e.relatedTarget as Node) && setOpen(false)}
      >
        <label className="relative block">
          <span className="sr-only">Find a setting</span>
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="search"
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls="settings-search-results"
            aria-autocomplete="list"
            placeholder="Find a setting…"
            className="w-full rounded-md border border-slate-300 bg-white py-2 pl-8 pr-3 text-sm focus:border-slate-500 focus:outline-none"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter' && results[active]) {
                e.preventDefault()
                go(results[active])
              } else if (e.key === 'Escape') setOpen(false)
            }}
          />
        </label>
        {open && q.trim() && (
          <ul
            id="settings-search-results"
            role="listbox"
            className="absolute right-0 z-30 mt-1 max-h-80 w-full min-w-64 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
          >
            {results.length === 0 && <li className="px-3 py-2 text-slate-500">No settings match.</li>}
            {results.map((r, i) => (
              <li key={`${r.to}-${r.find ?? ''}-${r.label}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left ${i === active ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                >
                  <span className="block font-medium text-slate-900">{r.label}</span>
                  <span className="block text-xs text-slate-500">{r.where}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Can>
  )
}
