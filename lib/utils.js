import os from 'os'

export function ts () {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

export function log (msg)  { console.log(`[${ts()}] ${msg}`) }
export function warn (msg) { console.warn(`[${ts()}] [!] ${msg}`) }
export function die (msg, code = 1) {
  console.error(`\nError: ${msg}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Minimal arg parser — no external deps
// Handles: positional args, --flag value, --flag (boolean)
// ---------------------------------------------------------------------------
export function parseArgs (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      const val = (next && !next.startsWith('--')) ? (i++, next) : true
      if (key in flags) {
        // Accumulate repeated flags as an array
        flags[key] = [].concat(flags[key], val)
      } else {
        flags[key] = val
      }
    } else {
      positional.push(argv[i])
    }
  }
  return { flags, positional }
}

// ---------------------------------------------------------------------------
// Retry constants for DHT connection attempts
// ---------------------------------------------------------------------------
export const RETRYABLE = new Set([
  'HOLEPUNCH_ABORTED',
  'HOLEPUNCH_TIMEOUT',
  'PEER_NOT_FOUND'
])
export const MAX_RETRIES    = 3
export const RETRY_BASE_MS  = 1500
export const CONNECT_TIMEOUT_MS = 12000

export function hostname () { return os.hostname() }
