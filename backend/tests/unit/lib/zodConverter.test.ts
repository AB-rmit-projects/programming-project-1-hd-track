import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { createZodConverter } from '../../../src/lib/zodConverter'

const userSchema = z.object({
  uid: z.string(),
  email: z.string(),
  _schemaVersion: z.literal(2),
})

/** The two snapshot members fromFirestore reads. */
function snapshot(data: Record<string, unknown>): QueryDocumentSnapshot {
  return { data: () => data, ref: { path: 'users/u1' } } as unknown as QueryDocumentSnapshot
}

describe('createZodConverter', () => {
  it('returns schema-valid data, dropping unknown fields', () => {
    const converter = createZodConverter(userSchema, 2)
    const user = converter.fromFirestore(
      snapshot({ uid: 'u1', email: 'a@example.test', _schemaVersion: 2, extra: true })
    )
    expect(user).toEqual({ uid: 'u1', email: 'a@example.test', _schemaVersion: 2 })
  })

  it('migrates an older document before validating it', () => {
    const converter = createZodConverter(userSchema, 2, (data, fromVersion) => ({
      ...data,
      email: fromVersion === 1 ? String(data['mail']) : data['email'],
      _schemaVersion: 2,
    }))
    const user = converter.fromFirestore(
      snapshot({ uid: 'u1', mail: 'old@example.test', _schemaVersion: 1 })
    )
    expect(user).toEqual({ uid: 'u1', email: 'old@example.test', _schemaVersion: 2 })
  })

  it('throws with the document path when the data does not match', () => {
    const converter = createZodConverter(userSchema, 2)
    expect(() => converter.fromFirestore(snapshot({ uid: 'u1', _schemaVersion: 2 }))).toThrow(
      /^Firestore schema validation failed at users\/u1: /
    )
  })

  it('writes data unchanged', () => {
    const converter = createZodConverter(userSchema, 2)
    const user = { uid: 'u1', email: 'a@example.test', _schemaVersion: 2 as const }
    expect(converter.toFirestore(user)).toBe(user)
  })
})
