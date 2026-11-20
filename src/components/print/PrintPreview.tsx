import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCompany } from '../../lib/company'
import { findParts, snapshot } from '../../lib/print'
import { supabase } from '../../lib/supabase'
import { ACTION } from '../../lib/wording'
import Icon from '../Icon'
import Letterhead from './Letterhead'

type Part = { id: string; label: string }
const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-sm ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`

/**
 * The print preview: a snapshot of `source` on a white sheet with the
 * letterhead. Choose the parts to include, paper size, direction and text
 * size, then Print. The page underneath is hidden while it is open, and the
 * light colours are used whatever the person's theme.
 */
/* @layout-helper */
export default function PrintPreview({ source, title, subtitle, onClose }: { source: Element; title: string; subtitle?: string; onClose: () => void }) {
  const company = useCompany()
  const contentRef = useRef<HTMLDivElement>(null)
  const [parts, setParts] = useState<Part[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [letterhead, setLetterhead] = useState(true)
  const [landscape, setLandscape] = useState(false)
  const [paper, setPaper] = useState<'letter' | 'A4'>('letter')
  const [small, setSmall] = useState(false)
  const [me, setMe] = useState('')

  // The snapshot is taken once, when the preview opens.
  useLayoutEffect(() => {
    const box = contentRef.current
    if (!box) return
    box.replaceChildren(snapshot(source))
    const found = findParts(box)
    found.forEach((p) => p.el.setAttribute('data-print-part', p.id))
    setParts(found.map(({ id, label }) => ({ id, label })))
  }, [source])

  useEffect(() => {
    contentRef.current?.querySelectorAll('[data-print-part]').forEach((el) => {
      if (hidden.has(el.getAttribute('data-print-part') ?? '')) el.setAttribute('data-print-hidden', '')
      else el.removeAttribute('data-print-hidden')
    })
  }, [hidden, parts])

  useEffect(() => {
    supabase?.rpc('current_user_name').then(({ data }) => setMe(typeof data === 'string' ? data : ''))
  }, [])

  // Light colours and the page hidden while the preview is open.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])
  useEffect(() => {
    const html = document.documentElement
    const themed = ['dark', 'glass', 'glass-lite'].filter((c) => html.classList.contains(c))
    html.classList.remove(...themed)
    html.classList.add('print-preview')
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current()
    window.addEventListener('keydown', onKey)
    window.scrollTo(0, 0)
    return () => {
      html.classList.remove('print-preview')
      html.classList.add(...themed)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  // The title is also the suggested PDF file name.
  useEffect(() => {
    const oldTitle = document.title
    document.title = `${title} – ${company.name}`
    return () => {
      document.title = oldTitle
    }
  }, [title, company.name])

  const toggle = (id: string) =>
    setHidden((h) => {
      const next = new Set(h)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const included = parts.length - hidden.size

  return createPortal(
    <div className="print-root" role="dialog" aria-modal="true" aria-label={`Print preview: ${title}`}>
      <div className="print-ui sticky top-0 z-10 border-b border-slate-300 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto min-w-0 text-base font-semibold">
            Print Preview <span className="font-normal text-slate-600">· {title}</span>
          </h2>
          <button type="button" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50" onClick={onClose}>
            Close Preview
          </button>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            disabled={parts.length > 0 && included === 0}
            onClick={() => window.print()}
          >
            <Icon name="printer" /> {ACTION.print}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="h-4 w-4" checked={letterhead} onChange={(e) => setLetterhead(e.target.checked)} /> Letterhead
          </label>
          <span className="flex items-center gap-1" role="group" aria-label="Paper direction">
            <button type="button" aria-pressed={!landscape} className={chip(!landscape)} onClick={() => setLandscape(false)}>
              Portrait
            </button>
            <button type="button" aria-pressed={landscape} className={chip(landscape)} onClick={() => setLandscape(true)}>
              Landscape
            </button>
          </span>
          <span className="flex items-center gap-1" role="group" aria-label="Paper size">
            <button type="button" aria-pressed={paper === 'letter'} className={chip(paper === 'letter')} onClick={() => setPaper('letter')}>
              Letter
            </button>
            <button type="button" aria-pressed={paper === 'A4'} className={chip(paper === 'A4')} onClick={() => setPaper('A4')}>
              A4
            </button>
          </span>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="h-4 w-4" checked={small} onChange={(e) => setSmall(e.target.checked)} /> Smaller text
          </label>
        </div>
        {parts.length > 1 && (
          <fieldset className="mt-2 text-sm">
            <legend className="mb-1 font-medium">
              Include ({included} of {parts.length}){' '}
              <button type="button" className="ml-2 font-normal underline" onClick={() => setHidden(new Set())}>
                Select All
              </button>
              <button type="button" className="ml-2 font-normal underline" onClick={() => setHidden(new Set(parts.map((p) => p.id)))}>
                Clear Selection
              </button>
            </legend>
            <div className="flex max-h-[7.5rem] flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
              {parts.map((p) => (
                <label key={p.id} className="flex min-w-0 items-center gap-1.5">
                  <input type="checkbox" className="h-4 w-4" checked={!hidden.has(p.id)} onChange={() => toggle(p.id)} />
                  <span className="truncate">{p.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <div className={`print-sheet ${letterhead ? 'print-with-letterhead' : ''} ${landscape ? 'print-landscape' : ''} ${small ? 'print-small' : ''}`}>
        {letterhead && <Letterhead title={title} subtitle={subtitle} printedBy={me} />}
        <div ref={contentRef} className="print-content" />
      </div>
      <style>{`@page { size: ${paper} ${landscape ? 'landscape' : 'portrait'}; margin: 12mm; }`}</style>
    </div>,
    document.body,
  )
}
