export type SerialChange = { order: string; machine_type?: string; old: string | null; new: string | null }
const place = (n: number | null) => {
  if (n === null) return 'not in the queue'
  const s = ['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4] ?? 'th'
  return `${n}${n % 10 > 3 || n % 10 === 0 ? 'th' : s} in the queue`
}

export type PositionChange = { order: string; old: number | null; new: number | null }

/** Lists queue-place and serial changes (old → new) for a confirm box. */
/* @layout-helper */
export default function ChangeList({ positions = [], serials = [] }: { positions?: PositionChange[]; serials?: SerialChange[] }) {
  if (positions.length === 0 && serials.length === 0) {
    return <p className="text-sm text-slate-500">Nothing would change.</p>
  }
  return (
    <div className="space-y-4 text-sm">
      {positions.length > 0 && (
        <div>
          <h3 className="font-medium">Shop queue ({positions.length} order{positions.length === 1 ? '' : 's'} move)</h3>
          <ul className="mt-1 grid gap-x-6 sm:grid-cols-2">
            {positions.map((p) => (
              <li key={p.order} className="tabular-nums">
                Order {p.order}: {place(p.old)} → <strong>{place(p.new)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      {serials.length > 0 && (
        <div>
          <h3 className="font-medium">Serial numbers ({serials.length})</h3>
          <table className="mt-1 w-full text-left">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 font-normal">Order</th>
                {serials.some((s) => s.machine_type) && <th className="py-1 font-normal">Machine</th>}
                <th className="py-1 font-normal">Old</th>
                <th />
                <th className="py-1 font-normal">New</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono text-xs">
              {serials.map((s, i) => (
                <tr key={i}>
                  <td className="py-1 font-sans">{s.order}</td>
                  {serials.some((x) => x.machine_type) && <td className="py-1 font-sans">{s.machine_type}</td>}
                  <td className="py-1">{s.old ?? '(none)'}</td>
                  <td className="py-1 text-slate-400">→</td>
                  <td className="py-1 font-semibold">{s.new ?? '(none)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
