# Real-Time Fleet Tracking

A dashboard that displays delivery vehicles and their current status. Change a
row in the Supabase dashboard and every open browser updates within a second —
no refresh, no polling.

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
Supabase Realtime.

---

## How real-time sync works

The short version, as asked for in the brief:

> The dashboard opens a Supabase Realtime channel on `fleet_vehicles` from
> inside a client component, and fetches the initial rows only once that channel
> reports `SUBSCRIBED` — so no change can slip through the gap between loading
> and listening. `INSERT`, `UPDATE` and `DELETE` events are then applied
> directly to local state, keyed by `id`, and the same refetch runs again on
> every reconnect so a dropped websocket self-heals. The channel is removed on
> unmount, which keeps React Strict Mode's double-mount from leaving a duplicate
> subscription behind.

The long version, including the failure modes each rule exists to prevent, is in
[docs/REALTIME.md](docs/REALTIME.md).

---

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data flow, file layout, every design decision and the alternatives rejected |
| [docs/DATABASE.md](docs/DATABASE.md) | `schema.sql` explained statement by statement, RLS, the trigger, verification queries |
| [docs/REALTIME.md](docs/REALTIME.md) | The sync strategy in depth: the fetch/subscribe race, reconnects, Strict Mode, event payloads |
| [docs/TESTING.md](docs/TESTING.md) | Manual verification checklist to run before pushing |

---

## Setup

### Prerequisites

- Node.js 20.9 or newer (`node --version`) — required by Next.js 16
- A free [Supabase](https://supabase.com) account

### 1. Install

```bash
git clone <this-repo-url>
cd Real-Time-Fleet-Tracking
npm install
```

### 2. Create the database

Create a new Supabase project, open **SQL Editor → New query**, paste the whole
of [schema.sql](schema.sql), and run it.

That one file creates the table, the timestamp trigger, the RLS policy, the
Realtime publication entry and six seed vehicles. It is idempotent, so running
it twice is harmless.

### 3. Add your credentials

Copy the example file and fill in both values from **Project Settings → API**:

```bash
cp .env.example .env.local
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

```ini
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

Use the **anon** key, never the `service_role` key. `.env.local` is gitignored.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. Then open the Supabase **Table Editor**, change a
vehicle's `status`, and watch the card update while you look at it.

---

## Status values

Three statuses, defined once in `lib/status.ts` and mirrored by the `CHECK`
constraint in [schema.sql](schema.sql). Adding a fourth means editing both.

| Value in the database | Shown as | Dot |
|---|---|---|
| `in_transit` | In transit | Green |
| `idle` | Idle | Yellow |
| `maintenance` | Maintenance | Red |

Each card carries the text label next to the dot. Colour alone would leave the
status unreadable to anyone with a colour vision deficiency, and invisible to a
screen reader.

---

## Project structure

```
app/
  layout.tsx                 root layout, fonts, page background
  globals.css                Tailwind entry point
  page.tsx                   server component; renders <FleetDashboard />
components/
  FleetDashboard.tsx         'use client' — the grid plus loading/empty/error states
  VehicleCard.tsx            one vehicle: name, status, timestamp
  StatusDot.tsx              the coloured indicator and its label
hooks/
  useFleetVehicles.ts        all real-time logic lives here
lib/
  supabase.ts                the single browser client, created lazily
  status.ts                  Vehicle type + status -> colour/label map
docs/                        the four documents listed above
schema.sql                   the whole database, in one runnable file
.env.example                 which variables are needed, with no values
next.config.ts               pins the Turbopack workspace root
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Cards render, but never update | The table is not in the Realtime publication | Re-run section 5 of [schema.sql](schema.sql) |
| Grid is empty, no error | RLS is on with no SELECT policy, so the fetch returns `[]` | Re-run section 4 of [schema.sql](schema.sql) |
| "Missing NEXT_PUBLIC_SUPABASE_URL or …" panel | `.env.local` absent, or the dev server was started before it was written | Create the file, then restart `npm run dev` — Next only reads env files at startup |
| "Live connection lost — reconnecting…" that never clears | URL or anon key present but wrong | Re-copy both from **Project Settings → API**, then restart |
| Timestamps never change | The `set_last_updated` trigger is missing | Re-run section 3 of [schema.sql](schema.sql) |
| Each change appears twice in dev | A subscription leaked past Strict Mode's double-mount | `removeChannel` must run in the `useEffect` cleanup — see [docs/REALTIME.md](docs/REALTIME.md#react-strict-mode) |
| Everything 404s or times out | Free-tier project paused after inactivity | Resume it from the Supabase dashboard |

---

## Security

- Only `NEXT_PUBLIC_*` variables are used, and both are meant to be public.
- RLS is enabled with a single `SELECT` policy. The anon key can read the fleet
  and nothing else: no insert, no update, no delete.
- The `service_role` key appears nowhere in this repository. Any
  `NEXT_PUBLIC_*` variable is inlined into the JavaScript bundle, so putting it
  there would publish it.
- If a key is ever committed, rotate it in the Supabase dashboard. Deleting the
  file is not enough — git history keeps every version.

---

## Notes for reviewers

- The app needs its own Supabase project; [schema.sql](schema.sql) reproduces
  the entire backend in one paste, so setup is about two minutes.
- Free-tier Supabase projects pause after roughly a week of inactivity. If the
  hosted link looks broken, the project is asleep rather than the code.
