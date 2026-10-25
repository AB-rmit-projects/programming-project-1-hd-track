import { describe, expect, it } from 'vitest'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  signupSchema,
} from '@/lib/validations/auth'

// Pins the messages and accept/reject decisions the sign-in, sign-up and reset
// forms show, so a Zod or resolver upgrade can't change them unnoticed.

const EMAIL_MESSAGE = 'Please enter a valid email address'

const validSignup = {
  displayName: 'Operator One',
  email: 'operator@example.test',
  password: 'Passw0rdX',
  confirmPassword: 'Passw0rdX',
}

/** Each issue as "path: message", in the order Zod reports them. */
function issuesOf(result: {
  success: boolean
  error?: { issues: { path: PropertyKey[]; message: string }[] }
}) {
  return result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? []
}

describe('email fields', () => {
  it.each([
    'operator@example.test',
    'first.last+tag@sub.example.co',
    "o'brien@example.com",
    'UPPER@EXAMPLE.COM',
    'user_name-1@example-domain.org',
  ])('accept %s', (email) => {
    expect(loginSchema.safeParse({ email, password: 'x' }).success).toBe(true)
    expect(resetPasswordSchema.safeParse({ email }).success).toBe(true)
  })

  it.each([
    '',
    'plainaddress',
    'user@localhost',
    'user@example.c',
    '.user@example.com',
    'user.@example.com',
    'us..er@example.com',
    'user @example.com',
    ' user@example.com',
    'user@example.com ',
    'user@-example.com',
    'user@@example.com',
  ])('reject %j with the form message', (email) => {
    expect(issuesOf(loginSchema.safeParse({ email, password: 'x' }))).toEqual([
      `email: ${EMAIL_MESSAGE}`,
    ])
    expect(issuesOf(resetPasswordSchema.safeParse({ email }))).toEqual([`email: ${EMAIL_MESSAGE}`])
  })
})

describe('loginSchema', () => {
  it('requires a password', () => {
    expect(
      issuesOf(loginSchema.safeParse({ email: 'operator@example.test', password: '' }))
    ).toEqual(['password: Password is required'])
  })

  it('rejects missing fields', () => {
    expect(loginSchema.safeParse({}).success).toBe(false)
  })
})

describe.each([
  ['signupSchema', signupSchema],
  ['registerSchema', registerSchema],
])('%s', (_name, schema) => {
  it('accepts a valid sign-up and returns it unchanged', () => {
    const result = schema.safeParse(validSignup)
    expect(result.success && result.data).toEqual(validSignup)
  })

  it.each([
    ['A', 'displayName: Name must be at least 2 characters'],
    ['a'.repeat(51), 'displayName: Name must be less than 50 characters'],
  ])('rejects the display name %j', (displayName, issue) => {
    expect(issuesOf(schema.safeParse({ ...validSignup, displayName }))).toEqual([issue])
  })

  it('accepts display names of exactly 2 and 50 characters', () => {
    expect(schema.safeParse({ ...validSignup, displayName: 'ab' }).success).toBe(true)
    expect(schema.safeParse({ ...validSignup, displayName: 'a'.repeat(50) }).success).toBe(true)
  })

  it.each([
    ['Sh0rtXy', ['password: Password must be at least 8 characters']],
    ['lowercase1', ['password: Password must contain at least one uppercase letter']],
    ['NoNumberHere', ['password: Password must contain at least one number']],
    [
      'short',
      [
        'password: Password must be at least 8 characters',
        'password: Password must contain at least one uppercase letter',
        'password: Password must contain at least one number',
      ],
    ],
  ])('rejects the password %j', (password, issues) => {
    expect(
      issuesOf(schema.safeParse({ ...validSignup, password, confirmPassword: password }))
    ).toEqual(issues)
  })

  it('reports mismatched passwords on confirmPassword', () => {
    expect(issuesOf(schema.safeParse({ ...validSignup, confirmPassword: 'Different1X' }))).toEqual([
      'confirmPassword: Passwords do not match',
    ])
  })

  it('still reports mismatched passwords alongside a field error', () => {
    expect(
      issuesOf(
        schema.safeParse({ ...validSignup, displayName: 'A', confirmPassword: 'Different1X' })
      )
    ).toEqual([
      'displayName: Name must be at least 2 characters',
      'confirmPassword: Passwords do not match',
    ])
  })

  it('rejects an invalid email with the form message', () => {
    expect(issuesOf(schema.safeParse({ ...validSignup, email: 'nope' }))).toEqual([
      `email: ${EMAIL_MESSAGE}`,
    ])
  })
})

// The forms validate through react-hook-form's zodResolver; check the messages
// survive that layer too.
describe('zodResolver', () => {
  const options = { fields: {}, shouldUseNativeValidation: false } as const

  it('passes valid sign-in values through', async () => {
    const values = { email: 'operator@example.test', password: 'x' }
    expect(await zodResolver(loginSchema)(values, undefined, options)).toEqual({
      values,
      errors: {},
    })
  })

  it('maps sign-in errors to fields with the schema messages', async () => {
    const result = await zodResolver(loginSchema)(
      { email: 'nope', password: '' },
      undefined,
      options
    )
    expect(result.values).toEqual({})
    expect(result.errors.email?.message).toBe(EMAIL_MESSAGE)
    expect(result.errors.password?.message).toBe('Password is required')
  })

  it('maps the sign-up password mismatch to confirmPassword', async () => {
    const result = await zodResolver(signupSchema)(
      { ...validSignup, confirmPassword: 'Different1X' },
      undefined,
      options
    )
    expect(Object.keys(result.errors)).toEqual(['confirmPassword'])
    expect(result.errors.confirmPassword?.message).toBe('Passwords do not match')
  })
})
