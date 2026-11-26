/**
 * Machine lifecycle (0057–0059): older machines, owners, buy-backs,
 * refurbishment and stock. Words and types shared by the machine screens.
 */
import { supabase } from './supabase'

export type ItemKind = 'new' | 'used' | 'refurbished'
export type StockStatus = 'bought_back' | 'in_refurbishment' | 'ready_to_sell' | 'reserved' | 'sold'

/** The badge for a used or refurbished machine ("R" / "Used"), else null. */
export const kindBadge = (kind?: string | null) => (kind === 'refurbished' ? 'R' : kind === 'used' ? 'Used' : null)

export const KIND_LABEL: Record<ItemKind, string> = { new: 'New', used: 'Used', refurbished: 'Refurbished' }

export const STOCK_LABEL: Record<StockStatus, string> = {
  bought_back: 'Bought back',
  in_refurbishment: 'In refurbishment',
  ready_to_sell: 'Ready to sell',
  reserved: 'Reserved',
  sold: 'Sold',
}
export const STOCK_TONE: Record<StockStatus, string> = {
  bought_back: 'bg-amber-100 text-amber-900',
  in_refurbishment: 'bg-violet-100 text-violet-900',
  ready_to_sell: 'bg-green-100 text-green-800',
  reserved: 'bg-blue-100 text-blue-800',
  sold: 'bg-slate-100 text-slate-700',
}

/** How an owner change happened (machine_owners.how). */
export const HOW_LABEL: Record<string, string> = {
  original: 'Original owner',
  private_sale: 'Private sale',
  sold_through_us: 'Sold through us',
  gift: 'Gift',
  inheritance: 'Inherited',
  restructure: 'Company change',
  buy_back: 'Bought back',
  transfer: 'Transfer / resold',
  other: 'Other',
}
/** The choices people make in "Change Owner" (sold through us is an order; buy-backs have their own button). */
export const CHANGE_OWNER_CHOICES = [
  { value: 'private_sale', label: 'Private sale between customers (we were not involved)' },
  { value: 'sold_through_us', label: 'Sold through us (on an order)' },
  { value: 'gift', label: 'Gift' },
  { value: 'inheritance', label: 'Inherited' },
  { value: 'restructure', label: 'Company change (renamed, merged, restructured)' },
] as const

export const OLD_PART_LABEL: Record<string, string> = { kept: 'Old part kept', scrapped: 'Old part scrapped', returned: 'Old part returned to supplier' }

export type Warranty = { kind: ItemKind; months: number; start: string | null; end: string | null; custom: boolean }

export type LifecycleSettings = {
  warranty: Record<ItemKind, number>
  refurb_stages: { name: string; step: string }[]
  refurb_share_level: 'none' | 'view' | 'edit'
  refurb_note: { ce: boolean; commissioning: boolean }
}

export async function loadLifecycleSettings(): Promise<LifecycleSettings | null> {
  if (!supabase) return null
  const { data } = await supabase.rpc('machine_lifecycle_settings')
  return (data as LifecycleSettings) ?? null
}

/** A machine in stock (stock_machines()). */
export type StockMachine = {
  machine_id: string
  serial: string | null
  model: string
  code: string | null
  machine_type_id: string
  item_kind: ItemKind
  stock_status: StockStatus
  condition: string | null
  location: string | null
  year_built: number | null
  refurb_count: number
}

export async function loadStockMachines(): Promise<StockMachine[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('stock_machines')
  if (error) throw error
  return (data as StockMachine[]) ?? []
}

export const stockLabel = (m: Pick<StockMachine, 'model' | 'serial' | 'item_kind' | 'condition'>) =>
  `${m.model}${m.serial ? ` ${m.serial}` : ''} · ${KIND_LABEL[m.item_kind]}${m.condition ? ` · ${m.condition}` : ''}`

/** Money in CAD for the refurbishment screens. */
export const cad = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 }).format(Number(n))
