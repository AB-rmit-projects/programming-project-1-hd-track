import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Firestore emulator ignores composite indexes, so the rules tests cannot
// catch a missing one. This guards the definition the history query needs:
// where(ownerUid ==) + where(incidentId ==) + orderBy(createdAt desc)
// (see actionHistoryConstraints in src/lib/firebase/firestore.ts).

interface IndexDefinition {
  collectionGroup: string
  queryScope: string
  fields: Array<{ fieldPath: string; order?: string }>
}

const indexes = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../firebase/firestore.indexes.json'), 'utf8')
) as { indexes: IndexDefinition[] }

describe('firestore.indexes.json', () => {
  it('defines the actionLogs history index in query order', () => {
    expect(indexes.indexes).toContainEqual({
      collectionGroup: 'actionLogs',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'ownerUid', order: 'ASCENDING' },
        { fieldPath: 'incidentId', order: 'ASCENDING' },
        { fieldPath: 'createdAt', order: 'DESCENDING' },
      ],
    })
  })
})
