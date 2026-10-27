import { formatMelbourneDateTime } from '@/lib/melbourneTime'

/**
 * A stored time, always shown in Melbourne time with its zone (AEST/AEDT), so
 * it reads the same for every viewer and on the server. A missing time shows
 * `fallback` instead; nothing is estimated.
 */
export function IncidentTime({ at, fallback }: { at: Date | null; fallback: string }) {
  if (!at) return <span className="whitespace-normal text-zinc-500">{fallback}</span>
  return <time dateTime={at.toISOString()}>{formatMelbourneDateTime(at)}</time>
}
