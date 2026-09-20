'use client'

import { useEffect, useState } from 'react'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { getConfigError, getSupabase } from '@/lib/supabase'
import type { Vehicle } from '@/lib/status'

/**
 * All real-time sync lives here. Four rules, each preventing a specific bug —
 * the long form is in docs/REALTIME.md.
 *
 *   1. Subscribe first, fetch on SUBSCRIBED. A change landing between a
 *      fetch-then-subscribe pair is lost: too late for the query, too early for
 *      the listener.
 *   2. Refetch on *every* SUBSCRIBED. Reconnects fire it again, and events sent
 *      during the outage went to nobody — Realtime does not replay them.
 *   3. Upsert by id, never append. Rule 1 deliberately overlaps subscription
 *      and fetch, so a row can arrive twice. Idempotent handlers make that safe.
 *   4. removeChannel on cleanup. Strict Mode double-mounts in development;
 *      without this, every change applies twice.
 */

const TABLE = 'fleet_vehicles'

export type FleetState = {
  vehicles: Vehicle[]
  loading: boolean
  /** Non-null while something is wrong. Cleared on a successful (re)subscribe. */
  error: string | null
}

/** Rule 3: replace by id if present, append if not. Applying twice == once. */
function upsert(list: Vehicle[], row: Vehicle): Vehicle[] {
  const index = list.findIndex((vehicle) => vehicle.id === row.id)
  if (index === -1) return [...list, row]
  const next = [...list]
  next[index] = row
  return next
}

export function useFleetVehicles(): FleetState {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Derived, not stored: a missing env var is knowable at render time, so there
  // is no reason to discover it in an effect and set state from the effect body.
  const configError = getConfigError()

  useEffect(() => {
    if (configError) return
    const supabase = getSupabase()

    // Guards against a late fetch or event writing state after unmount.
    let cancelled = false

    /**
     * Full refetch. Used for the initial load *and* as the recovery path after
     * a dropped connection, which is why it replaces state wholesale.
     */
    const load = async () => {
      const { data, error: queryError } = await supabase.from(TABLE).select('*')
      if (cancelled) return

      if (queryError) {
        setError(`Could not load the fleet: ${queryError.message}`)
      } else {
        setVehicles(data as Vehicle[])
        setError(null)
      }
      setLoading(false)
    }

    const handleChange = (payload: RealtimePostgresChangesPayload<Vehicle>) => {
      if (cancelled) return

      // DELETE carries only the replica identity — the primary key. Reading any
      // other column off payload.old gives undefined. See docs/DATABASE.md.
      if (payload.eventType === 'DELETE') {
        const { id } = payload.old as Partial<Vehicle>
        if (id) setVehicles((current) => current.filter((vehicle) => vehicle.id !== id))
        return
      }

      // The single cast at the wire boundary: supabase-js types payloads loosely.
      const row = payload.new as Vehicle
      setVehicles((current) => upsert(current, row))
    }

    const channel = supabase
      .channel('fleet-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, handleChange)
      .subscribe((status) => {
        if (cancelled) return

        if (status === 'SUBSCRIBED') {
          // Clear first: without this the banner outlives the outage and tells
          // the user the app is broken while it is working.
          setError(null)
          void load()
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setError('Live connection lost — reconnecting…')
          // Otherwise a bad URL or key leaves the spinner up forever.
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
      // removeChannel, not channel.unsubscribe(): unsubscribe stops the
      // listener but leaves the channel registered on the client.
      void supabase.removeChannel(channel)
    }
  }, [configError])

  // A configuration error outranks connection state: nothing was ever attempted.
  if (configError) return { vehicles: [], loading: false, error: configError }

  return { vehicles, loading, error }
}
