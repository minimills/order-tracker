// @permission-scope admin.company
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import AdminPageHeader from '../../components/admin/AdminPageHeader'
import { buttonClass, Field, inputClass } from '../../components/form'
import { EMPTY_COMPANY, shrinkImage, type Company } from '../../lib/company'
import { friendlyError } from '../../lib/format'
import { supabase } from '../../lib/supabase'

export default function CompanyPage() {
  const [f, setF] = useState<Company>(EMPTY_COMPANY)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    supabase
      ?.from('app_settings')
      .select('value')
      .eq('key', 'company')
      .maybeSingle()
      .then(({ data }) => data?.value && setF({ ...EMPTY_COMPANY, ...(data.value as Partial<Company>) }))
  }, [])

  const set = (key: keyof Company) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value })

  async function pickLogo(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) return toast.error('Choose a picture file (PNG, JPG or SVG).')
    try {
      setF({ ...f, logo: await shrinkImage(file) })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    if (!f.name.trim()) return toast.error('Enter the company name.')
    setSaving(true)
    const value: Company = {
      name: f.name.trim(),
      address: f.address.trim(),
      phone: f.phone.trim(),
      email: f.email.trim(),
      website: f.website.trim(),
      office_email: f.office_email.trim(),
      contact_person: (f.contact_person ?? '').trim(),
      logo: f.logo,
    }
    const { error } = await supabase.from('app_settings').upsert({ key: 'company', value })
    setSaving(false)
    if (error) return toast.error(friendlyError(error))
    toast.success('Company details saved.')
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader title="Company Details">Shown at the top of printouts such as the shop board.</AdminPageHeader>

      <form onSubmit={save} className="max-w-3xl space-y-4 rounded-lg border border-slate-200 bg-white p-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" htmlFor="co-name" className="sm:col-span-2">
            <input id="co-name" className={inputClass} value={f.name} onChange={set('name')} />
          </Field>
          <Field label="Address" htmlFor="co-address" className="sm:col-span-2">
            <textarea id="co-address" rows={3} className={inputClass} value={f.address} onChange={set('address')} />
          </Field>
          <Field label="Phone" htmlFor="co-phone">
            <input id="co-phone" className={inputClass} value={f.phone} onChange={set('phone')} />
          </Field>
          <Field label="Email" htmlFor="co-email">
            <input id="co-email" className={inputClass} value={f.email} onChange={set('email')} />
          </Field>
          <Field label="Website" htmlFor="co-web">
            <input id="co-web" className={inputClass} value={f.website} onChange={set('website')} />
          </Field>
          <Field label="Contact person" htmlFor="co-contact" hint="Named as the manufacturer’s contact on declarations of conformity.">
            <input id="co-contact" className={inputClass} value={f.contact_person ?? ''} placeholder="Ankit Luthra" onChange={set('contact_person')} />
          </Field>
          <Field label="Office email for signed documents" htmlFor="co-office" className="sm:col-span-2" hint="Signed commissioning certificates are emailed to this address (as well as the technician and the customer). Empty = the email above.">
            <input id="co-office" type="email" className={inputClass} value={f.office_email} onChange={set('office_email')} />
          </Field>
        </div>

        <Field label="Logo" htmlFor="co-logo" hint="PNG or JPG. It is shrunk to fit 400 × 200 pixels.">
          <div className="flex flex-wrap items-center gap-4">
            {f.logo ? (
              <img src={f.logo} alt="Company logo" className="max-h-20 max-w-48 rounded border border-slate-200 bg-white p-1" />
            ) : (
              <span className="text-sm text-slate-500">No logo has been added.</span>
            )}
            <input id="co-logo" type="file" accept="image/*" className="w-full min-w-0 max-w-full text-sm" onChange={(e) => pickLogo(e.target.files?.[0])} />
            {f.logo && (
              <button type="button" className="text-sm text-red-700 underline" onClick={() => setF({ ...f, logo: null })}>
                Remove logo
              </button>
            )}
          </div>
        </Field>

        <div className="rounded-md border border-dashed border-slate-300 p-4">
          <div className="mb-2 text-xs text-slate-500">Preview of a printout header</div>
          <div className="flex items-center gap-4">
            {f.logo && <img src={f.logo} alt="" className="max-h-14" />}
            <div>
              <div className="text-lg font-bold">{f.name || 'Company name'}</div>
              <div className="text-xs whitespace-pre-line text-slate-600">
                {[f.address, [f.phone, f.email, f.website].filter(Boolean).join(' · ')].filter(Boolean).join('\n')}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className={buttonClass} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
