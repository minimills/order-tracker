// @permission-scope orders.new, order.machines.add
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { MachineType } from '../../lib/types'
import { inputClass, secondaryButtonClass } from '../form'
import { MAX_QUANTITY, parseQuantity } from './machines'

type Props = {
  types: MachineType[]
  /** Called with the chosen type and how many. */
  onAdd: (type: MachineType, quantity: number) => void
}

/** Matches every word typed, in the name or the code ("card l" → Carder - Large). */
function matches(t: MachineType, words: string[]) {
  const text = `${t.name} ${t.code ?? ''} ${t.short_name ?? ''}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

/**
 * Type to find a machine type, pick with ↑ ↓ and Enter, then type the
 * quantity and press Enter again. The box clears and is ready for the next one.
 */
export default function MachineTypeSearch({ types, onAdd }: Props) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<MachineType | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [open, setOpen] = useState(false)
  const [qty, setQty] = useState('1')
  const [error, setError] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const qtyBox = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return types.slice(0, 50)
    const q = query.trim().toLowerCase()
    return types
      .filter((t) => matches(t, words))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
  }, [types, query])

  function choose(t: MachineType) {
    setChosen(t)
    setQuery(t.name)
    setOpen(false)
    setError(null)
    // Straight to the quantity (at once, so a quick second Enter adds it),
    // with "1" selected so typing replaces it.
    qtyBox.current?.focus()
    qtyBox.current?.select()
  }

  function add() {
    const t = chosen ?? (results.length === 1 ? results[0] : null)
    if (!t) {
      setError(query.trim() ? 'Select a machine type from the list.' : 'Enter a machine type first.')
      search.current?.focus()
      return
    }
    const n = parseQuantity(qty)
    if (n === null) {
      setError(`Quantity must be 1 to ${MAX_QUANTITY}.`)
      qtyBox.current?.select()
      return
    }
    onAdd(t, n)
    // Ready for the next machine.
    setChosen(null)
    setQuery('')
    setQty('1')
    setHighlight(0)
    setError(null)
    search.current?.focus()
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (chosen && query === chosen.name) qtyBox.current?.select()
      else if (results[highlight]) choose(results[highlight])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const listId = `${id}-list`
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3">
      <div className="grid grid-cols-[1fr_5rem] gap-2 sm:grid-cols-[1fr_6rem_auto]">
        <div className="relative">
          <label htmlFor={`${id}-search`} className="mb-1 block text-sm font-medium text-slate-700">
            Add a Machine
          </label>
          <input
            ref={search}
            id={`${id}-search`}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[highlight] ? `${id}-opt-${highlight}` : undefined}
            autoComplete="off"
            className={inputClass}
            placeholder="Search, for example card"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setChosen(null)
              setHighlight(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onSearchKey}
          />
          {open && !chosen && results.length > 0 && (
            <ul
              id={listId}
              role="listbox"
              className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
            >
              {results.map((t, i) => (
                <li
                  key={t.id}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(t)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex cursor-pointer justify-between gap-2 px-3 py-1.5 ${i === highlight ? 'bg-blue-50 text-blue-900' : ''}`}
                >
                  <span>{t.name}</span>
                  <span className="font-mono text-xs text-slate-500">{t.code ?? 'no code yet'}</span>
                </li>
              ))}
            </ul>
          )}
          {open && !chosen && query.trim() && results.length === 0 && (
            <div className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow">
              No machine type matches “{query}”.
            </div>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-qty`} className="mb-1 block text-sm font-medium text-slate-700">
            How many
          </label>
          <input
            ref={qtyBox}
            id={`${id}-qty`}
            type="number"
            min={1}
            max={MAX_QUANTITY}
            inputMode="numeric"
            className={inputClass}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
        </div>
        <div className="col-span-2 flex items-end sm:col-span-1">
          <button type="button" className={secondaryButtonClass} onClick={add}>
            Add
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs font-medium text-red-600">{error}</p>}
      <p className="mt-1 text-xs text-slate-500">
        Enter a name, choose with ↑ ↓ and press Enter, enter the quantity and press Enter again. The box is then ready for the next
        machine.
      </p>
    </div>
  )
}
