import { z } from 'zod'
import type { ActionType } from '@/types/firestore'

// Keep in sync with the actionLogs create rule in firebase/firestore.rules,
// which enforces the same limits server-side.
export const ACTION_TYPES = [
  'ACKNOWLEDGE',
  'ESCALATE',
  'REVIEWED',
] as const satisfies readonly ActionType[]
export const NOTE_MIN_LENGTH = 10
export const NOTE_MAX_LENGTH = 500

/**
 * An incident document ID, as the actionLogs create rule accepts it
 * (`incidentId.matches('[A-Za-z0-9_-]{1,128}')`). No slashes, dots or
 * percent signs, so a valid ID is always a single, URL-safe path segment.
 */
export const INCIDENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const incidentIdSchema = z.string().regex(INCIDENT_ID_PATTERN, 'Invalid incident ID.')

const noteLengthMessage = `Enter between ${NOTE_MIN_LENGTH} and ${NOTE_MAX_LENGTH} characters.`

const JS_WHITESPACE = /\s/

/**
 * Characters removed from the ends of a note. JavaScript's trim() removes
 * Unicode whitespace; the Firestore rules' trim() removes every character up to
 * U+0020, which includes control characters that JavaScript keeps (U+0000,
 * U+0001 …). The rule requires `note == note.trim()`, so both sets are removed.
 */
function isTrimmable(char: string): boolean {
  return char <= ' ' || JS_WHITESPACE.test(char)
}

/**
 * Trims a note so the security rule's `note == note.trim()` check holds.
 * Lengths are then measured in UTF-16 code units, as both String.length and
 * the rules' size() do (checked against the emulator in
 * tests/rules/noteValidation.rules.test.ts).
 */
export function trimNote(note: string): string {
  let start = 0
  let end = note.length
  while (start < end && isTrimmable(note.charAt(start))) start++
  while (end > start && isTrimmable(note.charAt(end - 1))) end--
  return note.slice(start, end)
}

export const actionLogInputSchema = z.object({
  actionType: z.enum(ACTION_TYPES, { error: 'Choose ACKNOWLEDGE, ESCALATE or REVIEWED.' }),
  // Trimming runs before the length checks, so whitespace padding never counts.
  // Length is String.length (UTF-16 code units), as the rules' size() counts it;
  // Zod 4's min()/max() count code points instead, so an emoji would count once.
  note: z
    .string()
    .transform(trimNote)
    .pipe(
      z
        .string()
        .refine(
          (note) => note.length >= NOTE_MIN_LENGTH && note.length <= NOTE_MAX_LENGTH,
          noteLengthMessage
        )
    ),
})

export type ActionLogInput = z.infer<typeof actionLogInputSchema>
