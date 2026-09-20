import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * One Supabase client for the whole browser session.
 *
 * Built lazily rather than at module scope. `app/page.tsx` is prerendered, so
 * module-level code in the client bundle also runs on the server during
 * `next build`; throwing there would fail the build for anyone who clones this
 * repo without a .env.local. Instead the error surfaces where it can be shown:
 * useFleetVehicles catches it and renders it.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const MISSING_ENV_MESSAGE =
  'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
  'Copy .env.example to .env.local, fill in both values, then restart the dev server.'

let client: SupabaseClient | null = null

/**
 * Synchronous configuration check, so callers can render the problem instead of
 * discovering it inside an effect. Returns null when the client is usable.
 */
export function getConfigError(): string | null {
  return url && anonKey ? null : MISSING_ENV_MESSAGE
}

/** @throws if either environment variable is absent. Check getConfigError first. */
export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) throw new Error(MISSING_ENV_MESSAGE)
  client ??= createClient(url, anonKey)
  return client
}
