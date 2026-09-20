import FleetDashboard from '@/components/FleetDashboard'

/**
 * Server component. Renders the static chrome only — no data fetching here.
 *
 * Fetching on the server as well would create a second source of truth: the
 * server snapshot can be superseded before the client's Realtime channel is
 * live, which is the same lost-update race the hook exists to avoid, moved
 * across a network boundary where it is harder to see.
 */
export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-slate-50">
          Fleet Status
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Live vehicle statuses. Changes made in the database appear here without a refresh.
        </p>
      </header>

      <FleetDashboard />
    </main>
  )
}
