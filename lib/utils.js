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

export function normalizeRelayAddress (relay, label = '--relay') {
  if (relay == null || relay === '') return null
  if (typeof relay !== 'string') {
    throw new Error(`${label} must be host:port`)
  }

  const parts = relay.split(':')
  if (parts.length !== 2) {
    throw new Error(`${label} must be host:port, e.g. 203.0.113.10:49737`)
  }

  const [host, rawPort] = parts
  const port = Number(rawPort)
  if (!host || /\s/.test(host)) {
    throw new Error(`${label} host must not be empty or contain spaces`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} port must be an integer from 1 to 65535`)
  }

  return `${host}:${port}`
}

export function normalizePort (raw, label = '--port') {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`)
  }
  return port
}

export function hintForConnectionStatus (status, relay) {
  const relayHint = relay
    ? `Relay configured (${relay}); verify both sides use the same reachable relay.`
    : 'If both sides are behind strict NAT/CGNAT, try --relay <host:port>.'
  const hints = {
    PEER_CONNECTION_FAILED: `The service key was found but no announced peer accepted the connection. Is hole up running? ${relayHint}`,
    PEER_NOT_FOUND: `No peer announced this key on HyperDHT. Is hole up running on the remote machine? ${relayHint}`,
    HOLEPUNCH_ABORTED: `NAT traversal failed. ${relayHint}`,
    HOLEPUNCH_TIMEOUT: `Hole punch timed out. Check outbound UDP/firewall rules. ${relayHint}`,
    ETIMEDOUT: `Network timeout. Check connectivity and firewall rules. ${relayHint}`,
    ECONNREFUSED: 'Connection was refused by the remote DHT node.'
  }
  return hints[status] ?? null
}
