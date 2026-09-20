import { resolveStatus } from '@/lib/status'

/**
 * The coloured indicator and its label, kept in one component so they can never
 * drift apart. Colour on its own is unreadable to anyone with a colour vision
 * deficiency and invisible to a screen reader, so the dot is decorative
 * (aria-hidden) and the text carries the meaning.
 */
export default function StatusDot({ status }: { status: string }) {
  const { label, dot } = resolveStatus(status)

  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${dot}`} />
      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
    </span>
  )
}
