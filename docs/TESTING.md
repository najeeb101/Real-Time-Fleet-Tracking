# Testing checklist

There are no automated tests — see
[ARCHITECTURE.md](ARCHITECTURE.md#out-of-scope) for why. This is the manual pass
to run before pushing. It takes about ten minutes and covers every failure mode
the other documents describe.

Work top to bottom. Each section assumes the ones above it passed, so a failure
localises itself.

---

## 1. Database

Run the four queries in [DATABASE.md](DATABASE.md#verification) first. If any of
them fails, stop — nothing in the client can work yet, and debugging a silent
websocket is far more expensive than reading a query result.

| # | Check | Expected |
|---|---|---|
| 1.1 | Rows exist | Six vehicles, covering all three statuses |
| 1.2 | Table is in `supabase_realtime` | One row returned |
| 1.3 | RLS on, exactly one `SELECT` policy | `rowsecurity = true`; `Public read access` and nothing else |
| 1.4 | Trigger fires on UPDATE | `last_updated` within seconds of `now()` |

---

## 2. Initial render

| # | Step | Expected |
|---|---|---|
| 2.1 | `npm run dev`, open the page | Loading state, then six cards |
| 2.2 | Check the browser console | No errors, no hydration warnings |
| 2.3 | Compare dots against the Table Editor | `in_transit` green, `idle` yellow, `maintenance` red |
| 2.4 | Read a card | Text label sits next to every dot, not colour alone |
| 2.5 | Resize from ~375px to desktop | 1 → 2 → 3 columns, no horizontal scroll |

**2.2 is not a formality.** A hydration mismatch here means a timestamp is being
formatted during SSR — see
[ARCHITECTURE.md](ARCHITECTURE.md#rendering-strategy).

---

## 3. Real-time sync

The core of the assessment. Keep the app and the Supabase Table Editor side by
side and watch the app, not the dashboard.

| # | Step | Expected | Fails when |
|---|---|---|---|
| 3.1 | Change a `status` in the Table Editor | Dot and label change within ~1s, no refresh | Table not published, or no `SELECT` policy |
| 3.2 | Watch `last_updated` on that same card | Timestamp updates too | `set_last_updated` trigger missing |
| 3.3 | Watch the card's position | It stays put; nothing reorders | Sorting is in the query, not the render |
| 3.4 | Insert a new row | A new card appears, in name order | — |
| 3.5 | Insert, then check for duplicates | Exactly one card per vehicle | `INSERT` appends instead of upserting (rule 3) |
| 3.6 | Delete a row | Its card disappears | Handler reads a field other than `payload.old.id` |
| 3.7 | Open the page in two browser windows | Both update from one edit | — |

### 3.8 Strict Mode double-subscription

With the dev server running, change a status **once** and count the renders.

Add a temporary `console.log('event', payload.eventType)` in the handler. Exactly
one line per change. Two means a subscription leaked past Strict Mode's
double-mount — check that `removeChannel` runs in the effect cleanup
([REALTIME.md](REALTIME.md#react-strict-mode)).

Remove the log afterwards.

### 3.9 Reconnect recovery

This is the check most submissions skip, and the one that proves the sync design
rather than just exercising it.

1. Open DevTools → Network → set throttling to **Offline**.
2. An error or reconnecting banner should appear.
3. **While still offline**, change a status in the Supabase dashboard.
4. Set throttling back to **No throttling**.

Expected: the banner clears itself, and the card shows the change you made while
the tab was offline — without a refresh.

That last part only works because `load()` runs on every `SUBSCRIBED`, not just
the first. Events sent during the outage went to nobody and are not replayed, so
the refetch is the only route back to the truth
([REALTIME.md](REALTIME.md#rule-2--refetch-on-every-reconnect)).

If the banner stays after recovery, `setError(null)` is missing from the
`SUBSCRIBED` branch.

---

## 4. Security

The database cannot verify this for you — run it from the outside. Substitute
your own URL and anon key.

**Read must succeed:**

```bash
curl "$URL/rest/v1/fleet_vehicles?select=*" \
  -H "apikey: $ANON_KEY"
```

Expect a JSON array of vehicles.

**Write must fail:**

```bash
curl -X POST "$URL/rest/v1/fleet_vehicles" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"vehicle_name":"Should Not Exist","status":"idle"}'
```

Expect `401`/`403` with a row-level-security message. **If this succeeds, RLS is
off or a write policy exists** — anyone who opens DevTools can rewrite your
fleet, because the anon key is in the bundle. Re-read
[DATABASE.md](DATABASE.md#4-row-level-security), and delete the row that got
through.

---

## 5. Edge states

| # | Step | Expected |
|---|---|---|
| 5.1 | Empty the table (`delete from public.fleet_vehicles`) | An empty state, not a blank page or a crash |
| 5.2 | Re-run section 6 of `schema.sql` | Cards return |
| 5.3 | Comment out `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`, restart | The "Missing NEXT_PUBLIC_SUPABASE_URL or …" panel, not a white screen or an endless spinner |
| 5.4 | Restore it but corrupt the anon key, restart | Loading ends, and the reconnecting banner appears |
| 5.5 | Restore both, restart | Back to normal |

`delete from` with no `where` needs the SQL Editor — RLS blocks it from the
client, which is the point of section 4.

---

## 6. Before pushing

| # | Check | Command |
|---|---|---|
| 6.1 | `.env.local` is not tracked | `git status` — it must not appear |
| 6.2 | `.gitignore` still covers env files | it must list `.env*.local` |
| 6.3 | No key anywhere in the tree | `git grep -i "service_role"` returns only doc mentions |
| 6.4 | Types check | `npx tsc --noEmit` |
| 6.5 | Lint clean | `npm run lint` |
| 6.6 | Production build passes | `npm run build` |
| 6.7 | `.env.example` and `schema.sql` are committed | `git status` |
| 6.8 | Docs links resolve | click through the table in the README |

**6.1 and 6.2 together.** `create-next-app` writes its own `.gitignore`, and its
version ignores `.env*` — which would exclude the committed `.env.example`. The
hand-written one here ignores `.env` and `.env*.local` instead. If you ever
re-scaffold, confirm that distinction survived.

If a key ever reached a commit, rotate it in the Supabase dashboard. Deleting the
file is not enough — git history keeps every version, and a public repo makes that
history public.

**6.6 catches what `dev` hides:** unused imports, type errors excluded from the
dev pass, and missing `'use client'` directives on components that use hooks. It
must pass *without* a `.env.local` too — the Supabase client is created lazily so
that a fresh clone can build before it is configured.

---

## 7. After pushing

| # | Check |
|---|---|
| 7.1 | Repo is **public** — a reviewer hitting a 404 reads as a missing submission |
| 7.2 | The README renders on GitHub and its links work |
| 7.3 | Clone to a fresh folder, follow the README exactly, and make it run |
| 7.4 | If deployed to Vercel, both env vars are set there and the live URL works |

**7.3 is the one that finds the real gaps** — the step you did months ago and
never wrote down, or the env var you set by hand. Follow your own instructions
literally, and fix the README wherever you had to improvise.

Free-tier Supabase projects pause after roughly a week of inactivity. Keep the
project awake until you hear back, and note this in the README so a paused
project is not mistaken for broken code.
