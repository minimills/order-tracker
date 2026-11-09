import { useEffect, useState } from 'react'
import { supabase } from './supabase'

/** Company details for printouts (app_settings key 'company'). */
export type Company = {
  name: string
  address: string
  phone: string
  email: string
  website: string
  /** Where signed documents (commissioning certificates) are emailed. */
  office_email: string
  /** A small PNG as a data: URL, or null. */
  logo: string | null
}

export const EMPTY_COMPANY: Company = { name: 'Belfast Mini Mills', address: '', phone: '', email: '', website: '', office_email: '', logo: null }

export function useCompany() {
  const [company, setCompany] = useState<Company>(EMPTY_COMPANY)
  useEffect(() => {
    supabase
      ?.from('app_settings')
      .select('value')
      .eq('key', 'company')
      .maybeSingle()
      .then(({ data }) => data?.value && setCompany({ ...EMPTY_COMPANY, ...(data.value as Partial<Company>) }))
  }, [])
  return company
}

/** Shrinks a picture to fit in 400×200 and returns it as a PNG data: URL (small enough to store). */
export function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 400 / img.width, 200 / img.height)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('That file could not be read as a picture.'))
    }
    img.src = url
  })
}
