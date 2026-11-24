// @permission-scope automations
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Modal, buttonClass, inputClass, secondaryButtonClass } from '../form'
import { ACTION_STATUS, testAutomation, testSubjects, type Rule, type TestResult } from '../../lib/automations'
import { friendlyError } from '../../lib/format'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

const TONE: Record<string, string> = { ok: 'text-green-800', skipped: 'text-amber-800', failed: 'text-red-700' }

/**
 * Test: runs the automation on a real card / order / … as its owner, then
 * rolls everything back. Shows what would happen; nothing is changed or sent.
 */
export default function TestDialog({ automation, rule, onClose }: { automation?: { id: string; name: string }; rule?: Rule; onClose: () => void }) {
  const [subjects, setSubjects] = useState<{ id: string | null; title: string }[] | null>(null)
  const [subject, setSubject] = useState('')
  const [result, setResult] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    testSubjects({ id: automation?.id, rule })
      .then((s) => {
        setSubjects(s)
        setSubject(s[0]?.id ?? '')
      })
      .catch((e) => {
        toast.error(friendlyError(e))
        setSubjects([])
      })
  }, [automation?.id, rule])

  async function run() {
    setBusy(true)
    try {
      setResult(await testAutomation({ id: automation?.id, rule, subject_id: subject || null }))
    } catch (e) {
      toast.error(friendlyError(e as { message?: string }))
    }
    setBusy(false)
  }

  const verdict = (r: TestResult) => {
    switch (r.status) {
      case 'problems':
        return 'The automation cannot be tested yet:'
      case 'nothing':
        return r.message
      case 'not_matched':
        return 'The conditions are not met for this one, so nothing would happen.'
      case 'skipped':
        return r.message ?? 'The automation would not run.'
      case 'failed':
        return `The automation would fail: ${r.message ?? ''}`
      default:
        return 'This is what would happen:'
    }
  }

  return (
    <Modal
      title={tr("Test: {{value}}", { value: automation?.name ?? (rule?.name || tr("New automation")) })}
      wide
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            {ACTION.close}
          </button>
          <button type="button" className={buttonClass} disabled={busy || subjects === null} onClick={run}>
            {busy ? tr("Testing…") : tr("Run Test")}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {tr("The test runs the automation with its owner’s permissions on the example you choose, then undoes everything. Nothing is changed and no notification is sent.")}
      </p>
      {subjects && subjects.length > 0 && subjects[0].id !== null && (
        <div className="mt-3">
          <label htmlFor="test-subject" className="mb-1 block text-sm font-medium text-slate-700">
            {tr("Test it on")}
          </label>
          <select id="test-subject" className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)}>
            {subjects.map((s) => (
              <option key={s.id ?? 'now'} value={s.id ?? ''}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {subjects && subjects.length === 0 && <p className="mt-3 text-sm text-slate-500">{tr("There is nothing yet that this automation could be tested on.")}</p>}
      {result && (
        <div className="mt-4 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm" aria-live="polite">
          {result.subject && (
            <p>
              {tr("Example:")}{' '}
              {result.link ? (
                <Link to={result.link} className="text-blue-700 underline">
                  {result.subject}
                </Link>
              ) : (
                result.subject
              )}
            </p>
          )}
          <p className="font-medium">{verdict(result)}</p>
          {result.problems && (
            <ul className="list-disc pl-5 text-red-700">
              {result.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {result.conditions?.length > 0 && (
            <p className="text-slate-600">
              {tr("Conditions:")} {result.conditions.filter((c) => c.ok).length} {tr("of")} {result.conditions.length} met.
            </p>
          )}
          {result.actions?.length > 0 && (
            <ol className="list-decimal space-y-1 pl-5">
              {result.actions.map((a, i) => (
                <li key={i}>
                  <span className="font-medium">{a.label}</span> –{' '}
                  <span className={TONE[a.status]}>
                    {a.status === 'ok' ? tr("Would be done") : tr("Would be {{value}}", { value: ACTION_STATUS[a.status].toLowerCase() })}: {a.message}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="text-xs text-slate-500">{tr("Test only: nothing was changed.")}</p>
        </div>
      )}
    </Modal>
  )
}
