// @permission-scope orders.board.card.machines
import { useEffect, useRef, useState } from 'react'
import Can from '../Can'

/** One machine, as the chips need it (a row of the order_machine_status view). */
export type ChipMachine = {
  id: string
  order_id: string
  machine_type_id: string
  machine_type: string
  short_name: string
  serial_number: string | null
  ready: boolean
  checklist_done: boolean
  crate_count: number
}

/** 0 not built · 1 built · 2 final checklist done · 3 crated */
type Status = 0 | 1 | 2 | 3

const STATUS_STYLE: Record<Status, { chip: string; icon: string; word: string }> = {
  0: { chip: 'bg-slate-100 text-slate-700 ring-slate-300', icon: '○', word: 'Not built' },
  1: { chip: 'bg-green-50 text-green-800 ring-green-300', icon: '✓', word: 'Built' },
  2: { chip: 'bg-blue-50 text-blue-800 ring-blue-300', icon: '☑', word: 'Final checklist done' },
  3: { chip: 'bg-teal-50 text-teal-900 ring-teal-400', icon: '📦', word: 'Crated' },
}

function statusOf(m: ChipMachine, countCrates: boolean): Status {
  if (countCrates && m.crate_count > 0) return 3
  if (m.checklist_done) return 2
  if (m.ready) return 1
  return 0
}

type Group = { typeId: string; name: string; fullName: string; machines: ChipMachine[]; status: Status; mixed: boolean }

function groupMachines(machines: ChipMachine[], countCrates: boolean): Group[] {
  const map = new Map<string, ChipMachine[]>()
  for (const m of machines) map.set(m.machine_type_id, [...(map.get(m.machine_type_id) ?? []), m])
  return [...map.entries()]
    .map(([typeId, list]) => {
      const statuses = list.map((m) => statusOf(m, countCrates))
      const sorted = [...list].sort((a, b) => (a.serial_number ?? '').localeCompare(b.serial_number ?? ''))
      return {
        typeId,
        name: list[0].short_name,
        fullName: list[0].machine_type,
        machines: sorted,
        status: Math.min(...statuses) as Status,
        mixed: new Set(statuses).size > 1,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

type Props = {
  machines: ChipMachine[]
  /** Colour chips by status (permission orders.board.card.chip_status). */
  showStatus: boolean
  /** Count crates in the status (needs the Crating permission). */
  showCrated: boolean
  /** Serials on hover / tap (permission orders.board.card.chip_serials). */
  showSerials: boolean
  /** How many chips before "+N more". */
  max?: number
}

/**
 * Machine chips on a board card: one rounded chip per machine type with a
 * quantity badge, e.g. "Carder - Large ×2". Hover or tap a chip for its serials.
 */
export default function MachineChips({ machines, showStatus, showCrated, showSerials, max = 4 }: Props) {
  const groups = groupMachines(machines, showCrated)
  // Hover shows the serials; a tap / click pins them open until you tap elsewhere.
  const [hover, setHover] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Tap anywhere else to close the serials pop-up.
  useEffect(() => {
    if (!pinned) return
    const close = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setPinned(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
    }
  }, [pinned])

  if (groups.length === 0) return null
  const shown = expanded ? groups : groups.slice(0, max)
  const hidden = groups.length - shown.length

  return (
    <div ref={box} className="relative mt-2 flex flex-wrap gap-1">
      {shown.map((g) => {
        const style = showStatus ? STATUS_STYLE[g.status] : STATUS_STYLE[0]
        const isOpen = pinned === g.typeId || (pinned === null && hover === g.typeId)
        const summary = showStatus
          ? `${g.fullName}: ${g.machines.length} machine${g.machines.length === 1 ? '' : 's'}${
              g.mixed ? ' (mixed: see serials)' : `, ${style.word.toLowerCase()}`
            }`
          : `${g.fullName}: ${g.machines.length} machine${g.machines.length === 1 ? '' : 's'}`
        return (
          <div
            key={g.typeId}
            className="max-w-full"
            onMouseEnter={() => showSerials && setHover(g.typeId)}
            onMouseLeave={() => showSerials && setHover((o) => (o === g.typeId ? null : o))}
          >
            <button
              type="button"
              draggable={false}
              aria-expanded={showSerials ? isOpen : undefined}
              aria-label={summary}
              title={showSerials ? undefined : summary}
              onClick={(e) => {
                e.stopPropagation()
                if (showSerials) setPinned(pinned === g.typeId ? null : g.typeId)
              }}
              className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${style.chip} ${
                showSerials ? 'cursor-pointer' : 'cursor-default'
              }`}
            >
              {showStatus && (
                <span aria-hidden="true" className="shrink-0">
                  {g.mixed ? <MixedDot /> : style.icon}
                </span>
              )}
              <span className="truncate">{g.name}</span>
              {g.machines.length > 1 && (
                <span className="shrink-0 rounded-full bg-white/80 px-1.5 text-[11px] font-semibold tabular-nums ring-1 ring-current/20">
                  ×{g.machines.length}
                </span>
              )}
            </button>

          </div>
        )
      })}
      {/* Serials of the open chip, across the card's full width so nothing is cut off. */}
      {showSerials &&
        groups
          .filter((g) => pinned === g.typeId || (pinned === null && hover === g.typeId))
          .map((g) => (
            <div
              key={g.typeId}
              role="tooltip"
              className="absolute top-full right-0 left-0 z-30 mt-1 rounded-md border border-slate-200 bg-white p-2 text-xs shadow-lg"
            >
              <div className="mb-1 font-semibold text-slate-800">{g.fullName}</div>
              <ul className="space-y-0.5">
                {g.machines.map((m) => {
                  const st = STATUS_STYLE[statusOf(m, showCrated)]
                  return (
                    <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-2">
                      <span className="font-mono">{m.serial_number ?? 'No serial yet'}</span>
                      <Can permission="orders.board.card.chip_status">
                        <span className="text-slate-500">
                          {st.icon} {st.word}
                        </span>
                      </Can>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
      {hidden > 0 && (
        <button
          type="button"
          draggable={false}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(true)
          }}
          className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-300 hover:bg-slate-50"
        >
          +{hidden} more
        </button>
      )}
      {expanded && groups.length > max && (
        <button
          type="button"
          draggable={false}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(false)
          }}
          className="rounded-full px-2 py-0.5 text-xs text-slate-500 underline"
        >
          show less
        </button>
      )}
    </div>
  )
}

/** Half-filled dot: machines of this type are at different steps. */
function MixedDot() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 rounded-full border border-current"
      style={{ background: 'linear-gradient(90deg, currentColor 50%, transparent 50%)' }}
    />
  )
}

/** Small key to the chip colours, for the board header. */
export function ChipLegend({ showCrated }: { showCrated: boolean }) {
  const list: Status[] = showCrated ? [0, 1, 2, 3] : [0, 1, 2]
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
      <span>Chips:</span>
      {list.map((s) => (
        <span key={s} className={`rounded-full px-2 py-0.5 ring-1 ${STATUS_STYLE[s].chip}`}>
          {STATUS_STYLE[s].icon} {STATUS_STYLE[s].word}
        </span>
      ))}
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-slate-300">
        <MixedDot /> Mixed (tap for each serial)
      </span>
    </div>
  )
}
