// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { addDoc, collection, doc, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore'
import { getClientDb } from '@/lib/firebase/client'
import { buildActionLogData } from '@/features/incidents/decisions'
import { ACTION_TYPE_DESCRIPTIONS, ACTION_TYPE_LABELS } from '@/features/incidents/labels'
import { ACTION_TYPES } from '@/lib/validations/actionLog'

// Every Firestore call that could touch the network is a spy, so the tests can
// show that building a payload never reaches for a database. serverTimestamp()
// stays real: the payload must carry the genuine sentinel.
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  addDoc: vi.fn(),
  setDoc: vi.fn(),
  doc: vi.fn(),
  collection: vi.fn(),
  getFirestore: vi.fn(),
}))
vi.mock('@/lib/firebase/client', () => ({ getClientDb: vi.fn() }))

const OWNER = 'demoOperatorUid01'
const INCIDENT = `${OWNER}_INC-001`
const NOTE = 'Checked the simulated outage evidence.'

function build(input: unknown, incidentId = INCIDENT, ownerUid = OWNER) {
  return buildActionLogData(ownerUid, incidentId, input)
}

function payload(input: unknown) {
  const result = build(input)
  if (!result.ok) throw new Error(`expected a payload, got ${JSON.stringify(result.issues)}`)
  return result.data
}

describe('buildActionLogData — valid decisions', () => {
  it.each(ACTION_TYPES)('builds a %s payload', (actionType) => {
    expect(payload({ actionType, note: NOTE })).toEqual({
      ownerUid: OWNER,
      incidentId: INCIDENT,
      actionType,
      note: NOTE,
      createdAt: serverTimestamp(),
      _schemaVersion: 1,
    })
  })

  it('has exactly the six fields the create rule allows', () => {
    expect(Object.keys(payload({ actionType: 'REVIEWED', note: NOTE })).sort()).toEqual(
      ['_schemaVersion', 'actionType', 'createdAt', 'incidentId', 'note', 'ownerUid'].sort()
    )
  })

  it('uses the serverTimestamp() sentinel for createdAt, never a client time', () => {
    const { createdAt } = payload({ actionType: 'REVIEWED', note: NOTE })
    expect(createdAt.isEqual(serverTimestamp())).toBe(true)
    expect(createdAt).not.toBeInstanceOf(Date)
  })

  it('stores the trimmed note', () => {
    expect(payload({ actionType: 'ACKNOWLEDGE', note: `  ${NOTE}\n\u0001` }).note).toBe(NOTE)
  })

  it('carries nothing else from the input, even fields that look like schema fields', () => {
    const data = payload({
      actionType: 'ESCALATE',
      note: NOTE,
      ownerUid: 'someone-else',
      incidentId: 'bob_INC-001',
      createdAt: new Date('2020-01-01T00:00:00Z'),
      _schemaVersion: 2,
      priority: 'high',
    })
    expect(data).toMatchObject({ ownerUid: OWNER, incidentId: INCIDENT, _schemaVersion: 1 })
    expect(data.createdAt.isEqual(serverTimestamp())).toBe(true)
    expect(data).not.toHaveProperty('priority')
  })

  it('performs no Firestore or client-SDK calls', () => {
    payload({ actionType: 'REVIEWED', note: NOTE })
    build({ actionType: 'CLOSE', note: '' })
    for (const call of [addDoc, setDoc, doc, collection, getFirestore, getClientDb]) {
      expect(vi.mocked(call)).not.toHaveBeenCalled()
    }
  })
})

describe('buildActionLogData — invalid decisions build no payload', () => {
  it.each([['CLOSE'], ['reviewed'], [''], [undefined], [3]])('actionType %s', (actionType) => {
    expect(build({ actionType, note: NOTE })).toEqual({
      ok: false,
      issues: [{ field: 'actionType', message: 'Choose ACKNOWLEDGE, ESCALATE or REVIEWED.' }],
    })
  })

  it.each([
    ['empty', ''],
    ['9 characters', 'a'.repeat(9)],
    ['501 characters', 'a'.repeat(501)],
    ['only whitespace', ' \n\t '.repeat(5)],
    ['only control characters', '\u0001'.repeat(12)],
    ['9 characters once trimmed', `   ${'a'.repeat(9)}   `],
  ])('a note that is %s', (_label, note) => {
    expect(build({ actionType: 'REVIEWED', note })).toEqual({
      ok: false,
      issues: [{ field: 'note', message: 'Enter between 10 and 500 characters.' }],
    })
  })

  it('accepts exactly 10 and exactly 500 characters', () => {
    expect(build({ actionType: 'REVIEWED', note: 'a'.repeat(10) }).ok).toBe(true)
    expect(build({ actionType: 'REVIEWED', note: 'a'.repeat(500) }).ok).toBe(true)
  })

  it('counts length in UTF-16 code units, as the rules do', () => {
    expect(build({ actionType: 'REVIEWED', note: '\u{1F600}'.repeat(5) }).ok).toBe(true)
    expect(build({ actionType: 'REVIEWED', note: '\u{1F600}'.repeat(251) }).ok).toBe(false)
  })

  it('a note that is not a string', () => {
    const result = build({ actionType: 'REVIEWED', note: 1234567890 })
    expect(result).toMatchObject({ ok: false, issues: [{ field: 'note' }] })
  })

  it('reports both fields when both are wrong', () => {
    const result = build({ actionType: 'CLOSE', note: 'short' })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.issues.map((issue) => issue.field)).toEqual(['actionType', 'note'])
  })

  it.each([null, undefined, 'REVIEWED', 42])('input that is not an object (%s)', (input) => {
    expect(build(input)).toMatchObject({ ok: false, issues: [{ field: 'input' }] })
  })

  it.each([
    ['empty', ''],
    ['a path', `${INCIDENT}/actionLogs`],
    ['path traversal', '../bob_INC-001'],
    ['129 characters', 'a'.repeat(129)],
  ])('an incident ID that is %s', (_label, incidentId) => {
    expect(build({ actionType: 'REVIEWED', note: NOTE }, incidentId)).toEqual({
      ok: false,
      issues: [{ field: 'incidentId', message: 'Invalid incident ID.' }],
    })
  })

  it.each(['', '   '])('a blank owner UID (%j)', (ownerUid) => {
    expect(build({ actionType: 'REVIEWED', note: NOTE }, INCIDENT, ownerUid)).toEqual({
      ok: false,
      issues: [{ field: 'ownerUid', message: 'You need to be signed in.' }],
    })
  })
})

describe('decision labels', () => {
  it('names and explains every action type', () => {
    for (const actionType of ACTION_TYPES) {
      expect(ACTION_TYPE_LABELS[actionType]).toBeTruthy()
      expect(ACTION_TYPE_DESCRIPTIONS[actionType]).toBeTruthy()
    }
  })

  it('says ESCALATE sends nothing and leaves the incident awaiting review', () => {
    expect(ACTION_TYPE_DESCRIPTIONS.ESCALATE).toMatch(
      /no alert, notification or welfare check is sent/
    )
    expect(ACTION_TYPE_DESCRIPTIONS.ESCALATE).toMatch(/awaiting review/)
    expect(ACTION_TYPE_DESCRIPTIONS.ACKNOWLEDGE).toMatch(/awaiting review/)
  })
})
