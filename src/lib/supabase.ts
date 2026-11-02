import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** True when both Supabase settings are present in .env.local. */
export const isSupabaseConfigured = Boolean(url && anonKey)

/**
 * The one shared Supabase client for the browser.
 * Uses only the public anon key; Row Level Security protects the data.
 * Null when .env.local is missing, so the app can still load and show a warning.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!)
  : null
