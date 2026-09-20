# Architecture

How the pieces fit together, what each file is responsible for, and why each
decision went the way it did.

---

## The core idea

**Postgres is the source of truth. React state is a cache of it.**

Everything else follows from that sentence:

- The cache is filled by a full fetch, and refilled by a full fetch on every
  reconnect.
- Between fetches, individual Realtime events patch the cache in place.
- The client never writes. There is nothing to reconcile, no optimistic update
  to roll back, and no chance of the UI and the database disagreeing about who
  won.

---

## Data flow

```
   You change a row in the Supabase Table Editor
                    │
                    ▼
   ┌────────────────────────────────────────────┐
   │ Postgres                                   │
   │   fleet_vehicles                           │
   │   └─ BEFORE UPDATE trigger                 │
   │        sets last_updated = now()           │
   │   └─ row is in publication supabase_realtime│
   └────────────────────────────────────────────┘
                    │  write-ahead log
                    ▼
   ┌────────────────────────────────────────────┐
   │ Supabase Realtime                          │
   │   evaluates the RLS SELECT policy for      │
   │   this subscriber, then broadcasts         │
   └────────────────────────────────────────────┘
                    │  websocket
                    ▼
   ┌────────────────────────────────────────────┐
   │ Browser — useFleetVehicles()               │
   │                                            │
   │   1. subscribe to the channel              │
   │   2. on SUBSCRIBED  -> fetch all rows      │
   │   3. on event       -> patch state by id   │
   │   4. on unmount     -> removeChannel       │
   └────────────────────────────────────────────┘
                    │  vehicles, loading, error
                    ▼
        FleetDashboard  ──►  VehicleCard × n
        (grid, states)       (dot + label + time)
```

Two details in that diagram are easy to miss and both are load-bearing:

- **The RLS policy is evaluated on the broadcast path, not only on the fetch
  path.** No `SELECT` policy means a channel that subscribes cleanly and then
  stays silent forever.
- **The fetch happens after the subscription is live**, which is the whole
  point of [docs/REALTIME.md](REALTIME.md).

---

## Module responsibilities

One job each, so a failure has one place to look.

| File | Responsibility | Deliberately does not |
|---|---|---|
| `app/page.tsx` | Server component. Renders the page shell and `<FleetDashboard />`. | Fetch data — that would create a second, conflicting source of state |
| `components/FleetDashboard.tsx` | `'use client'`. Calls the hook, picks between loading / error / empty / grid, sorts for display. | Talk to Supabase directly |
| `components/VehicleCard.tsx` | Presents one vehicle. Pure props in, markup out. | Hold state or know Supabase exists |
| `components/StatusDot.tsx` | The coloured indicator, plus its accessible label. | Decide colours — it reads them from `lib/status.ts` |
| `hooks/useFleetVehicles.ts` | **All** real-time logic: subscribe, fetch, patch, clean up. Returns `{ vehicles, loading, error }`. | Render anything |
| `lib/supabase.ts` | One lazily-created browser client (`getSupabase`), plus a synchronous `getConfigError()` for the missing-env case. | Export a server client — nothing server-side reads the database |
| `lib/status.ts` | The `Vehicle` type, the status → colour/label map, and `resolveStatus()`. | Contain logic |

The brief suggests a single client component. Lifting the sync logic into
`useFleetVehicles.ts` keeps that logic in one readable file instead of tangled
with JSX — which matters, because it is the part being assessed. Everything else
stays as small as the brief implies.

---

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Initial load order | Subscribe first, fetch on `SUBSCRIBED` | Closes the window where a change lands after the fetch but before the listener exists | Fetch then subscribe — simpler to read, silently loses updates |
| Applying events | Upsert by `id` for `INSERT` **and** `UPDATE` | An event that overlaps the initial fetch would otherwise append a row the fetch already returned | Append on `INSERT` — produces duplicate cards |
| Reconnect handling | Refetch on every `SUBSCRIBED`, not just the first | A dropped websocket misses events entirely; only a refetch can recover them | Trust the socket — leaves the UI permanently stale after a laptop sleeps |
| Where data is fetched | Client only | One source of truth. Server-fetching then also subscribing means two code paths that can disagree | Server component fetch for a faster first paint |
| Sorting | At render time, by `vehicle_name` | A card must not jump position when its own status changes | `order by` in the query only — Realtime events arrive unordered and would break it |
| Status storage | `text` + `CHECK`, mirrored by a TS union | Easy to extend; the constraint still rejects bad data | A Postgres enum — equally valid, but altering one is clumsier |
| Timestamp type | `timestamptz` | `timestamp` loses the zone and renders the wrong local time | `timestamp` |
| Timestamp rendering | Formatted in the browser only | `toLocaleString()` on the server and again on the client produces different strings and a hydration error | Format during SSR |
| Security | RLS on, one `SELECT` policy, no write policies | The anon key is public by design; the policy is what stops readers writing | RLS off — makes it work, and lets anyone with the bundle rewrite your fleet |
| State management | `useState` in one hook | Roughly six rows and one subscription | Redux / Zustand / TanStack Query — all overkill here |
| Auth | None | The brief has no users | `@supabase/ssr` cookie plumbing |
| Client creation | Lazy, via `getSupabase()` | `app/page.tsx` is prerendered, so module-level code in the client bundle also runs during `next build`. A top-level `throw` would fail the build for anyone cloning without `.env.local` | `createClient(...)` at module scope with a guard clause above it |
| Missing env vars | Derived at render by `getConfigError()` | Knowable synchronously, so it needs no effect. React 19's `set-state-in-effect` lint rule rejects the `try/catch` + `setState` version, and rightly: it causes a cascading render | Discover it inside the effect and set error state |
| Unknown status value | `resolveStatus()` falls back to a grey "Unknown" dot | Keeps a card readable if the DB `CHECK` gains a value before the TS union does | Index the map directly — yields `undefined` and a card with no dot |

---

## Rendering strategy

`app/page.tsx` stays a server component and renders static chrome — heading,
layout, nothing data-dependent. All data lives under `'use client'`, because a
websocket needs a browser.

Two consequences worth stating plainly:

1. **First paint shows a loading state, not data.** The trade is deliberate:
   server-rendering the rows would mean a second fetch path, and the two paths
   could disagree the moment an event arrived mid-hydration.
2. **Dates are formatted after mount, and cannot mismatch.** Node and the
   browser can disagree on locale and zone, so a `toLocaleString()` that runs on
   both sides produces different text and React reports a hydration mismatch.
   Here no card exists during SSR — every vehicle arrives from a client fetch —
   so the call never runs twice. Keeping it inside `VehicleCard` rather than
   passing a pre-formatted string down means that stays true if the page ever
   gains a server-rendered row.

### One Tailwind v4 detail

`app/globals.css` sets the font family and nothing else. Background and text
colour are applied with utilities in `app/layout.tsx`.

That split is not cosmetic. Tailwind v4 emits utilities inside
`@layer utilities`, and **unlayered CSS beats layered CSS regardless of
specificity**. The scaffold ships a plain `body { background: … }` rule in
`globals.css`, which silently overrides `bg-slate-50 dark:bg-slate-950` on the
`body` element — the class is present in the markup and simply does nothing. It
was removed for that reason.

---

## Build order

Each step is verifiable on its own, so a failure points at one layer instead of
the whole stack.

| # | Step | Done when |
|---|---|---|
| 1 | Scaffold Next.js + TypeScript + Tailwind, install `@supabase/supabase-js` | `npm run dev` serves the starter page |
| 2 | Run `schema.sql` | Changing `status` in the Table Editor also bumps `last_updated` |
| 3 | `lib/status.ts`, `StatusDot`, `VehicleCard`, `FleetDashboard` with hardcoded rows | The grid looks right at phone, tablet and desktop widths |
| 4 | `lib/supabase.ts` + a plain fetch, no Realtime | Real rows appear — proving env vars, client and RLS all work |
| 5 | `useFleetVehicles.ts` with subscribe-then-fetch | A dashboard edit moves a card without a refresh |
| 6 | Loading, empty and error states; reconnect recovery | Killing and restoring the network recovers without a refresh |
| 7 | README polish, `git status` check, push | `.env.local` is absent from `git status`, repo is public |

### How step 1 actually went

Three snags, recorded because they are not obvious and would cost the next person
the same half hour.

**`create-next-app` refuses this directory.** It validates the target folder name
as an npm package name, and `Real-Time-Fleet-Tracking` contains capitals. It also
refuses a non-empty folder, and `schema.sql`, `.env.example` and the docs were
already here. The scaffold was generated into a lowercase temporary directory,
the generated files copied in, and `package.json` renamed to
`real-time-fleet-tracking`.

**The generated `.gitignore` was discarded on purpose.** It ignores `.env*`,
which would have excluded the committed `.env.example` — the one file that tells
a reviewer which variables the app needs. The hand-written version ignores
`.env` and `.env*.local` instead, so the example survives.

**`next.config.ts` pins `turbopack.root`.** Turbopack walks up the tree looking
for a lockfile to infer the workspace root. An unrelated `package-lock.json` in a
parent directory makes it resolve modules from outside the project. Pinning the
root removes the guesswork.

One more Next 16 surprise, not a snag so much as a thing to know: `next dev`
generates `AGENTS.md` and `CLAUDE.md` on every run and re-creates them if
deleted. They are gitignored here — they are tooling boilerplate, not part of the
submission.

---

## Out of scope

Named here so their absence reads as a decision rather than an oversight:

- Authentication and per-user fleets
- Writing from the UI (create / edit / delete vehicles)
- Pagination or virtualisation — the fleet is small by design
- Map or GPS coordinates
- Automated tests. The manual checklist in [docs/TESTING.md](TESTING.md) covers
  this surface honestly; a Realtime integration test needs a live project and
  would outweigh the app it tests.
