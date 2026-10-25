import { describe, expect, it } from 'vitest'
import { idSchema, paginationSchema } from '@/lib/validations/common'

describe('idSchema', () => {
  it('accepts a non-empty ID', () => {
    expect(idSchema.safeParse('abc').success).toBe(true)
  })

  it('rejects an empty ID with its message', () => {
    expect(idSchema.safeParse('').error?.issues[0]?.message).toBe('ID is required')
  })
})

describe('paginationSchema', () => {
  it('defaults page and limit', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 20 })
  })

  it('coerces query-string values to numbers', () => {
    expect(paginationSchema.parse({ page: '2', limit: '100' })).toEqual({ page: 2, limit: 100 })
  })

  it.each([
    ['page', '0'],
    ['page', '-1'],
    ['page', '1.5'],
    ['page', 'abc'],
    ['limit', '0'],
    ['limit', '101'],
  ])('rejects %s=%j', (field, value) => {
    expect(paginationSchema.safeParse({ [field]: value }).success).toBe(false)
  })
})
