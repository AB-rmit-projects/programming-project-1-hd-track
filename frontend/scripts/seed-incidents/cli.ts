import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SEED_INCIDENT_COUNT, assertTimelineInPast, buildSeedIncidents } from './dataset.ts'
import { CREDENTIAL_ENV_VARS, USAGE, parseSeedOptions, type SeedOptions } from './options.ts'
import {
  adminIncidentStore,
  exitCodeFor,
  runSeed,
  type IncidentStore,
  type SeedReport,
} from './seed.ts'

/**
 * SafeCall incident seed CLI — administrator-run, terminal only, emulator only.
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *     pnpm seed:incidents --project demo-safecall --owner-uid <uid> [--write] [--json]
 *
 * Order of operations: every safety check (options.ts) → emulator identity
 * probe → only then is Firebase Admin loaded and initialised.
 *
 * Exit codes: 0 complete · 1 any conflict or failure · 2 refused / invalid arguments.
 */

export const EXIT_REFUSED = 2

export interface CliIo {
  out(text: string): void
  err(text: string): void
}

export interface OpenedStore {
  store: IncidentStore
  close(): Promise<void>
}

export interface CliDeps {
  readEmulatorPort(): number
  probe(url: string): Promise<ProbeResult>
  openStore(options: SeedOptions): Promise<OpenedStore>
  now(): Date
}

/** The Firestore emulator port configured in the repo's firebase.json. */
export function readEmulatorPortFromFirebaseJson(
  path: URL = new URL('../../../firebase.json', import.meta.url)
): number {
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const port =
    typeof config === 'object' &&
    config !== null &&
    'emulators' in config &&
    typeof config.emulators === 'object' &&
    config.emulators !== null &&
    'firestore' in config.emulators &&
    typeof config.emulators.firestore === 'object' &&
    config.emulators.firestore !== null &&
    'port' in config.emulators.firestore
      ? config.emulators.firestore.port
      : undefined
  if (typeof port !== 'number') throw new Error('emulators.firestore.port is not set')
  return port
}

export type ProbeResult = { ok: true } | { ok: false; reason: string }

/** Upper bound on the probe body; the observed coverage report is about 48 KB. */
const MAX_PROBE_BYTES = 5_000_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * True only for a Firestore emulator rule-coverage report. Shape observed from
 * firebase-tools 15.34.0 (GET /emulator/v1/projects/{id}:ruleCoverage → 200,
 * application/json): `{ rules: { files: [{ name?, content }] }, report: [...] }`,
 * where a rules file declares `service cloud.firestore`. `name` is present when
 * the rules come from firebase.json and absent after they are loaded over the
 * emulator REST API (as @firebase/rules-unit-testing does).
 */
export function isFirestoreRuleCoverage(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.rules) || !Array.isArray(body.report)) return false
  const files: unknown = body.rules.files
  if (!Array.isArray(files) || files.length === 0) return false
  const wellFormed = files.every(
    (file) =>
      isRecord(file) &&
      typeof file.content === 'string' &&
      (file.name === undefined || typeof file.name === 'string')
  )
  return (
    wellFormed &&
    files.some((file) => isRecord(file) && String(file.content).includes('service cloud.firestore'))
  )
}

/**
 * Confirms the Firestore emulator — not just any HTTP server — is listening at
 * the validated loopback address before Firebase Admin is touched. Redirects
 * are refused so the probe can never be sent elsewhere.
 */
export async function probeEmulator(url: string): Promise<ProbeResult> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    })
  } catch (error) {
    return { ok: false, reason: `no response (${messageOf(error)})` }
  }
  if (response.status !== 200) return { ok: false, reason: `HTTP ${response.status}` }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { ok: false, reason: `unexpected content type "${contentType}"` }
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_PROBE_BYTES) return { ok: false, reason: 'response too large' }

  let body: unknown
  try {
    const text = await response.text()
    if (text.length > MAX_PROBE_BYTES) return { ok: false, reason: 'response too large' }
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'response is not valid JSON' }
  }
  return isFirestoreRuleCoverage(body)
    ? { ok: true }
    : { ok: false, reason: 'response is not a Firestore emulator rule-coverage report' }
}

/**
 * Initialises a dedicated Admin app with a project ID only — no credential.
 * The Firestore SDK reads FIRESTORE_EMULATOR_HOST from process.env when the
 * client is created, so it is re-checked here against the validated value.
 */
export async function openEmulatorStore(options: SeedOptions): Promise<OpenedStore> {
  if (process.env.FIRESTORE_EMULATOR_HOST !== options.emulatorHost) {
    throw new Error('FIRESTORE_EMULATOR_HOST does not match the validated emulator address')
  }
  for (const name of CREDENTIAL_ENV_VARS) {
    if (process.env[name] !== undefined) throw new Error(`${name} is set`)
  }
  const { initializeApp, deleteApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  const app = initializeApp({ projectId: options.projectId }, 'safecall-seed')
  return { store: adminIncidentStore(getFirestore(app)), close: () => deleteApp(app) }
}

const defaultDeps: CliDeps = {
  readEmulatorPort: () => readEmulatorPortFromFirebaseJson(),
  probe: probeEmulator,
  openStore: openEmulatorStore,
  now: () => new Date(),
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function formatReport(options: SeedOptions, report: SeedReport): string {
  const dryRun = report.mode === 'dry-run'
  const lines = [
    `SafeCall incident seed — ${dryRun ? 'DRY RUN (read-only, nothing written)' : 'WRITE'}`,
    `Target:  Firestore emulator at ${options.emulatorHost}, project ${options.projectId}`,
    `Owner:   ${options.ownerUid}`,
    `Records: ${report.total}`,
    dryRun ? `  would create: ${report.wouldCreate.length}` : `  created: ${report.created.length}`,
    `  skipped (already present, untouched): ${report.skipped.length}`,
    `  conflicts (left untouched): ${report.conflicts.length}`,
    `  failed: ${report.failed.length}`,
  ]
  for (const { id, found, mismatched } of report.conflicts) {
    const details = mismatched.map(
      (field) => `${field}=${JSON.stringify(found[field]) ?? 'missing'}`
    )
    lines.push(`  CONFLICT ${id}: unexpected ${details.join(' ')}`)
  }
  for (const { id, error } of report.failed) lines.push(`  FAILED   ${id}: ${error}`)
  lines.push(`Status:  ${report.status}`)
  if (dryRun && report.status === 'COMPLETE' && report.wouldCreate.length > 0) {
    lines.push('Re-run with --write to create the missing incidents.')
  }
  return lines.join('\n')
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  deps: CliDeps = defaultDeps
): Promise<number> {
  let emulatorPort: number
  try {
    emulatorPort = deps.readEmulatorPort()
  } catch (error) {
    io.err(
      `Refused: cannot read the Firestore emulator port from firebase.json (${messageOf(error)}).`
    )
    return EXIT_REFUSED
  }

  const parsed = parseSeedOptions(argv, env, emulatorPort)
  if (!parsed.ok) {
    io.err(`Refused: ${parsed.error}\n\n${USAGE}`)
    return EXIT_REFUSED
  }
  const { options } = parsed

  const probe = await deps.probe(options.probeUrl)
  if (!probe.ok) {
    io.err(
      `Refused: ${options.probeUrl} did not identify as the Firestore emulator (${probe.reason}). Start it first:\n` +
        '  pnpm dlx firebase-tools@15.34.0 emulators:start --only firestore --project demo-safecall'
    )
    return EXIT_REFUSED
  }

  const now = deps.now()
  try {
    assertTimelineInPast(now)
  } catch (error) {
    io.err(`Refused: ${messageOf(error)}.`)
    return EXIT_REFUSED
  }
  const records = buildSeedIncidents(options.ownerUid, now)
  if (records.length !== SEED_INCIDENT_COUNT) {
    io.err(`Internal error: expected ${SEED_INCIDENT_COUNT} seed records, built ${records.length}.`)
    return 1
  }

  let opened: OpenedStore
  try {
    opened = await deps.openStore(options)
  } catch (error) {
    io.err(`Could not open the emulator connection: ${messageOf(error)}`)
    return 1
  }

  try {
    const report = await runSeed(opened.store, records, { write: options.write })
    io.out(
      options.json
        ? JSON.stringify(
            {
              projectId: options.projectId,
              emulatorHost: options.emulatorHost,
              ownerUid: options.ownerUid,
              ...report,
            },
            null,
            2
          )
        : formatReport(options, report)
    )
    return exitCodeFor(report)
  } catch (error) {
    io.err(`Seed run failed: ${messageOf(error)}`)
    return 1
  } finally {
    try {
      await opened.close()
    } catch (error) {
      io.err(`Warning: could not close the Admin app cleanly: ${messageOf(error)}`)
    }
  }
}

/** True only when this file is the script Node was asked to run (not when imported by tests). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  void main(process.argv.slice(2), process.env, {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  }).then((code) => {
    process.exitCode = code
  })
}
