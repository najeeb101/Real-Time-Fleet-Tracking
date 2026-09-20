-- ============================================================================
-- Real-Time Fleet Tracking — database schema
--
-- Run once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Every statement is idempotent, so re-running it is safe.
--
-- Line-by-line explanation: docs/DATABASE.md
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Extension: moddatetime
--
-- Supplies the trigger function that refreshes `last_updated` on every UPDATE.
-- Without this, editing a row in the Table Editor leaves the timestamp stale.
-- ----------------------------------------------------------------------------
create extension if not exists moddatetime schema extensions;


-- ----------------------------------------------------------------------------
-- 2. Table: fleet_vehicles
--
-- `id` is a uuid primary key. Realtime requires a primary key, and a uuid also
-- means seed data and client-side keys never collide.
--
-- `status` is text with a CHECK constraint rather than a Postgres enum. Both
-- work; text + CHECK is easier to extend later and maps directly onto the
-- TypeScript union in lib/status.ts. The two must stay in sync.
--
-- `last_updated` is timestamptz, never timestamp. Plain `timestamp` drops the
-- zone and the browser then renders the wrong local time.
-- ----------------------------------------------------------------------------
create table if not exists public.fleet_vehicles (
  id            uuid        primary key default gen_random_uuid(),
  vehicle_name  text        not null,
  status        text        not null default 'idle'
                            check (status in ('in_transit', 'idle', 'maintenance')),
  last_updated  timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- 3. Trigger: set_last_updated
--
-- `default now()` only applies on INSERT. This trigger covers UPDATE, so the
-- timestamp is correct no matter who changed the row — dashboard, SQL, or API.
-- ----------------------------------------------------------------------------
drop trigger if exists set_last_updated on public.fleet_vehicles;

create trigger set_last_updated
  before update on public.fleet_vehicles
  for each row
  execute procedure extensions.moddatetime(last_updated);


-- ----------------------------------------------------------------------------
-- 4. Row Level Security: read-only for the public
--
-- RLS is ON with exactly one SELECT policy and no INSERT/UPDATE/DELETE policy.
-- The anon key ships in the browser bundle, so anyone can read it — this is
-- what stops a reader from also being a writer.
--
-- Realtime runs the same policy per subscriber, so no policy means no events.
-- Dashboard and SQL Editor run as `postgres` and bypass RLS, which is why you
-- can still edit rows yourself.
-- ----------------------------------------------------------------------------
alter table public.fleet_vehicles enable row level security;

drop policy if exists "Public read access" on public.fleet_vehicles;

create policy "Public read access"
  on public.fleet_vehicles
  for select
  to anon, authenticated
  using (true);


-- ----------------------------------------------------------------------------
-- 5. Realtime publication
--
-- Realtime is OFF for new tables. It broadcasts only what the
-- `supabase_realtime` publication contains. Skip this and the client will
-- subscribe successfully, report SUBSCRIBED, and never receive an event.
--
-- `alter publication ... add table` errors if the table is already a member,
-- so the membership check keeps this file re-runnable.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'fleet_vehicles'
  ) then
    alter publication supabase_realtime add table public.fleet_vehicles;
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 6. Seed data
--
-- Inserts only when the table is empty, so re-running never duplicates rows.
-- ----------------------------------------------------------------------------
insert into public.fleet_vehicles (vehicle_name, status)
select seed.vehicle_name, seed.status
from (values
  ('Van 01',   'in_transit'),
  ('Van 02',   'idle'),
  ('Van 03',   'maintenance'),
  ('Truck 01', 'in_transit'),
  ('Truck 02', 'idle'),
  ('Truck 03', 'in_transit')
) as seed(vehicle_name, status)
where not exists (select 1 from public.fleet_vehicles);
