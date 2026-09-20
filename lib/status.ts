/**
 * The Vehicle shape and the one place status presentation is defined.
 *
 * `VehicleStatus` mirrors the CHECK constraint in schema.sql. The two are a
 * single fact written in two places: adding a status means editing both, in the
 * same commit.
 */

export type VehicleStatus = 'in_transit' | 'idle' | 'maintenance'

export type Vehicle = {
  id: string
  vehicle_name: string
  status: VehicleStatus
  last_updated: string
}

type StatusPresentation = {
  /** Shown next to the dot. Colour alone is not an accessible indicator. */
  label: string
  /** Tailwind background class for the dot. */
  dot: string
}

export const STATUS: Record<VehicleStatus, StatusPresentation> = {
  in_transit: { label: 'In transit', dot: 'bg-emerald-500' },
  idle: { label: 'Idle', dot: 'bg-amber-400' },
  maintenance: { label: 'Maintenance', dot: 'bg-red-500' },
}

/**
 * Presentation for a status the database accepted but this build does not know
 * about — the state you land in if the CHECK constraint gains a value before
 * the type does. Degrades to a grey dot rather than a card with no indicator.
 */
const UNKNOWN: StatusPresentation = { label: 'Unknown', dot: 'bg-slate-400' }

export function resolveStatus(status: string): StatusPresentation {
  return STATUS[status as VehicleStatus] ?? UNKNOWN
}
