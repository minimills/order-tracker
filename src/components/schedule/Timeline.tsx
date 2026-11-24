import { showDate } from '../../lib/dates'
import Icon from '../Icon'
import { DEADLINE_TONE, STATUS_DONE, STEP_LABEL, type DeadlineState, type StepKey } from '../../lib/schedule'
import { tr } from '../../i18n'

export type TimelineItem = { step: StepKey | 'shipping'; due: string; state?: DeadlineState; done?: string | null }

/** Department deadlines as a row of small chips, back to back. */
/* @layout-helper */
export default function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs">
      {items.map((it, i) => (
        <li key={it.step} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-300" aria-hidden>→</span>}
          <span
            className={`rounded px-1.5 py-0.5 ring-1 ${DEADLINE_TONE[it.state ?? 'ok']}`}
            title={
              it.done
                ? tr("{{value}}: done{{value2}} (deadline {{showDate}})", { value: STEP_LABEL[it.step], value2: it.done === STATUS_DONE ? '' : ` ${showDate(it.done)}`, showDate: showDate(it.due) })
                : tr("{{value}}: due {{showDate}}{{value2}}", { value: STEP_LABEL[it.step], showDate: showDate(it.due, 'EEE, MMM d, yyyy'), value2: it.state === 'missed' ? tr(" – missed") : it.state === 'close' ? tr(" – due soon") : '' })
            }
          >
            {it.state === 'done' && <Icon name="check" className="mr-0.5 h-3 w-3" label={tr("Completed")} />}
            {it.state === 'missed' && <Icon name="alert" className="mr-0.5 h-3 w-3" label={tr("Missed")} />}
            {STEP_LABEL[it.step]} <span className="font-medium">{showDate(it.due, 'MMM d')}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
