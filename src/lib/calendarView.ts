import { format } from 'date-fns'
import type { CalendarRow } from './service'

// Shared helpers of the Technician Calendar views.
export const iso = (d: Date) => format(d, 'yyyy-MM-dd')
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** Height of one hour in the day and week views. */
export const HOUR_PX = 48
export const PX_PER_MIN = HOUR_PX / 60

export const rowKey = (r: CalendarRow) => `${r.source}-${r.source_id}`
export const isTimed = (r: CalendarRow) => !!r.start_at
/** End of a timed entry (one hour when the phone entry had no end). */
export const endOf = (r: CalendarRow) => r.end_at ?? new Date(new Date(r.start_at!).getTime() + 3600_000).toISOString()

