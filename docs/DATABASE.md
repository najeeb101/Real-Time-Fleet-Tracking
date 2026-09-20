# Database

[`schema.sql`](../schema.sql) is the entire backend. This document explains each
of its six sections, then gives queries to verify the result and to reset it.

Run the file in **Supabase Dashboard → SQL Editor → New query**. It is
idempotent; running it twice changes nothing.

---

## Schema at a glance

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `uuid` | primary key, `default gen_random_uuid()` | Realtime requires a primary key |
| `vehicle_name` | `text` | `not null` | Display name, e.g. `Van 01` |
| `status` | `text` | `not null`, `default 'idle'`, `check (…)` | One of `in_transit`, `idle`, `maintenance` |
| `last_updated` | `timestamptz` | `not null`, `default now()` | Maintained by a trigger on UPDATE |

---

## 1. The `moddatetime` extension

```sql
create extension if not exists moddatetime schema extensions;
```

Supplies the trigger function used in section 3. Supabase ships it; it just is
not enabled by default.

**Why it matters.** `default now()` fires only on `INSERT`. Editing `status` in
the Table Editor does not touch `last_updated`, so without a trigger the
dashboard proudly displays a timestamp from whenever the row was created. The
column becomes a lie that is easy to miss, because it always looks plausible.

**If `extensions.moddatetime` is not found**, the extension landed in another
schema. Check where:

```sql
select extname, n.nspname as schema
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where extname = 'moddatetime';
```

Then use that schema in the trigger, or write the function by hand:

```sql
create or replace function public.set_last_updated()
returns trigger language plpgsql as $$
begin
  new.last_updated = now();
  return new;
end $$;
```

---

## 2. The table

```sql
create table if not exists public.fleet_vehicles (
  id            uuid        primary key default gen_random_uuid(),
  vehicle_name  text        not null,
  status        text        not null default 'idle'
                            check (status in ('in_transit', 'idle', 'maintenance')),
  last_updated  timestamptz not null default now()
);
```

**`id uuid`.** Realtime cannot publish a table with no primary key — it needs
one to identify rows in `DELETE` events. A uuid is chosen over `bigint identity`
so that seed rows, dashboard-created rows and client-side React keys can never
collide.

**`status text` with a `CHECK`.** A Postgres enum would be equally correct. Text
plus a constraint is chosen because adding a fourth status is a one-line
`alter table` rather than an `alter type`, and because the values map one-to-one
onto the TypeScript union:

```ts
type VehicleStatus = 'in_transit' | 'idle' | 'maintenance'
```

Those two lists are a single fact expressed in two places. If you add a status,
edit both in the same commit — otherwise the database accepts a value the UI has
no colour or label for. `resolveStatus()` in `lib/status.ts` catches that case
and falls back to a grey "Unknown" dot, so the card stays readable rather than
rendering blank, but the fallback is a safety net and not a substitute for
editing both lists.

Snake_case values are used rather than `In Transit` so the database stores an
identifier and the UI owns presentation. The display strings live in
`lib/status.ts`.

**`last_updated timestamptz`.** `timestamptz` stores an absolute instant;
`timestamp` stores wall-clock digits with no zone. With plain `timestamp`, a
browser in a different zone renders a time that is confidently wrong, and the
bug only shows up for people who are not where you are.

**No index on `vehicle_name`.** The fleet is a handful of rows; Postgres will
sequential-scan it faster than it would use an index, and sorting happens in the
client anyway. On a real fleet of thousands, add
`create index on public.fleet_vehicles (vehicle_name)`.

---

## 3. The timestamp trigger

```sql
drop trigger if exists set_last_updated on public.fleet_vehicles;

create trigger set_last_updated
  before update on public.fleet_vehicles
  for each row
  execute procedure extensions.moddatetime(last_updated);
```

`before update` so the new value is written as part of the same row write — an
`after` trigger would need a second UPDATE, which would fire the trigger again.

Putting this in the database rather than the client means the timestamp is right
no matter what made the change: the Table Editor, raw SQL, the API, or a future
admin panel. Nothing can forget.

`drop trigger if exists` first, because Postgres has no
`create or replace trigger`, and this file must stay re-runnable.

---

## 4. Row Level Security

```sql
alter table public.fleet_vehicles enable row level security;

drop policy if exists "Public read access" on public.fleet_vehicles;

create policy "Public read access"
  on public.fleet_vehicles
  for select
  to anon, authenticated
  using (true);
```

This is the section worth understanding properly, because the two obvious ways
to get the app working are both wrong.

**RLS on with no policy** denies everything. The fetch returns `[]` with no
error, and Realtime sends nothing. It looks exactly like an empty table.

**RLS off** grants the anon key full table access. That key is compiled into the
JavaScript bundle and anyone can read it out of DevTools, so RLS off means any
visitor can delete your fleet with one `fetch()`.

**RLS on with a `SELECT`-only policy** is the correct shape. Readers read; no
policy exists for `INSERT`, `UPDATE` or `DELETE`, so those are denied by default.
You keep editing rows from the dashboard because the Dashboard and SQL Editor
connect as `postgres`, which bypasses RLS entirely.

`using (true)` means every row is visible to everyone. That is intentional for a
public fleet board. Per-user visibility would replace it with something like
`using (auth.uid() = owner_id)`.

`to anon, authenticated` covers both roles. This app only ever uses `anon`;
including `authenticated` costs nothing and means adding login later does not
silently empty the page.

### RLS and Realtime

Realtime re-evaluates this policy for every subscriber before sending a change.
Consequences:

- A missing `SELECT` policy produces a channel that reports `SUBSCRIBED` and
  then never emits. No error, no warning, no events.
- For `UPDATE`, the policy is checked against the new row.
- For `DELETE`, the deleted row is gone, so the policy cannot be evaluated
  against it. Supabase therefore sends `DELETE` payloads containing only the
  primary key. The client must filter by `payload.old.id` and never assume
  `payload.old` carries `vehicle_name` or `status`. See
  [REALTIME.md](REALTIME.md#event-payloads).

---

## 5. The Realtime publication

```sql
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'fleet_vehicles'
  ) then
    alter publication supabase_realtime add table public.fleet_vehicles;
  end if;
end $$;
```

**The single most common reason a Supabase Realtime tutorial does not work.**
Realtime replays a Postgres publication called `supabase_realtime`, and new
tables are not in it. Your client will connect, authenticate, report
`SUBSCRIBED` and receive nothing, with no error anywhere to explain why.

The equivalent click-path is **Database → Replication →
`supabase_realtime` → toggle the table on**.

The membership check exists because a bare
`alter publication ... add table` errors if the table is already published,
which would break re-running the file.

### Replica identity

Not set here, which means the default: `DEFAULT`, i.e. the primary key.
`UPDATE` and `DELETE` events therefore carry only `id` in `payload.old`.

`alter table public.fleet_vehicles replica identity full` would include every
old column in the payload. This app never reads the previous values, and `FULL`
makes the WAL larger, so the default is the better trade. Change it only if you
add something that needs to diff old against new.

---

## 6. Seed data

```sql
insert into public.fleet_vehicles (vehicle_name, status)
select seed.vehicle_name, seed.status
from (values
  ('Van 01', 'in_transit'), …
) as seed(vehicle_name, status)
where not exists (select 1 from public.fleet_vehicles);
```

Six vehicles covering all three statuses, so the grid shows every colour
immediately and a wrong mapping is visible at a glance.

The `where not exists` guard keys off the table being empty rather than off each
name, so a re-run after you have edited things adds nothing.

---

## Verification

Run these after `schema.sql`. All four should pass before you write any client
code — it is much cheaper to find a missing policy here than to debug a silent
websocket later.

**Rows exist and statuses are valid:**

```sql
select vehicle_name, status, last_updated
from public.fleet_vehicles
order by vehicle_name;
```

**The table is published for Realtime** — must return one row:

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'fleet_vehicles';
```

**RLS is enabled and exactly one policy exists** — `rowsecurity` must be `true`,
and the policy list must contain `Public read access` with `cmd = SELECT` and
nothing else:

```sql
select relname, relrowsecurity as rowsecurity
from pg_class where relname = 'fleet_vehicles';

select policyname, cmd, roles
from pg_policies
where tablename = 'fleet_vehicles';
```

**The trigger fires:**

```sql
update public.fleet_vehicles
set status = 'maintenance'
where vehicle_name = 'Van 01';

select vehicle_name, status, last_updated
from public.fleet_vehicles
where vehicle_name = 'Van 01';
-- last_updated must be within a second or two of now()
```

There is one thing SQL cannot check for you: that the anon key really is
read-only. Verify it from outside the database, with the curl commands in
[TESTING.md](TESTING.md#4-security).

---

## Reset

To start clean:

```sql
drop table if exists public.fleet_vehicles cascade;
```

`cascade` removes the trigger and the policies with it. Dropping the table also
removes it from the publication, so re-run all of `schema.sql` afterwards — not
just the table section.
