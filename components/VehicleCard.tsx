import StatusDot from './StatusDot'
import type { Vehicle } from '@/lib/status'

/**
 * Formatted here rather than during SSR. `toLocaleString` can resolve
 * differently in Node and in the browser, which shows up as a hydration
 * mismatch. It is safe in this component because every card renders after mount
 * — all fleet data is client-fetched — but keeping the call inside a client
 * subtree means that stays true if the page ever gains a server-rendered row.
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown'

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function VehicleCard({ vehicle }: { vehicle: Vehicle }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
        {vehicle.vehicle_name}
      </h2>

      <div className="mt-3">
        <StatusDot status={vehicle.status} />
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Updated{' '}
        <time dateTime={vehicle.last_updated}>{formatTimestamp(vehicle.last_updated)}</time>
      </p>
    </article>
  )
}
