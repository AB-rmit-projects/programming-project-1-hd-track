import { FALLBACK_LABELS } from '@/features/incidents/labels'

// Shared by the incident queue and the incident detail page.

/** A missing value: "—" on screen, a word for screen readers. */
export function Missing() {
  return (
    <>
      <span aria-hidden="true">{FALLBACK_LABELS.text}</span>
      <span className="sr-only">Not recorded</span>
    </>
  )
}

/** A text value, or the missing-value marker when it is null. */
export function Text({ value }: { value: string | null }) {
  return value ?? <Missing />
}
