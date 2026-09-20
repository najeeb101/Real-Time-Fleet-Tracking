'use client'

import { useFleetVehicles } from '@/hooks/useFleetVehicles'
import VehicleCard from './VehicleCard'

/**
 * Picks between loading / error / empty / grid, and sorts for display.
 *
 * Sorting happens here rather than in the query. An `order by` only orders the
 * initial fetch; Realtime events arrive in commit order and land wherever the
 * upsert puts them, so the list would drift out of order as soon as anything
 * changed. Sorting on render keeps each card in place while its status updates.
 */
export default function FleetDashboard() {
  const { vehicles, loading, error } = useFleetVehicles()

  const sorted = [...vehicles].sort((a, b) => a.vehicle_name.localeCompare(b.vehicle_name))

  if (loading) {
    return (
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        aria-busy="true"
        aria-label="Loading fleet"
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="h-[136px] animate-pulse rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900"
          />
        ))}
      </div>
    )
  }

  // Nothing to show and something is wrong: the error is the whole story.
  if (error && sorted.length === 0) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-950/30"
      >
        <h2 className="font-semibold text-red-900 dark:text-red-200">Could not load the fleet</h2>
        <p className="mt-2 text-sm text-red-800 dark:text-red-300">{error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Data is on screen, so a connection problem is a warning, not a blocker. */}
      {error && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {error} Showing the last known state.
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <p className="font-medium text-slate-700 dark:text-slate-200">No vehicles yet</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add a row to <code className="font-mono">fleet_vehicles</code> and it will appear here
            without a refresh.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((vehicle) => (
            <VehicleCard key={vehicle.id} vehicle={vehicle} />
          ))}
        </div>
      )}
    </div>
  )
}
