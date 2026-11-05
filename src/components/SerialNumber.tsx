import { useEffect, useState } from 'react'
import Can from './Can'

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers / plain http: copy through a hidden text box.
    const t = document.createElement('textarea')
    t.value = text
    t.style.position = 'fixed'
    t.style.opacity = '0'
    document.body.appendChild(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

/**
 * A serial number with a small copy button next to it (permission
 * "serial.copy"). Shows "Copied" for a moment after copying.
 */
/* @layout-helper */
export default function SerialNumber({ serial, className = '' }: { serial: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <span className="font-mono">{serial}</span>
      <Can permission="serial.copy">
        <button
          type="button"
          draggable={false}
          aria-label={`Copy serial ${serial}`}
          title="Copy"
          onClick={async (e) => {
            e.stopPropagation()
            e.preventDefault()
            if (await copyText(serial)) setCopied(true)
          }}
          className={`rounded px-1 font-sans text-[11px] font-normal leading-5 print:hidden ${
            copied ? 'bg-green-100 text-green-800' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
          }`}
        >
          {copied ? 'Copied' : '⧉'}
        </button>
      </Can>
    </span>
  )
}
