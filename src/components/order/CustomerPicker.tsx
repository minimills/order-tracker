// @permission-scope orders.new
import { useEffect, useState } from 'react'
import Can from '../Can'
import { supabase } from '../../lib/supabase'
import type { Customer } from '../../lib/types'
import { Field, inputClass, secondaryButtonClass } from '../form'
import { emptyNewCustomer, type CustomerChoice, type NewCustomer } from './customer'

type Props = {
  value: CustomerChoice
  onChange: (value: CustomerChoice) => void
  errors: Partial<Record<'customer' | 'name' | 'emails', string>>
}

/** Search for an existing customer, or type in a new one. */
export default function CustomerPicker({ value, onChange, errors }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Customer[]>([])
  const [searching, setSearching] = useState(false)

  // Search as you type (short pause so we don't search on every key).
  const cleaned = query.replace(/[,()%*\\]/g, ' ').trim()
  const isSearchMode = value.mode === 'existing' && !value.customer
  useEffect(() => {
    if (!supabase || !isSearchMode || cleaned.length < 1) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setSearching(true)
      const { data } = await supabase!
        .from('customer_list')
        .select('id, name, company, emails, phone, country, state_province, notes, archived')
        .eq('archived', false)
        .or(`name.ilike.%${cleaned}%,company.ilike.%${cleaned}%`)
        .order('name')
        .limit(8)
      if (!cancelled) {
        setResults((data as Customer[]) ?? [])
        setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cleaned, isSearchMode])

  if (value.mode === 'new') {
    const c = value.customer
    const set = (field: keyof NewCustomer, v: string) => onChange({ mode: 'new', customer: { ...c, [field]: v } })
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-600">New customer</p>
          <button
            type="button"
            className="text-sm text-slate-600 underline"
            onClick={() => onChange({ mode: 'existing', customer: null })}
          >
            Pick an existing customer instead
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name *" htmlFor="cust-name" error={errors.name}>
            <input id="cust-name" className={inputClass} value={c.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Company" htmlFor="cust-company">
            <input
              id="cust-company"
              className={inputClass}
              value={c.company}
              onChange={(e) => set('company', e.target.value)}
            />
          </Field>
          <Can permission="customer.contact" level="edit">
            <Field
              label="Email addresses"
              htmlFor="cust-emails"
              hint="Separate several emails with commas."
              error={errors.emails}
              className="md:col-span-2"
            >
              <input
                id="cust-emails"
                className={inputClass}
                value={c.emails}
                placeholder="jane@farm.com, orders@farm.com"
                onChange={(e) => set('emails', e.target.value)}
              />
            </Field>
          </Can>
          <Field label="Country" htmlFor="cust-country">
            <input
              id="cust-country"
              className={inputClass}
              value={c.country}
              onChange={(e) => set('country', e.target.value)}
            />
          </Field>
          <Field label="State / province" htmlFor="cust-state">
            <input
              id="cust-state"
              className={inputClass}
              value={c.state_province}
              onChange={(e) => set('state_province', e.target.value)}
            />
          </Field>
        </div>
      </div>
    )
  }

  if (value.customer) {
    const c = value.customer
    return (
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-sm">
          <div className="font-medium">{c.name}</div>
          {c.company && <div className="text-slate-600">{c.company}</div>}
          <div className="text-slate-500">
            {[c.state_province, c.country].filter(Boolean).join(', ')}
            {c.emails.length > 0 && <> · {c.emails.join(', ')}</>}
          </div>
        </div>
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => {
            setQuery('')
            onChange({ mode: 'existing', customer: null })
          }}
        >
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Field label="Find a customer" htmlFor="cust-search" error={errors.customer}>
        <input
          id="cust-search"
          className={inputClass}
          value={query}
          placeholder="Type a name or company"
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {cleaned.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {searching && results.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Searching…</li>}
          {!searching && results.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-500">No customer found.</li>
          )}
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => onChange({ mode: 'existing', customer: c })}
              >
                <span className="font-medium">{c.name}</span>
                {c.company && <span className="text-slate-600"> · {c.company}</span>}
                {c.country && <span className="text-slate-500"> · {c.country}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Can permission="orders.new.customer.new" level="edit">
        <button
          type="button"
          className="text-sm font-medium text-slate-700 underline"
          onClick={() =>
            onChange({ mode: 'new', customer: { ...emptyNewCustomer, name: results.length === 0 ? query.trim() : '' } })
          }
        >
          + Add a new customer
        </button>
      </Can>
    </div>
  )
}
