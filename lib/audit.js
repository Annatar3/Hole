/**
 * Audit log — append-only, one record per line (JSON-L) in ~/.hole/audit.log
 *
 * Record format:
 *   { ts, event, device, service, clientKey, durationMs? }
 */
import fs   from 'fs'
import path from 'path'
import { holeDir } from './registry.js'

function auditPath () { return path.join(holeDir(), 'audit.log') }

function append (record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'
  fs.appendFileSync(auditPath(), line)
}

// Called from agent when a connection arrives
export function auditConnect ({ device, service, clientKey }) {
  append({ event: 'CONNECT', device: device ?? '?', service, clientKey })
}

// Called from agent when a connection closes
export function auditClose ({ device, service, clientKey, durationMs }) {
  append({ event: 'CLOSE', device: device ?? '?', service, clientKey, durationMs })
}

// Called from client when a tunnel opens
export function auditClientConnect ({ target, service, localPort }) {
  append({ event: 'CLIENT_CONNECT', target, service: service ?? 'ssh', localPort })
}

// Called from client when a tunnel closes
export function auditClientClose ({ target, service, durationMs }) {
  append({ event: 'CLIENT_CLOSE', target, service: service ?? 'ssh', durationMs })
}

// ---------------------------------------------------------------------------
// hole audit — print the audit log in a readable table
// ---------------------------------------------------------------------------
export function printAuditLog ({ tail = 50 } = {}) {
  const p = auditPath()
  if (!fs.existsSync(p)) {
    console.log('No audit log found. Connections will be logged automatically.')
    return
  }

  const lines = fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-tail)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)

  if (!lines.length) { console.log('Audit log is empty.'); return }

  const W = { ts: 22, event: 16, device: 18, service: 10, client: 10, dur: 10 }
  const header =
    'TIME'.padEnd(W.ts) +
    'EVENT'.padEnd(W.event) +
    'DEVICE/TARGET'.padEnd(W.device) +
    'SVC'.padEnd(W.service) +
    'CLIENT KEY'.padEnd(W.client) +
    'DURATION'

  console.log('\n' + header)
  console.log('─'.repeat(header.length))

  for (const r of lines) {
    const ts      = r.ts?.slice(0, 19).replace('T', ' ') ?? ''
    const event   = r.event ?? ''
    const device  = (r.device ?? r.target ?? '').slice(0, 16)
    const svc     = (r.service ?? '').slice(0, 8)
    const client  = (r.clientKey ?? '').slice(0, 8)
    const dur     = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : ''
    console.log(
      ts.padEnd(W.ts) +
      event.padEnd(W.event) +
      device.padEnd(W.device) +
      svc.padEnd(W.service) +
      client.padEnd(W.client) +
      dur
    )
  }
  console.log('')
}
