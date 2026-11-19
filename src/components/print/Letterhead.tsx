import { useState } from 'react'
import { useCompany } from '../../lib/company'

/**
 * THE letterhead on printouts: company name, address, contact line and logo,
 * then the document title and when (and by whom) it was printed.
 */
/* @layout-helper */
export default function Letterhead({ title, subtitle, printedBy }: { title: string; subtitle?: string; printedBy?: string }) {
  const company = useCompany()
  // The moment the preview opened.
  const [when] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', dateStyle: 'long', timeStyle: 'short' }).format(new Date()))
  return (
    <header className="print-letterhead mb-5 border-b-2 border-slate-900 pb-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 text-sm">
          <div className="text-xl font-bold">{company.name}</div>
          {company.address && <div className="whitespace-pre-line text-slate-700">{company.address}</div>}
          <div className="text-slate-700">{[company.phone, company.email, company.website].filter(Boolean).join(' · ')}</div>
        </div>
        {company.logo && <img src={company.logo} alt="" className="max-h-16 max-w-[30%] object-contain" />}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="text-xs text-slate-600">
          Printed {when}
          {printedBy ? ` by ${printedBy}` : ''}
        </div>
      </div>
      {subtitle && <p className="text-sm text-slate-700">{subtitle}</p>}
    </header>
  )
}
