import { parseArgs } from 'node:util'
import { OWNER_UID_PATTERN } from './dataset.ts'

/**
 * Argument parsing and every safety guard for the seed CLI.
 *
 * Pure: no I/O, no Firebase. The CLI passes in process.env and the Firestore
 * emulator port read from firebase.json, and must not touch Firebase unless
 * this returns `ok: true`.
 *
 * Phase 3 is emulator-only. Production seeding (including production dry
 * runs) is refused here and needs a separately approved change to enable.
 */

export const USAGE =
  'Usage: pnpm seed:incidents --project <demo-project-id> --owner-uid <uid> [--write] [--json]\n' +
  '  Emulator only: FIRESTORE_EMULATOR_HOST must point at the local Firestore emulator.\n' +
  '  Without --write the run is a read-only dry run.'

export interface SeedOptions {
  projectId: string
  ownerUid: string
  write: boolean
  json: boolean
  /** Validated `host:port` of the local Firestore emulator. */
  emulatorHost: string
  /**
   * Firestore emulator rule-coverage endpoint, probed to confirm the Firestore
   * emulator (not any HTTP server) is listening before connecting.
   */
  probeUrl: string
}

export type ParseResult = { ok: true; options: SeedOptions } | { ok: false; error: string }

/** Env vars that would put real credentials in scope; refused outright. */
export const CREDENTIAL_ENV_VARS = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_SERVICE_ACCOUNT_KEY_BASE64',
] as const

/** Firebase project IDs are 6–30 chars of a–z, 0–9 and "-"; demo- projects never reach production. */
const DEMO_PROJECT_PATTERN = /^demo-[a-z0-9](?:[a-z0-9-]{0,23}[a-z0-9])?$/

/** Exactly `host:port` — loopback hosts only, no scheme, path or whitespace. */
const EMULATOR_HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/

const PRODUCTION_REFUSAL =
  'Production seeding is not enabled in this build. Phase 3 seeding runs against the local Firestore emulator only.'

const refuse = (error: string): ParseResult => ({ ok: false, error })

export function parseSeedOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  emulatorPort: number
): ParseResult {
  if (env.NEXT_RUNTIME !== undefined) {
    return refuse(
      'Refusing to run inside a Next.js runtime. The seed script is a terminal-only tool.'
    )
  }

  // pnpm may forward a literal "--" ahead of the script's own arguments.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]

  let parsed
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        project: { type: 'string' },
        'owner-uid': { type: 'string' },
        write: { type: 'boolean' },
        json: { type: 'boolean' },
        // Recognised only so they can be refused with a clear message.
        'allow-production': { type: 'boolean' },
        'confirm-project': { type: 'string' },
      },
    })
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }

  const seen = new Set<string>()
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue
    if (seen.has(token.name)) return refuse(`Option --${token.name} was given more than once.`)
    seen.add(token.name)
  }

  const { values } = parsed
  if (values['allow-production'] !== undefined || values['confirm-project'] !== undefined) {
    return refuse(PRODUCTION_REFUSAL)
  }

  const projectId = values.project
  if (projectId === undefined) return refuse('Missing required option --project.')
  if (!DEMO_PROJECT_PATTERN.test(projectId) || projectId.length > 30) {
    return refuse(
      `--project must be a "demo-" Firebase project ID (emulator only), got "${projectId}".`
    )
  }

  const ownerUid = values['owner-uid']
  if (ownerUid === undefined) return refuse('Missing required option --owner-uid.')
  if (!OWNER_UID_PATTERN.test(ownerUid)) {
    return refuse('--owner-uid must be 1–120 characters of A–Z, a–z, 0–9, "_" or "-".')
  }

  for (const name of CREDENTIAL_ENV_VARS) {
    if (env[name] !== undefined) {
      return refuse(
        `Refusing to run while ${name} is set. Unset it; the emulator needs no credentials.`
      )
    }
  }

  const emulatorHost = env.FIRESTORE_EMULATOR_HOST
  if (emulatorHost === undefined || emulatorHost === '') {
    return refuse(`FIRESTORE_EMULATOR_HOST is not set. ${PRODUCTION_REFUSAL}`)
  }
  const match = EMULATOR_HOST_PATTERN.exec(emulatorHost)
  if (!match) {
    return refuse(
      `FIRESTORE_EMULATOR_HOST must be exactly 127.0.0.1:<port>, localhost:<port> or [::1]:<port>, got "${emulatorHost}".`
    )
  }
  const port = Number(match[2])
  if (!Number.isInteger(emulatorPort) || emulatorPort < 1024 || emulatorPort > 65535) {
    return refuse(`The configured Firestore emulator port (${emulatorPort}) is invalid.`)
  }
  if (port < 1024 || port > 65535) {
    return refuse(`FIRESTORE_EMULATOR_HOST port must be between 1024 and 65535, got ${port}.`)
  }
  if (port !== emulatorPort) {
    return refuse(
      `FIRESTORE_EMULATOR_HOST port ${port} does not match the Firestore emulator port ${emulatorPort} in firebase.json.`
    )
  }

  return {
    ok: true,
    options: {
      projectId,
      ownerUid,
      write: values.write === true,
      json: values.json === true,
      emulatorHost,
      probeUrl: `http://${emulatorHost}/emulator/v1/projects/${projectId}:ruleCoverage`,
    },
  }
}
