// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import {
  parseSeedOptions,
  type ParseResult,
  type SeedOptions,
} from '../../../../scripts/seed-incidents/options'
import {
  EXIT_REFUSED,
  main,
  openEmulatorStore,
  isFirestoreRuleCoverage,
  probeEmulator,
  readEmulatorPortFromFirebaseJson,
  type CliDeps,
  type ProbeResult,
} from '../../../../scripts/seed-incidents/cli'

// The Admin SDK must never be initialised by these tests; the mocks record any attempt.
const adminMocks = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({ name: 'safecall-seed' })),
  deleteApp: vi.fn(async () => {}),
  getFirestore: vi.fn(() => ({ collection: vi.fn(), getAll: vi.fn() })),
}))
vi.mock('firebase-admin/app', () => ({
  initializeApp: adminMocks.initializeApp,
  deleteApp: adminMocks.deleteApp,
}))
vi.mock('firebase-admin/firestore', () => ({ getFirestore: adminMocks.getFirestore }))

const PORT = 8080
const EMULATOR_ENV = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }
const VALID_ARGS = ['--project', 'demo-safecall', '--owner-uid', 'demoOperatorUid01']
const COVERAGE_PATH = '/emulator/v1/projects/demo-safecall:ruleCoverage'
const PROBE_URL = `http://127.0.0.1:8080${COVERAGE_PATH}`

function parse(
  argv: string[],
  env: Record<string, string | undefined> = EMULATOR_ENV,
  port = PORT
) {
  return parseSeedOptions(argv, env, port)
}

function expectOk(result: ParseResult): SeedOptions {
  if (!result.ok) throw new Error(`expected ok, got refusal: ${result.error}`)
  return result.options
}

function expectRefused(result: ParseResult, message?: RegExp): void {
  expect(result.ok).toBe(false)
  if (!result.ok && message) expect(result.error).toMatch(message)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('parseSeedOptions — valid arguments', () => {
  it('defaults to a read-only dry run', () => {
    expect(expectOk(parse(VALID_ARGS))).toEqual({
      projectId: 'demo-safecall',
      ownerUid: 'demoOperatorUid01',
      write: false,
      json: false,
      emulatorHost: '127.0.0.1:8080',
      probeUrl: PROBE_URL,
    })
  })

  it('enables writing only with an explicit --write', () => {
    expect(expectOk(parse([...VALID_ARGS, '--write'])).write).toBe(true)
    expect(expectOk(parse([...VALID_ARGS, '--json'])).json).toBe(true)
  })

  it('accepts --flag=value syntax and a leading "--" forwarded by pnpm', () => {
    expect(
      expectOk(parse(['--', '--project=demo-safecall', '--owner-uid=demoOperatorUid01'])).projectId
    ).toBe('demo-safecall')
  })

  it('accepts the localhost and IPv6 loopback forms', () => {
    expect(
      expectOk(parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).probeUrl
    ).toBe(`http://localhost:8080${COVERAGE_PATH}`)
    expect(expectOk(parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: '[::1]:8080' })).probeUrl).toBe(
      `http://[::1]:8080${COVERAGE_PATH}`
    )
  })

  it('accepts a 120-character owner UID (the rules incidentId limit)', () => {
    expectOk(parse(['--project', 'demo-safecall', '--owner-uid', 'a'.repeat(120)]))
  })
})

describe('parseSeedOptions — invalid arguments', () => {
  it('requires --project and --owner-uid', () => {
    expectRefused(parse(['--owner-uid', 'demoOperatorUid01']), /--project/)
    expectRefused(parse(['--project', 'demo-safecall']), /--owner-uid/)
    expectRefused(parse([]), /--project/)
  })

  it.each([
    [['--project']],
    [[...VALID_ARGS, '--force']],
    [[...VALID_ARGS, 'extra-positional']],
    [[...VALID_ARGS, '--write=true']],
    [[...VALID_ARGS, '-w']],
  ])('rejects malformed or unknown arguments: %j', (argv) => {
    expectRefused(parse(argv))
  })

  it('rejects repeated options instead of silently taking the last value', () => {
    expectRefused(parse([...VALID_ARGS, '--project', 'demo-other']), /more than once/)
    expectRefused(parse([...VALID_ARGS, '--write', '--write']), /more than once/)
  })

  it.each(['', 'has space', 'slash/uid', 'dot.uid', 'semi;colon', 'a'.repeat(121)])(
    'rejects owner UID %j',
    (uid) => {
      expectRefused(parse(['--project', 'demo-safecall', '--owner-uid', uid]), /--owner-uid/)
    }
  )

  it.each([
    'safecall-prod',
    'my-real-project',
    'demo-',
    'demo-x-',
    'DEMO-safecall',
    'demo-Safecall',
    'demo_safecall',
    `demo-${'a'.repeat(26)}`,
  ])('rejects non-demo or malformed project ID %j', (projectId) => {
    expectRefused(parse(['--project', projectId, '--owner-uid', 'uid1']), /demo-/)
  })
})

describe('parseSeedOptions — production is refused', () => {
  it('refuses when FIRESTORE_EMULATOR_HOST is absent, in dry-run and write modes', () => {
    expectRefused(parse(VALID_ARGS, {}), /FIRESTORE_EMULATOR_HOST is not set/)
    expectRefused(parse([...VALID_ARGS, '--write'], {}), /FIRESTORE_EMULATOR_HOST is not set/)
    expectRefused(parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: '' }), /not set/)
  })

  it('refuses --allow-production and --confirm-project, even alongside a valid emulator', () => {
    const refusal = /Production seeding is not enabled/
    expectRefused(parse([...VALID_ARGS, '--allow-production']), refusal)
    expectRefused(parse([...VALID_ARGS, '--confirm-project', 'demo-safecall']), refusal)
    expectRefused(
      parse(
        [...VALID_ARGS, '--write', '--allow-production', '--confirm-project', 'demo-safecall'],
        {}
      ),
      refusal
    )
  })

  it.each(['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_SERVICE_ACCOUNT_KEY_BASE64'])(
    'refuses while %s is set, without echoing its value',
    (name) => {
      for (const value of ['SECRET-VALUE', '']) {
        const result = parse(VALID_ARGS, { ...EMULATOR_ENV, [name]: value })
        expectRefused(result, new RegExp(name))
        if (!result.ok) expect(result.error).not.toContain('SECRET-VALUE')
      }
    }
  )

  it('refuses inside a Next.js runtime', () => {
    expectRefused(parse(VALID_ARGS, { ...EMULATOR_ENV, NEXT_RUNTIME: 'nodejs' }), /Next\.js/)
  })
})

describe('parseSeedOptions — emulator address validation', () => {
  it.each([
    '0.0.0.0:8080',
    '192.168.1.5:8080',
    '10.0.0.1:8080',
    'example.com:8080',
    'firestore.googleapis.com:443',
    'localhost.example.com:8080',
    '127.0.0.1.nip.io:8080',
    '127.0.0.2:8080',
    '::1:8080',
    'http://127.0.0.1:8080',
    '127.0.0.1:8080/path',
    ' 127.0.0.1:8080',
    '127.0.0.1:8080 ',
    '127.0.0.1',
    '127.0.0.1:',
    '127.0.0.1:08080',
    '127.0.0.1:port',
    'user@127.0.0.1:8080',
  ])('rejects FIRESTORE_EMULATOR_HOST=%j', (host) => {
    expectRefused(parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: host }), /FIRESTORE_EMULATOR_HOST/)
  })

  it('rejects ports outside 1024–65535', () => {
    expectRefused(parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:80' }), /1024 and 65535/)
    expectRefused(
      parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:99999' }),
      /1024 and 65535/
    )
  })

  it('rejects a port that differs from the firebase.json emulator port', () => {
    expectRefused(
      parse(VALID_ARGS, { FIRESTORE_EMULATOR_HOST: '127.0.0.1:9090' }),
      /does not match .* 8080/
    )
  })

  it('rejects an invalid configured emulator port', () => {
    for (const port of [0, 80, 70000, Number.NaN, 8080.5]) {
      expectRefused(parse(VALID_ARGS, EMULATOR_ENV, port), /configured Firestore emulator port/)
    }
  })
})

describe('readEmulatorPortFromFirebaseJson', () => {
  it('reads the Firestore emulator port from the repo firebase.json', () => {
    expect(readEmulatorPortFromFirebaseJson()).toBe(8080)
  })
})

/** Shaped like the real response observed from the firebase-tools 15.34.0 Firestore emulator. */
const RULES_SOURCE =
  "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {}\n}\n"
const COVERAGE_BODY = {
  rules: { files: [{ name: '/repo/firebase/firestore.rules', content: RULES_SOURCE }] },
  report: [
    { sourcePosition: { line: 8, column: 14, currentOffset: 216, endOffset: 263 }, children: [] },
  ],
}
const JSON_TYPE = { 'content-type': 'application/json' }

function respondWith(body: string | null, init: ResponseInit = {}) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function expectProbeRefused(reason: RegExp) {
  const result = await probeEmulator(PROBE_URL)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toMatch(reason)
}

describe('probeEmulator — Firestore emulator identity', () => {
  it('accepts the Firestore emulator rule-coverage report', async () => {
    const fetchMock = respondWith(JSON.stringify(COVERAGE_BODY), {
      status: 200,
      headers: JSON_TYPE,
    })
    await expect(probeEmulator(PROBE_URL)).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      PROBE_URL,
      expect.objectContaining({ redirect: 'error', headers: { accept: 'application/json' } })
    )
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('accepts the report after rules are loaded over REST (files carry no name)', async () => {
    const body = { ...COVERAGE_BODY, rules: { files: [{ content: RULES_SOURCE }] } }
    respondWith(JSON.stringify(body), { status: 200, headers: JSON_TYPE })
    await expect(probeEmulator(PROBE_URL)).resolves.toEqual({ ok: true })
  })

  it('accepts a JSON content type with a charset parameter', async () => {
    respondWith(JSON.stringify(COVERAGE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    await expect(probeEmulator(PROBE_URL)).resolves.toEqual({ ok: true })
  })

  it('refuses the emulator root "Ok" reply, which any HTTP server could send', async () => {
    respondWith('Ok\n', { status: 200 })
    await expectProbeRefused(/unexpected content type/)
  })

  it('refuses an unrelated HTML page served with 200', async () => {
    respondWith('<!doctype html><title>dev server</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
    await expectProbeRefused(/unexpected content type "text\/html"/)
  })

  it.each([
    ['an empty object', {}],
    ['a generic health reply', { status: 'ok' }],
    ['a JSON array', [COVERAGE_BODY]],
    ['coverage without a report', { rules: COVERAGE_BODY.rules }],
    ['coverage with no rules files', { rules: { files: [] }, report: [] }],
    [
      'a rules file with non-string content',
      { rules: { files: [{ name: 'x', content: 1 }] }, report: [] },
    ],
    [
      'a rules file with a non-string name',
      { rules: { files: [{ name: 7, content: RULES_SOURCE }] }, report: [] },
    ],
    [
      'Storage emulator rules',
      {
        rules: { files: [{ name: 'storage.rules', content: 'service firebase.storage {}' }] },
        report: [],
      },
    ],
  ])('refuses an unrelated JSON 200 response: %s', async (_, body) => {
    respondWith(JSON.stringify(body), { status: 200, headers: JSON_TYPE })
    await expectProbeRefused(/not a Firestore emulator rule-coverage report/)
  })

  it('refuses a JSON content type whose body is not JSON', async () => {
    respondWith('Ok', { status: 200, headers: JSON_TYPE })
    await expectProbeRefused(/not valid JSON/)
  })

  it.each([204, 301, 404, 500])('refuses HTTP %i', async (status) => {
    respondWith(status === 204 ? null : JSON.stringify(COVERAGE_BODY), {
      status,
      headers: JSON_TYPE,
    })
    await expectProbeRefused(new RegExp(`HTTP ${status}`))
  })

  it('refuses an oversized response without parsing it', async () => {
    respondWith(JSON.stringify(COVERAGE_BODY), {
      status: 200,
      headers: { ...JSON_TYPE, 'content-length': '50000000' },
    })
    await expectProbeRefused(/too large/)
  })

  it('refuses when nothing is listening or a redirect is attempted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    )
    await expectProbeRefused(/no response \(fetch failed\)/)
  })
})

describe('isFirestoreRuleCoverage', () => {
  it('requires a Firestore rules file in a well-formed coverage report', () => {
    expect(isFirestoreRuleCoverage(COVERAGE_BODY)).toBe(true)
    expect(isFirestoreRuleCoverage(null)).toBe(false)
    expect(isFirestoreRuleCoverage('Ok')).toBe(false)
    expect(isFirestoreRuleCoverage({ rules: [], report: [] })).toBe(false)
  })
})

describe('openEmulatorStore — last check before Firebase Admin', () => {
  const options: SeedOptions = {
    projectId: 'demo-safecall',
    ownerUid: 'demoOperatorUid01',
    write: false,
    json: false,
    emulatorHost: '127.0.0.1:8080',
    probeUrl: PROBE_URL,
  }

  it('refuses if process.env no longer holds the validated emulator address', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:9999')
    await expect(openEmulatorStore(options)).rejects.toThrow(/does not match/)
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined)
    await expect(openEmulatorStore(options)).rejects.toThrow(/does not match/)
    expect(adminMocks.initializeApp).not.toHaveBeenCalled()
  })

  it('refuses if a credential variable appeared in process.env', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080')
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/key.json')
    await expect(openEmulatorStore(options)).rejects.toThrow(/GOOGLE_APPLICATION_CREDENTIALS/)
    expect(adminMocks.initializeApp).not.toHaveBeenCalled()
  })

  it('initialises a named Admin app with a project ID only (no credential)', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080')
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined)
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_KEY_BASE64', undefined)
    const opened = await openEmulatorStore(options)
    expect(adminMocks.initializeApp).toHaveBeenCalledWith(
      { projectId: 'demo-safecall' },
      'safecall-seed'
    )
    await opened.close()
    expect(adminMocks.deleteApp).toHaveBeenCalledTimes(1)
  })
})

describe('main — safety checks run before any Firebase access', () => {
  function deps(overrides: Partial<CliDeps> = {}) {
    return {
      readEmulatorPort: vi.fn(() => PORT),
      probe: vi.fn(async (): Promise<ProbeResult> => ({ ok: true })),
      openStore: vi.fn(async () => {
        throw new Error('openStore must not be reached in these tests')
      }),
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      ...overrides,
    } satisfies CliDeps
  }
  const io = () => ({ out: vi.fn(), err: vi.fn() })

  it.each([
    ['no arguments', [], EMULATOR_ENV],
    ['emulator host absent', VALID_ARGS, {}],
    ['--allow-production', [...VALID_ARGS, '--allow-production'], EMULATOR_ENV],
    ['non-demo project', ['--project', 'real-project', '--owner-uid', 'uid1'], EMULATOR_ENV],
    ['non-loopback host', VALID_ARGS, { FIRESTORE_EMULATOR_HOST: '10.0.0.1:8080' }],
    ['credentials present', VALID_ARGS, { ...EMULATOR_ENV, GOOGLE_APPLICATION_CREDENTIALS: 'x' }],
    ['Next.js runtime', VALID_ARGS, { ...EMULATOR_ENV, NEXT_RUNTIME: 'edge' }],
  ])('refuses (%s) with exit 2 without probing or opening Firestore', async (_, argv, env) => {
    const d = deps()
    const out = io()
    await expect(main(argv, env, out, d)).resolves.toBe(EXIT_REFUSED)
    expect(d.probe).not.toHaveBeenCalled()
    expect(d.openStore).not.toHaveBeenCalled()
    expect(out.err).toHaveBeenCalledWith(expect.stringMatching(/^Refused: /))
    expect(out.out).not.toHaveBeenCalled()
  })

  it('refuses with exit 2 when firebase.json cannot be read', async () => {
    const d = deps({
      readEmulatorPort: vi.fn(() => {
        throw new Error('ENOENT')
      }),
    })
    await expect(main(VALID_ARGS, EMULATOR_ENV, io(), d)).resolves.toBe(EXIT_REFUSED)
    expect(d.openStore).not.toHaveBeenCalled()
  })

  it('refuses with exit 2 when the probe does not identify the Firestore emulator', async () => {
    const d = deps({
      probe: vi.fn(async (): Promise<ProbeResult> => ({
        ok: false,
        reason: 'unexpected content type ""',
      })),
    })
    const out = io()
    await expect(main(VALID_ARGS, EMULATOR_ENV, out, d)).resolves.toBe(EXIT_REFUSED)
    expect(d.probe).toHaveBeenCalledWith(PROBE_URL)
    expect(d.openStore).not.toHaveBeenCalled()
    expect(out.err).toHaveBeenCalledWith(
      expect.stringContaining('did not identify as the Firestore emulator (unexpected content type')
    )
  })

  it('exits 1 without a report when the emulator connection cannot be opened', async () => {
    const d = deps()
    const out = io()
    await expect(main(VALID_ARGS, EMULATOR_ENV, out, d)).resolves.toBe(1)
    expect(out.out).not.toHaveBeenCalled()
  })
})
