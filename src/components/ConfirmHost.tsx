import { useEffect, useState } from 'react'
import { registerConfirmHost, type Ask } from '../lib/confirm'
import { ACTION } from '../lib/wording'

/** Draws the Confirm / Cancel box opened by confirmAction() / askText() (src/lib/confirm.ts). */
export default function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    registerConfirmHost((a) => {
      setText(a.input?.initial ?? '')
      setAsk(a)
    })
    return () => registerConfirmHost(null)
  }, [])
  useEffect(() => {
    if (!ask) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        ask.resolve(null)
        setAsk(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask])
  if (!ask) return null
  function answer(ok: boolean) {
    ask?.resolve(ok ? (ask.input ? text : '') : null)
    setAsk(null)
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="alertdialog" aria-modal="true" aria-label="Please confirm">
      <form
        className="w-full rounded-t-lg bg-white p-5 shadow-xl sm:max-w-md sm:rounded-lg"
        onSubmit={(e) => {
          e.preventDefault()
          answer(true)
        }}
      >
        <h2 className="text-lg font-semibold">Please Confirm</h2>
        <p className="mt-3 text-sm whitespace-pre-line text-slate-700">{ask.message}</p>
        {ask.input && (
          <input
            aria-label={ask.input.label}
            autoFocus
            className="mt-3 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50" onClick={() => answer(false)}>
            {ACTION.cancel}
          </button>
          <button
            type="submit"
            autoFocus={!ask.input}
            disabled={Boolean(ask.input) && !text.trim()}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${ask.danger ? 'bg-red-700 hover:bg-red-800' : 'bg-slate-900 hover:bg-slate-700'}`}
          >
            {ask.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
