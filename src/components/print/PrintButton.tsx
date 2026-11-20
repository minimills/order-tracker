import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ACTION } from '../../lib/wording'
import Icon from '../Icon'
import PrintPreview from './PrintPreview'

const look = 'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 print:hidden'

/**
 * THE Print button (every page that shows data has one). It opens the print
 * preview of the page (or, with scope="dialog", of the window it is in), or
 * goes to a page made for printing when `to` is given. Wrap it in
 * <Can permission="….print">.
 */
/* @layout-helper */
export default function PrintButton({ title, subtitle, scope = 'page', to, label = ACTION.print, className = '' }: { title: string; subtitle?: string; scope?: 'page' | 'dialog'; to?: string; label?: string; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [source, setSource] = useState<Element | null>(null)
  if (to) {
    return (
      <Link to={to} className={`${look} ${className}`} data-print="hide">
        <Icon name="printer" /> {label}
      </Link>
    )
  }
  const open = () => {
    const btn = ref.current
    const found = scope === 'dialog' ? btn?.closest('[role="dialog"] > *') : document.querySelector('main')
    setSource(found ?? document.body)
  }
  return (
    <>
      <button ref={ref} type="button" className={`${look} ${className}`} onClick={open} data-print="hide">
        <Icon name="printer" /> {label}
      </button>
      {source && <PrintPreview source={source} title={title} subtitle={subtitle} onClose={() => setSource(null)} />}
    </>
  )
}
