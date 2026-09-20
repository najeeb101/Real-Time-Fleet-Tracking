# Real-time sync

The part of this project actually worth reviewing. Each rule below exists to
prevent a specific failure, so each one is stated with the bug it fixes.

---

## The four rules

1. **Subscribe first. Fetch when the channel reports `SUBSCRIBED`.**
2. **Refetch on every `SUBSCRIBED`, not only the first.**
3. **Upsert by `id` on `INSERT` as well as `UPDATE`.**
4. **Remove the channel in the effect cleanup.**

---

## Rule 1 — subscribe, then fetch

The intuitive order is to load the data and then start listening. It drops
updates, and it does so rarely enough to survive testing and then embarrass you
in front of whoever is reviewing it.

```
FETCH FIRST (broken)

t0  fetch starts ────────────────┐
t1        someone sets Van 01 -> maintenance
t2  fetch returns (pre-change) ──┘
t3  subscribe          listening starts here

The t1 change is never fetched, because the query ran before it.
It is never received, because the listener did not exist yet.
Van 01 stays wrong until the page is reloaded.
```

```
SUBSCRIBE FIRST (correct)

t0  subscribe
t1        SUBSCRIBED  ──► fetch starts
t2        someone sets Van 01 -> maintenance
t3  fetch returns
t4  UPDATE event arrives ──► state patched

Any change after t1 arrives as an event. Any change before t1 is
already in the fetch. There is no gap.
```

The window is milliseconds wide, which is exactly what makes it dangerous: it
will not reproduce while you are clicking around, and it will not be the thing
you suspect when a card is stale.

The overlap at the other end is handled by rule 3.

```ts
const channel = supabase
  .channel('fleet-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet_vehicles' }, handleChange)
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      setError(null)   // clear any error from a previous drop
      load()           // fetch only now
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      setError('Live connection lost — reconnecting…')
    }
  })
```

---

## Rule 2 — refetch on every reconnect

`SUBSCRIBED` is not a one-time event. Close the laptop, lose wifi, cross a
tunnel: the socket drops, supabase-js reconnects, and the callback fires
`SUBSCRIBED` again.

Everything that changed during the outage was broadcast to nobody. Those events
are gone — Realtime does not replay history. The only way back to the truth is to
ask the database again, which is why `load()` sits inside the `SUBSCRIBED` branch
rather than in its own one-shot effect.

This is why the fetch is written as a reusable `load()` and why it replaces state
wholesale instead of merging: a full refetch is the recovery mechanism.

The error message reads "reconnecting…" rather than "connection lost" because
supabase-js retries automatically. And `setError(null)` on `SUBSCRIBED` matters —
without it the banner sticks around after recovery, telling the user the app is
broken while it works fine.

---

## Rule 3 — upsert, never append

The obvious `INSERT` handler is wrong:

```ts
// BROKEN — can render the same vehicle twice
if (payload.eventType === 'INSERT') {
  setVehicles((v) => [...v, payload.new as Vehicle])
}
```

Rule 1 opens a deliberate overlap: the subscription is live while the initial
fetch is in flight. A row inserted in that window arrives **twice** — once in the
fetch result, once as an event. Appending blindly puts two cards on screen with
the same `id`, which React then complains about as a duplicate key.

Upserting makes the handler idempotent, so an event applied twice is
indistinguishable from an event applied once:

```ts
const upsert = (list: Vehicle[], row: Vehicle) => {
  const i = list.findIndex((v) => v.id === row.id)
  if (i === -1) return [...list, row]
  const next = [...list]
  next[i] = row
  return next
}
```

`UPDATE` uses the same function. An `UPDATE` for a row not yet in state — which
happens when an update lands between subscribe and fetch — inserts it instead of
being silently discarded by a `.map()` that matches nothing.

Idempotent handlers are what make the overlap safe. Without them, rule 1 trades a
missed-update bug for a duplicate-row bug.

---

## Rule 4 — clean up the channel

```ts
useEffect(() => {
  const channel = supabase.channel('fleet-changes')/* … */.subscribe(/* … */)
  return () => { supabase.removeChannel(channel) }
}, [])
```

### React Strict Mode

In development, Strict Mode mounts every component, unmounts it, and mounts it
again to surface exactly this class of bug. Without the cleanup:

- Two channels exist, so every change is applied twice.
- Calling `.on()` on an already-subscribed channel throws.
- A hot reload adds another channel each time, until Realtime rejects the
  connection count.

The double-application is easy to misread as a backend problem, since the events
really are arriving twice. Check the cleanup before blaming Postgres.

`removeChannel` rather than `channel.unsubscribe()`: `unsubscribe()` leaves the
channel registered on the client, so the object leaks even after it stops
listening.

The empty dependency array is required. Anything in it re-runs the effect and
tears down a working subscription. `supabase` is a module-level singleton
(`lib/supabase.ts`) precisely so that it is not a dependency.

---

## Event payloads

```ts
{
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  new: Vehicle | {},          // the row after the change; {} for DELETE
  old: { id: string } | {},   // primary key only, unless replica identity is FULL
  // …plus schema, table, commit_timestamp, errors
}
```

What this means in practice:

- **`INSERT` / `UPDATE`** — use `payload.new`. It is the complete row.
- **`DELETE`** — use `payload.old.id`, and nothing else. The row no longer
  exists, so Postgres sends only the replica identity, which here is the primary
  key. Code that reads `payload.old.vehicle_name` gets `undefined`. See
  [DATABASE.md](DATABASE.md#replica-identity).

`payload.new` is typed loosely by supabase-js (`{ [key: string]: any }`). Cast it
once at the top of the handler rather than at each use, so the boundary between
"untyped wire data" and "typed app data" is a single visible line:

```ts
const handleChange = (payload: RealtimePostgresChangesPayload<Vehicle>) => {
  if (payload.eventType === 'DELETE') {
    const id = (payload.old as { id?: string }).id
    if (id) setVehicles((v) => v.filter((x) => x.id !== id))
    return
  }
  const row = payload.new as Vehicle
  setVehicles((v) => upsert(v, row))
}
```

`event: '*'` subscribes to all three. `DELETE` and `INSERT` cost two extra
branches and mean the dashboard survives a reviewer adding or removing a row
instead of only editing one.

---

## Channel status values

| Status | Meaning | This app's response |
|---|---|---|
| `SUBSCRIBED` | Channel live, events will flow | Clear the error, then fetch |
| `CHANNEL_ERROR` | Connection or authorisation failed | Show a reconnecting banner; supabase-js retries |
| `TIMED_OUT` | No response in time | Same as above |
| `CLOSED` | Deliberately closed, usually by `removeChannel` | Nothing — this is the expected path on unmount |

`CHANNEL_ERROR` fires for a wrong URL or key, but also for a network blip. It is
not by itself evidence of a configuration problem.

**A missing RLS `SELECT` policy or a table absent from the publication produces
`SUBSCRIBED` and then silence** — not an error. When events never arrive, verify
the database with the queries in
[DATABASE.md](DATABASE.md#verification) before touching the client.

---

## Ordering

Sorting happens at render time, in the component, not in the query:

```ts
const sorted = [...vehicles].sort((a, b) => a.vehicle_name.localeCompare(b.vehicle_name))
```

An `order by` in the fetch only orders the initial load. Events arrive in commit
order and get appended wherever `upsert` puts them, so the list drifts out of
order as soon as anything changes. Sorting on render keeps position stable, which
matters more than it sounds: a card that jumps as its own status changes makes
the update feel like a bug even though the data is right.

---

## Rejected alternatives

**Polling.** A `setInterval` refetch is simpler and genuinely robust. It is also
slower, produces constant load for a fleet that changes rarely, and the brief
asks for Realtime.

**Refetching on every event** instead of patching state. Correct, and one round
trip per change. Patching from the payload is instant, and the payload already
contains the full new row.

**Server-side fetch, then subscribe on the client.** Faster first paint, two
sources of truth. The server snapshot can be superseded before the client channel
is live — reintroducing the rule 1 race across a network boundary, where it is
harder to see.

**`replica identity full`** to get old values in `DELETE` payloads. Nothing here
needs them, and it inflates the WAL for every write.
