/**
 * hole dashboard — local web UI for fleet management + web SSH terminal.
 *
 * Starts an HTTP + WebSocket server. HTTP serves the single-page dashboard.
 * WebSocket handles SSH terminal sessions via the HyperDHT tunnel.
 *
 * GET  /           → dashboard UI (HTML)
 * GET  /api/devices → device registry as JSON
 * GET  /api/ping/:name → live DHT reachability check
 * GET  /api/audit  → last N audit log entries
 * GET  /api/device-acl/:name → ACL for selected remote host
 * WS   /ws         → SSH terminal session
 */
import http   from 'http'
import crypto  from 'crypto'
import { WebSocketServer } from 'ws'
import { createRequire } from 'module'
import { spawn }  from 'child_process'
import fs         from 'fs'
import net        from 'net'
import path       from 'path'
import os         from 'os'
import DHT        from 'hyperdht'
import { loadRegistry, addDevice, touchDevice } from './registry.js'
import { loadAuditEntries } from './audit.js'
import { openProxy } from './client.js'
import { warn, log } from './utils.js'

// NOTE: We bundle Hole to CommonJS (dist/bundle.cjs) for pkg.
// In that mode, `import.meta` is empty, so `createRequire(import.meta.url)` breaks.
// This fallback keeps the dashboard working both as ESM (dev) and in the CJS bundle (pkg).
let require
try {
  require = createRequire(import.meta.url)
} catch {
  require = createRequire(typeof __filename !== 'undefined' ? __filename : process.cwd())
}

// Try loading node-pty (optional — without it, web terminal is unavailable)
let pty = null
try { pty = require('node-pty') } catch { /* no-op */ }

// ---------------------------------------------------------------------------
// Active tunnel registry  { id → { id, device, service, localPort, close } }
// ---------------------------------------------------------------------------
let _tunnelSeq = 0
const _tunnels = new Map()

function tunnelStatePath () {
  return path.join(os.homedir(), '.hole', 'tunnels.json')
}

function persistTunnelState () {
  const rows = Array.from(_tunnels.values()).map(({ id, device, service, mode, remotePort, localPort, identity }) =>
    ({ id, device, service, mode, remotePort, localPort, identity })
  )
  try { fs.writeFileSync(tunnelStatePath(), JSON.stringify(rows, null, 2) + '\n') } catch {}
}

async function restorePersistedTunnels () {
  let rows = []
  try { rows = JSON.parse(fs.readFileSync(tunnelStatePath(), 'utf8')) } catch { return }
  if (!Array.isArray(rows) || !rows.length) return
  log(`[dashboard] Restoring ${rows.length} persisted tunnel(s)...`)
  for (const r of rows) {
    try {
      await openTunnel({ device: r.device, service: r.service, port: r.localPort || 0, identity: r.identity || null })
      log(`[dashboard] Restored tunnel → ${r.device}:${r.service}`)
    } catch (e) {
      warn(`[dashboard] Could not restore tunnel ${r.device}:${r.service} — ${e.message}`)
    }
  }
}

const FALLBACK_SERVICE_PORTS = {
  web: 80,
  http: 80,
  https: 443,
  rdp: 3389,
  mysql: 3306,
  pg: 5432,
  postgres: 5432,
  redis: 6379
}

function fallbackPortForService (service) {
  if (!service) return null
  return FALLBACK_SERVICE_PORTS[String(service).trim().toLowerCase()] ?? null
}

async function findFreeLocalPort (preferred = 0) {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    const host = '127.0.0.1'
    srv.once('error', reject)
    srv.listen(preferred || 0, host, () => {
      const addr = srv.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(p))
    })
  })
}

async function openTunnel ({ device, service = null, port = 0, identity = null }) {
  const reg = loadRegistry()
  const dev = reg[device]
  if (!dev) throw new Error(`Device "${device}" not found`)
  const relay = dev.relay ?? null
  const svc = String(service || 'ssh').trim()

  // 1) Preferred path: explicit DHT service key in registry (or default ssh key)
  if (svc === 'ssh' || (dev.services && dev.services[svc])) {
    const proxy = await openProxy({ target: device, service: svc === 'ssh' ? null : svc, port, relay })
    const id = String(++_tunnelSeq)
    const entry = {
      id,
      device,
      service: svc,
      mode: 'dht-service',
      localPort: proxy.localPort,
      identity,
      close: async () => { await proxy.close(); _tunnels.delete(id); persistTunnelState() }
    }
    _tunnels.set(id, entry)
    persistTunnelState()
    return entry
  }

  // 2) Fallback path: no service key registered → tunnel over SSH local forward
  let remotePort = fallbackPortForService(svc)
  // If user picked a concrete local port and there is no explicit service key,
  // treat it as the intended remote port too (best-effort zero-config mode).
  if (!remotePort && port > 0) remotePort = port
  if ((svc === 'web' || svc === 'http' || svc === 'https') && port > 0) remotePort = port
  if (!remotePort) {
    throw new Error(`Service "${svc}" not registered for "${device}". Pick a local port to use as fallback remote port or register a service key.`)
  }

  const sshProxy = await openProxy({ target: device, service: null, port: 0, relay })
  const loginUser = dev.user || process.env.USER || process.env.USERNAME || 'root'
  const keyPath = identity || dev.identity || null
  const localPort = port > 0 ? port : await findFreeLocalPort(remotePort >= 1024 ? remotePort : 0)
  const sshArgs = [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(sshProxy.localPort),
    '-L', `${localPort}:127.0.0.1:${remotePort}`
  ]
  if (keyPath) sshArgs.push('-i', keyPath)
  sshArgs.push(`${loginUser}@localhost`)

  const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += String(d) })

  // Wait briefly so immediate bind/auth failures are returned to UI.
  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const okTimer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, 650)
      child.once('error', (e) => {
        if (settled) return
        settled = true
        clearTimeout(okTimer)
        reject(e)
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(okTimer)
        reject(new Error(stderr.trim() || `SSH forward exited with code ${code}`))
      })
    })
  } catch (e) {
    await sshProxy.close().catch(() => {})
    throw e
  }

  const id = String(++_tunnelSeq)
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { child.kill('SIGTERM') } catch {}
    await sshProxy.close().catch(() => {})
    _tunnels.delete(id)
    persistTunnelState()
  }
  child.once('exit', () => {
    close().catch(() => {})
  })

  const entry = {
    id,
    device,
    service: svc,
    mode: 'ssh-forward',
    remotePort,
    localPort,
    identity: keyPath,
    close
  }
  _tunnels.set(id, entry)
  persistTunnelState()
  return entry
}

async function closeTunnel (id) {
  const t = _tunnels.get(id)
  if (!t) return false
  _tunnels.delete(id)
  try { await t.close() } catch {}
  persistTunnelState()
  return true
}

function tunnelList () {
  return Array.from(_tunnels.values()).map(({ id, device, service, mode, remotePort, localPort, identity }) => ({ id, device, service, mode, remotePort, localPort, identity }))
}

function listLocalSSHKeys () {
  const dir = path.join(os.homedir(), '.ssh')
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return [] }
  const deny = new Set(['known_hosts', 'known_hosts.old', 'config', 'authorized_keys'])
  return entries
    .filter((name) => {
      if (deny.has(name)) return false
      if (name.endsWith('.pub')) return false
      if (name.endsWith('.old')) return false
      return /(^id_|google_compute_engine|\.pem$|\.key$|\.ppk$)/.test(name)
    })
    .map((name) => path.join(dir, name))
    .sort((a, b) => a.localeCompare(b))
}

// ---------------------------------------------------------------------------
// Shared DHT instance for ping checks
// ---------------------------------------------------------------------------
let _dht = null
async function getDHT () {
  if (_dht) return _dht
  _dht = new DHT()
  await _dht.ready()
  return _dht
}

// ---------------------------------------------------------------------------
// Ping a device via DHT — returns { online, latencyMs, error? }
// ---------------------------------------------------------------------------
async function pingDevice (name) {
  const reg = loadRegistry()
  const dev = reg[name]
  if (!dev) return { online: false, error: 'Device not found in registry' }

  let dht
  try { dht = await getDHT() } catch (e) {
    return { online: false, error: 'DHT init failed: ' + e.message }
  }

  const serverPubKey = Buffer.from(dev.key, 'hex')
  const t0 = Date.now()

  return new Promise(resolve => {
    const conn  = dht.connect(serverPubKey)
    const timer = setTimeout(() => {
      conn.destroy()
      resolve({ online: false, error: 'timeout', latencyMs: Date.now() - t0 })
    }, 8000)

    conn.once('open', () => {
      clearTimeout(timer)
      conn.destroy()
      resolve({ online: true, latencyMs: Date.now() - t0 })
    })
    conn.once('error', (e) => {
      clearTimeout(timer)
      conn.destroy()
      resolve({ online: false, error: e.code ?? e.message, latencyMs: Date.now() - t0 })
    })
  })
}

async function runSSH(name, cmd, { timeoutMs = 15000 } = {}) {
  const proxy = await openProxy({ target: name, port: 0 })
  try {
    const reg = loadRegistry()
    const dev = reg[name]
    const user = dev?.user || process.env.USER || 'root'
    const identity = dev?.identity || null
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      '-p', String(proxy.localPort)
    ]
    if (identity) sshArgs.push('-i', identity)
    sshArgs.push(`${user}@localhost`, cmd)
    const child = spawn('ssh', sshArgs)
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const code = await Promise.race([
      new Promise(resolve => child.on('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        reject(new Error(`SSH command timed out after ${timeoutMs}ms`))
      }, timeoutMs))
    ])
    if (code !== 0) throw new Error(stderr.trim() || `ssh failed with code ${code}`)
    return stdout
  } finally {
    await proxy.close().catch(() => {})
  }
}

function shQuote (s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`
}

async function loadRemoteAcl (device) {
  const out = await runSSH(device, `cat ~/.hole/acl.json 2>/dev/null || echo '{}'`)
  try {
    const parsed = JSON.parse(out || '{}')
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
  } catch {
    return {}
  }
}

async function saveRemoteAcl (device, aclObj) {
  const json = JSON.stringify(aclObj, null, 2) + '\n'
  // Keep file private on remote host.
  await runSSH(device, `umask 077 && printf %s ${shQuote(json)} > ~/.hole/acl.json`)
}

// ---------------------------------------------------------------------------
// Auth token  — generated once, stored in ~/.hole/dashboard-token
// ---------------------------------------------------------------------------
function loadOrCreateToken (holeDir) {
  const tokenPath = path.join(holeDir, 'dashboard-token')
  try {
    const t = fs.readFileSync(tokenPath, 'utf8').trim()
    if (t.length >= 32) return t
  } catch {}
  const t = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, t + '\n', { mode: 0o600 })
  return t
}

let _authToken = null

function isAuthorized (req) {
  if (!_authToken) return true  // safety: no token configured → open (shouldn't happen)
  const auth = req.headers['authorization'] || ''
  if (auth.startsWith('Bearer ') && auth.slice(7) === _authToken) return true
  const u = new URL(req.url, 'http://h')
  if (u.searchParams.get('token') === _authToken) return true
  return false
}

function json (res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------
async function handleRequest (req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  const sendJson = (data, status = 200) => json(res, data, status)

  // ── Root → serve dashboard UI ──────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(buildUI(_authToken))
    return
  }

  // ── Auth gate — all /api/* and /ws require a valid token ───────────────
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized — missing or invalid token' }))
      return
    }
  }

  // ── GET /api/devices ────────────────────────────────────────────────────
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    const reg = loadRegistry()
    const devices = Object.entries(reg).map(([name, d]) => ({ name, ...d }))
    sendJson({ devices })
    return
  }

  // ── PUT /api/devices/:name ──────────────────────────────────────────────
  if (url.pathname.startsWith('/api/devices/') && req.method === 'PUT') {
    const name = decodeURIComponent(url.pathname.slice('/api/devices/'.length))
    const reg = loadRegistry()
    if (!reg[name]) { sendJson({ error: `Unknown device "${name}"` }, 404); return }

    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {}
        const patch = {}

        if ('user' in payload) patch.user = payload.user ? String(payload.user).trim() : undefined
        if ('relay' in payload) patch.relay = payload.relay ? String(payload.relay).trim() : undefined
        if ('identity' in payload) patch.identity = payload.identity ? String(payload.identity).trim() : undefined
        if ('tags' in payload) {
          const tags = Array.isArray(payload.tags) ? payload.tags.map(t => String(t).trim()).filter(Boolean) : []
          patch.tags = tags
        }
        if ('services' in payload) {
          if (!payload.services || typeof payload.services !== 'object' || Array.isArray(payload.services)) {
            sendJson({ error: 'services must be an object map: { name: 64hexKey }' }, 400)
            return
          }
          const next = {}
          for (const [svc, keyRaw] of Object.entries(payload.services)) {
            const svcName = String(svc).trim()
            const key = String(keyRaw || '').trim().toLowerCase()
            if (!svcName) continue
            if (!/^[0-9a-f]{64}$/i.test(key)) {
              sendJson({ error: `Invalid key for service "${svcName}" (must be 64-char hex)` }, 400)
              return
            }
            next[svcName] = key
          }
          patch.services = next
        }

        touchDevice(name, patch)
        const updated = loadRegistry()[name]
        sendJson({ ok: true, device: { name, ...updated } })
      } catch (e) {
        sendJson({ error: 'Invalid JSON body: ' + e.message }, 400)
      }
    })
    return
  }

  // ── POST /api/devices ───────────────────────────────────────────────────
  if (url.pathname === '/api/devices' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const payload = body ? JSON.parse(body) : {}
        const name = String(payload.name || '').trim()
        const key  = String(payload.key  || '').trim().toLowerCase()
        if (!name) { sendJson({ error: 'name is required' }, 400); return }
        if (!/^[0-9a-f]{64}$/i.test(key)) { sendJson({ error: 'key must be a 64-character hex string' }, 400); return }
        const reg = loadRegistry()
        if (reg[name]) { sendJson({ error: `Device "${name}" already exists` }, 409); return }
        const meta = {}
        if (payload.user)     meta.user     = String(payload.user).trim()
        if (payload.relay)    meta.relay    = String(payload.relay).trim()
        if (payload.identity) meta.identity = String(payload.identity).trim()
        if (Array.isArray(payload.tags)) meta.tags = payload.tags.map(t => String(t).trim()).filter(Boolean)
        const dev = addDevice(name, key, meta)
        sendJson({ ok: true, device: { name, ...dev } })
      } catch (e) {
        sendJson({ error: 'Invalid JSON: ' + e.message }, 400)
      }
    })
    return
  }

  // ── DELETE /api/devices/:name ────────────────────────────────────────────
  if (url.pathname.startsWith('/api/devices/') && req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.slice('/api/devices/'.length))
    const reg = loadRegistry()
    if (!reg[name]) { sendJson({ error: `Unknown device "${name}"` }, 404); return }
    const { removeDevice } = await import('./registry.js')
    removeDevice(name)
    sendJson({ ok: true })
    return
  }

  // ── GET /api/ssh-keys ───────────────────────────────────────────────────
  if (url.pathname === '/api/ssh-keys' && req.method === 'GET') {
    sendJson({ keys: listLocalSSHKeys() })
    return
  }

  // ── GET /api/ping/:name ─────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/ping/') && req.method === 'GET') {
    const name   = decodeURIComponent(url.pathname.slice('/api/ping/'.length))
    const result = await pingDevice(name)
    sendJson(result)
    return
  }

  // ── File Operations ───────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/files/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/files/'.length).split('/')[0])
    const path_ = url.searchParams.get('path') || '/'
    const op = url.pathname.slice(`/api/files/${encodeURIComponent(name)}`.length)

    try {
      // GET /api/files/:name -> List files
      if (req.method === 'GET' && !op) {
        const stdout = await runSSH(name, `ls -aF "${path_}"`)
        const files = stdout.split('\n')
          .map(f => f.trim())
          .filter(f => f && f !== './' && f !== '../')
          .map(f => ({
            name: f.replace(/[*@|]$/, '').replace(/\/$/, ''),
            isDir: f.endsWith('/'),
          }))
          .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name))
        return sendJson({ path: path_, files })
      }

      // GET /api/files/:name/download -> Download file
      if (req.method === 'GET' && op === '/download') {
        const proxy = await openProxy({ target: name, port: 0 })
        const { user, identity } = loadRegistry()[name] || {}
        const sshArgs = ['-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-p',String(proxy.localPort)]
        if (identity) sshArgs.push('-i', identity)
        sshArgs.push(`${user||'root'}@localhost`, `cat "${path_}"`)
        
        const child = spawn('ssh', sshArgs)
        res.setHeader('Content-Disposition', `attachment; filename="${path_.split('/').pop() || 'file'}"`)
        child.stdout.pipe(res)
        child.on('exit', () => proxy.close().catch(() => {}))
        return
      }

      // POST /api/files/:name/upload -> Upload file
      if (req.method === 'POST' && op === '/upload') {
        const proxy = await openProxy({ target: name, port: 0 })
        const { user, identity } = loadRegistry()[name] || {}
        const sshArgs = ['-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-p',String(proxy.localPort)]
        if (identity) sshArgs.push('-i', identity)
        sshArgs.push(`${user||'root'}@localhost`, `cat > "${path_}"`)
        
        const child = spawn('ssh', sshArgs)
        req.pipe(child.stdin)
        const code = await new Promise(resolve => child.on('exit', resolve))
        await proxy.close().catch(() => {})
        if (code !== 0) throw new Error('Upload failed')
        return sendJson({ success: true })
      }

      // POST /api/files/:name/mkdir -> Create directory
      if (req.method === 'POST' && op === '/mkdir') {
        await runSSH(name, `mkdir -p "${path_}"`)
        return sendJson({ success: true })
      }

      // POST /api/files/:name/rename -> Rename/Move
      if (req.method === 'POST' && op === '/rename') {
        const to = url.searchParams.get('to')
        if (!to) throw new Error('Target path "to" required')
        await runSSH(name, `mv "${path_}" "${to}"`)
        return sendJson({ success: true })
      }

      // DELETE /api/files/:name -> Delete
      if (req.method === 'DELETE') {
        await runSSH(name, `rm -rf "${path_}"`)
        return sendJson({ success: true })
      }

    } catch (e) {
      return sendJson({ error: e.message }, 500)
    }
  }

  // ── GET /api/audit ──────────────────────────────────────────────────────
  if (url.pathname === '/api/audit' && req.method === 'GET') {
    const tail    = parseInt(url.searchParams.get('tail') ?? '100', 10)
    const entries = loadAuditEntries(tail)
    sendJson({ entries })
    return
  }

  // ── GET /api/tunnels ────────────────────────────────────────────────────
  if (url.pathname === '/api/tunnels' && req.method === 'GET') {
    sendJson({ tunnels: tunnelList() })
    return
  }

  // ── POST /api/tunnels ────────────────────────────────────────────────────
  if (url.pathname === '/api/tunnels' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {}
        const device  = String(payload.device  || '').trim()
        const service = payload.service ? String(payload.service).trim() : null
        const port    = parseInt(payload.port ?? '0', 10) || 0
        const identity = payload.identity ? String(payload.identity).trim() : null
        if (!device) { sendJson({ error: 'device is required' }, 400); return }
        try {
          const entry = await openTunnel({ device, service, port, identity })
          sendJson({ ok: true, tunnel: { id: entry.id, device: entry.device, service: entry.service, localPort: entry.localPort, identity: entry.identity } })
        } catch (e) {
          sendJson({ error: e.message }, 500)
        }
      } catch (e) {
        sendJson({ error: 'Invalid JSON: ' + e.message }, 400)
      }
    })
    return
  }

  // ── DELETE /api/tunnels/:id ───────────────────────────────────────────────
  if (url.pathname.startsWith('/api/tunnels/') && req.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/tunnels/'.length))
    const ok = await closeTunnel(id).catch(() => false)
    sendJson({ ok })
    return
  }

  // ── POST /api/exec ────────────────────────────────────────────────────────
  if (url.pathname === '/api/exec' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {}
        const cmd     = String(payload.cmd || '').trim()
        const devices = Array.isArray(payload.devices) ? payload.devices : []
        if (!cmd)          { sendJson({ error: 'cmd is required' }, 400); return }
        if (!devices.length) { sendJson({ error: 'devices list is required' }, 400); return }

        const results = await Promise.allSettled(
          devices.map(async (name) => {
            const t0 = Date.now()
            const out = await runSSH(String(name), cmd, { timeoutMs: 20000 })
            return { name, output: out, durationMs: Date.now() - t0 }
          })
        )

        const rows = results.map((r, i) => {
          if (r.status === 'fulfilled') return { name: devices[i], ok: true, output: r.value.output, durationMs: r.value.durationMs }
          return { name: devices[i], ok: false, error: r.reason?.message || String(r.reason) }
        })
        sendJson({ results: rows })
      } catch (e) {
        sendJson({ error: 'Invalid JSON: ' + e.message }, 400)
      }
    })
    return
  }

  // ── Per-device ACL API (remote host) ────────────────────────────────────
  if (url.pathname.startsWith('/api/device-acl/')) {
    const device = decodeURIComponent(url.pathname.slice('/api/device-acl/'.length))
    if (!device) { sendJson({ error: 'Missing device name' }, 400); return }

    if (req.method === 'GET') {
      try {
        const acl = await loadRemoteAcl(device)
        sendJson({ acl })
      } catch (e) {
        sendJson({ error: e.message }, 500)
      }
      return
    }

    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        try {
          const payload = body ? JSON.parse(body) : {}
          const entry = String(payload.name || '').trim()
          const key = String(payload.key || '').trim().toLowerCase()
          if (!entry || !key) { sendJson({ error: 'Both "name" and "key" are required.' }, 400); return }
          if (!/^[0-9a-f]{64}$/i.test(key)) { sendJson({ error: 'Key must be a 64-character hex string.' }, 400); return }
          const acl = await loadRemoteAcl(device)
          acl[entry] = key
          await saveRemoteAcl(device, acl)
          sendJson({ ok: true, acl })
        } catch (e) {
          sendJson({ error: e.message }, 500)
        }
      })
      return
    }

    if (req.method === 'DELETE') {
      const entry = decodeURIComponent(url.searchParams.get('name') || '').trim()
      if (!entry) { sendJson({ error: 'Missing ?name=<entry>' }, 400); return }
      try {
        const acl = await loadRemoteAcl(device)
        delete acl[entry]
        await saveRemoteAcl(device, acl)
        sendJson({ ok: true, acl })
      } catch (e) {
        sendJson({ error: e.message }, 500)
      }
      return
    }
  }

  res.writeHead(404)
  res.end('Not found')
}

// ---------------------------------------------------------------------------
// WebSocket terminal session handler
// ---------------------------------------------------------------------------
function handleTerminalWS (ws) {
  let proxyClose = null
  let ptyProc    = null
  let ready      = false

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }

  const cleanup = () => {
    if (ptyProc) { try { ptyProc.kill() } catch {} ; ptyProc = null }
    if (proxyClose) { proxyClose().catch(() => {}); proxyClose = null }
  }

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    // ── connect: set up DHT proxy + spawn SSH with PTY ──────────────────
    if (msg.type === 'connect' && !ready) {
      ready = true
      const { device, user, identity: identityOverride = null, cols = 80, rows = 24 } = msg

      if (!pty) {
        send({ type: 'error', message: 'node-pty is not available. Run: npm install node-pty' })
        return
      }

      send({ type: 'output', data: btoa('\x1b[90m[hole] Connecting to ' + device + '...\x1b[0m\r\n') })

      const reg = loadRegistry()
      const dev = reg[device] ?? null
      const relay    = dev?.relay ?? null
      const identity = identityOverride || dev?.identity || null

      let localPort
      try {
        const proxy = await openProxy({ target: device, port: 0, relay })
        localPort  = proxy.localPort
        proxyClose = proxy.close
      } catch (e) {
        send({ type: 'error', message: 'Tunnel failed: ' + e.message })
        return
      }

      send({ type: 'output', data: btoa('\x1b[90m[hole] Tunnel up on :' + localPort + ', starting SSH...\x1b[0m\r\n') })

      const loginUser = user || dev?.user || process.env.USER || process.env.USERNAME || 'root'
      const safePTYCols = (Number.isInteger(cols) && cols > 0) ? cols : 80
      const safePTYRows = (Number.isInteger(rows) && rows > 0) ? rows : 24

      const sshArgs = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-o', 'BatchMode=no',
        '-p', String(localPort)
      ]
      if (identity) sshArgs.push('-i', identity)
      sshArgs.push(loginUser + '@localhost')

      const cmdLine = 'ssh ' + sshArgs.join(' ')
      warn('[dashboard] spawning PTY: ' + cmdLine + '  (cols=' + safePTYCols + ' rows=' + safePTYRows + ')')
      send({ type: 'output', data: btoa('\x1b[90m[hole] cmd: ' + cmdLine + '\x1b[0m\r\n') })
      send({ type: 'output', data: btoa('\x1b[90m[hole] PTY size: ' + safePTYCols + 'x' + safePTYRows + '\x1b[0m\r\n') })

      try {
        ptyProc = pty.spawn('ssh', sshArgs, {
          name: 'xterm-256color',
          cols: safePTYCols,
          rows: safePTYRows,
          env: { ...process.env, TERM: 'xterm-256color' }
        })
        warn('[dashboard] PTY spawned pid=' + ptyProc.pid)
        send({ type: 'output', data: btoa('\x1b[90m[hole] SSH process started (pid=' + ptyProc.pid + ')...\x1b[0m\r\n') })
      } catch (e) {
        warn('[dashboard] SSH spawn failed: ' + e.message)
        send({ type: 'error', message: 'SSH spawn failed: ' + e.message })
        cleanup()
        return
      }

      ptyProc.onData(data => {
        try {
          send({ type: 'output', data: btoa(data) })
        } catch (e) {
          warn('[dashboard] btoa error on PTY data: ' + e.message)
        }
      })

      ptyProc.onExit(({ exitCode, signal }) => {
        warn('[dashboard] SSH exited: code=' + exitCode + ' signal=' + signal)
        send({ type: 'output', data: btoa('\r\n\x1b[90m[hole] SSH exited (code=' + exitCode + (signal ? ' signal=' + signal : '') + ')\x1b[0m\r\n') })
        send({ type: 'exit', code: exitCode })
        cleanup()
      })

      return
    }

    // ── input: forward keystrokes to PTY ────────────────────────────────
    if (msg.type === 'input' && ptyProc) {
      try { ptyProc.write(atob(msg.data)) } catch {}
      return
    }

    // ── resize: update PTY dimensions ───────────────────────────────────
    if (msg.type === 'resize' && ptyProc) {
      try { ptyProc.resize(msg.cols, msg.rows) } catch {}
      return
    }
  })

  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

// PTY output is raw binary — must use 'binary' encoding, NOT 'utf8'.
// UTF-8 encoding corrupts any byte > 127 (ANSI sequences, MOTD, etc).
function btoa (s) { return Buffer.from(s, 'binary').toString('base64') }
// User input from xterm is UTF-8 text.
function atob (s) { return Buffer.from(s, 'base64').toString('utf8') }

// ---------------------------------------------------------------------------
// run({ port })
// ---------------------------------------------------------------------------
export async function run ({ port = 4321 } = {}) {
  // Load (or generate) the auth token before starting the server
  const { holeDir } = await import('./registry.js')
  _authToken = loadOrCreateToken(holeDir())

  const server = http.createServer(handleRequest)
  const wss    = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://h')
    if (pathname === '/ws') {
      // Auth check for WebSocket connections
      const auth = req.headers['authorization'] || ''
      const tokenOk = !_authToken ||
        (auth.startsWith('Bearer ') && auth.slice(7) === _authToken) ||
        searchParams.get('token') === _authToken
      if (!tokenOk) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, ws => handleTerminalWS(ws))
    } else {
      socket.destroy()
    }
  })

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve)
    server.once('error', reject)
  })

  const baseUrl   = `http://localhost:${port}`
  const accessUrl = `${baseUrl}/?token=${_authToken}`
  console.log('\n=== Hole Dashboard ===')
  console.log(`URL    : ${accessUrl}`)
  console.log(`Devices: ${Object.keys(loadRegistry()).length} registered`)
  if (!pty) console.log('\n[!] node-pty not found — web terminal disabled (run: npm install node-pty)')
  console.log('\nPress Ctrl+C to stop.\n')

  // Attempt to restore tunnels that were open before the last shutdown
  restorePersistedTunnels().catch(() => {})

  // Auto-open browser with auth token
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [accessUrl], { detached: true, stdio: 'ignore' }).unref()

  process.on('SIGINT', async () => {
    log('Shutting down dashboard...')
    for (const t of _tunnels.values()) { try { await t.close() } catch {} }
    try { fs.unlinkSync(tunnelStatePath()) } catch {}
    server.close()
    if (_dht) await _dht.destroy().catch(() => {})
    process.exit(0)
  })
}

// ---------------------------------------------------------------------------
// buildUI — returns the full dashboard HTML as a string
// ---------------------------------------------------------------------------
function buildUI (token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hole Dashboard</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
  <style>
    :root {
      --bg:         #0d1117;
      --sidebar:    #161b22;
      --card:       #21262d;
      --border:     #30363d;
      --accent:     #58a6ff;
      --accent-dim: #1f6feb;
      --text:       #e6edf3;
      --muted:      #8b949e;
      --green:      #3fb950;
      --red:        #f85149;
      --yellow:     #d29922;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px; display: flex; flex-direction: column;
    }

    /* ── Header ─────────────────────────────────────────────────── */
    header {
      height: 52px; flex-shrink: 0;
      background: var(--sidebar); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 12px; padding: 0 20px;
    }
    .logo { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .logo-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
    .header-pills { display: flex; gap: 8px; margin-left: auto; }
    .pill {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 12px; border-radius: 20px;
      background: var(--card); border: 1px solid var(--border);
      font-size: 12px; color: var(--muted);
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .dot-green  { background: var(--green); }
    .dot-red    { background: var(--red); }
    .dot-yellow { background: var(--yellow); animation: blink 1.4s ease-in-out infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }

    /* ── Layout ─────────────────────────────────────────────────── */
    .layout { display: flex; flex: 1; overflow: hidden; }

    /* ── Sidebar ─────────────────────────────────────────────────── */
    aside {
      width: 230px; flex-shrink: 0;
      background: var(--sidebar); border-right: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .sidebar-label {
      padding: 14px 16px 6px;
      font-size: 10px; font-weight: 700; letter-spacing: .1em;
      text-transform: uppercase; color: var(--muted);
    }
    .device-list { flex: 1; overflow-y: auto; padding: 4px 8px 8px; }
    .device-item {
      display: flex; align-items: center; gap: 9px;
      padding: 8px 10px; border-radius: 7px; cursor: pointer;
      transition: background .12s; margin-bottom: 1px;
    }
    .device-item:hover  { background: var(--card); }
    .device-item.active { background: #1f6feb30; }
    .device-name { flex: 1; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .device-meta { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .fleet-tags {
      padding: 0 12px 6px;
      display: flex; flex-wrap: wrap; gap: 6px;
      max-height: 64px; overflow-y: auto;
    }
    .fleet-tag {
      font-size: 10px; padding: 2px 8px;
      border-radius: 999px; border: 1px solid var(--border);
      color: var(--muted); cursor: pointer;
      background: transparent; user-select: none;
    }
    .fleet-tag.active {
      border-color: var(--accent); color: var(--accent);
      background: #1f6feb30;
    }
    .sidebar-foot {
      padding: 10px 16px; border-top: 1px solid var(--border);
      font-size: 11px; color: var(--muted);
    }

    /* ── Main area ───────────────────────────────────────────────── */
    main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

    /* Empty state */
    .empty {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 10px; color: var(--muted);
    }
    .empty-icon { font-size: 40px; opacity: .25; }
    .empty-title { font-size: 15px; font-weight: 500; }
    .empty-sub   { font-size: 12px; opacity: .6; }

    /* Device panel (hidden until device selected) */
    .device-panel { display: none; flex-direction: column; height: 100%; overflow: hidden; }
    .device-panel.show { display: flex; }

    /* Tabs */
    .tabs {
      display: flex; flex-shrink: 0;
      background: var(--sidebar); border-bottom: 1px solid var(--border);
      padding: 0 20px;
    }
    .tab {
      padding: 13px 16px; font-size: 13px; cursor: pointer;
      color: var(--muted); border-bottom: 2px solid transparent;
      margin-bottom: -1px; transition: color .1s;
    }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 500; }

    /* Tab panels */
    .panel       { display: none; flex: 1; overflow: auto; padding: 20px; flex-direction: column; gap: 16px; }
    .panel.show  { display: flex; }
    .panel.terminal-panel { padding: 0; overflow: hidden; }

    /* Info cards */
    .card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px;
    }
    .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 14px; }
    .device-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .device-title  { font-size: 22px; font-weight: 700; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600;
    }
    .badge-online   { background: #3fb95020; color: var(--green); }
    .badge-offline  { background: #f8514920; color: var(--red); }
    .badge-checking { background: #d2992220; color: var(--yellow); }

    .kv-grid { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; }
    .kv-label { color: var(--muted); padding: 3px 0; }
    .kv-value { color: var(--text); font-family: "SF Mono","Fira Code",Menlo,monospace; font-size: 12px; padding: 3px 0; word-break: break-all; }
    .kv-value.copy { cursor: pointer; }
    .kv-value.copy:hover { color: var(--accent); }

    .tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag  { background: #58a6ff18; color: var(--accent); border: 1px solid #58a6ff30; border-radius: 4px; padding: 1px 8px; font-size: 11px; font-family: sans-serif; }

    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 500;
      cursor: pointer; border: 1px solid var(--border); background: var(--card);
      color: var(--text); transition: all .12s; white-space: nowrap;
    }
    .btn:hover    { background: #30363d; }
    .btn-primary  { background: var(--accent-dim); border-color: var(--accent-dim); color: #fff; }
    .btn-primary:hover { background: var(--accent); border-color: var(--accent); }
    .btn-danger   { color: var(--red); border-color: #f8514940; }
    .btn-danger:hover { background: #f8514915; }
    .btn-sm       { padding: 4px 10px; font-size: 11px; }

    input[type=text] {
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      padding: 6px 10px; color: var(--text); font-size: 13px; outline: none;
    }
    input[type=text]:focus { border-color: var(--accent); }

    #ping-result { margin-top: 10px; font-size: 12px; min-height: 18px; }

    /* Terminal panel */
    .term-toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 14px; background: #1a1d21; border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .term-title  { flex: 1; font-family: "SF Mono","Fira Code",monospace; font-size: 12px; color: var(--muted); }
    #term-wrap   { flex: 1; background: #0d1117; overflow: hidden; min-height: 0; }
    .xterm       { height: 100% !important; }
    .xterm-viewport { overflow-y: auto !important; }

    .no-term {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 14px; color: var(--muted);
    }

    /* Audit table */
    .audit-wrap { overflow: auto; border-radius: 8px; border: 1px solid var(--border); }
    table  { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th {
      text-align: left; padding: 9px 14px;
      background: var(--card); color: var(--muted); font-weight: 600;
      border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1;
    }
    tbody td { padding: 7px 14px; border-bottom: 1px solid #21262d; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: var(--card); }
    .ev-connect { color: var(--green); }
    .ev-close   { color: var(--muted); }
    .ev-client  { color: var(--accent); }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
  </style>
</head>
<body>

<!-- ── Header ──────────────────────────────────────────────────────────── -->
<header>
  <div class="logo"><div class="logo-dot"></div> Hole Dashboard</div>
  <div class="header-pills">
    <div class="pill"><span class="dot dot-green"></span><span id="h-online">0 online</span></div>
    <div class="pill"><span class="dot dot-red"></span><span id="h-offline">0 offline</span></div>
    <div class="pill" id="h-total">0 devices</div>
  </div>
</header>

<div class="layout">

  <!-- ── Sidebar ─────────────────────────────────────────────────────── -->
  <aside>
    <div class="sidebar-label">Fleet</div>
    <div style="padding:0 12px 6px">
      <input type="text" id="fleet-search" placeholder="Filter by name or tag" style="width:100%;font-size:12px">
    </div>
    <div class="fleet-tags" id="fleet-tags"></div>
    <div class="device-list" id="fleet-list">
      <div style="padding:10px 6px;color:var(--muted)">Loading...</div>
    </div>
    <div class="sidebar-foot">
      <div id="fleet-foot" style="margin-bottom:6px"></div>
      <button class="btn btn-sm btn-primary" id="btn-add-device" style="width:100%">+ Add device</button>
    </div>
  </aside>

  <!-- ── Main ────────────────────────────────────────────────────────── -->
  <main>
    <!-- Empty state -->
    <div class="empty" id="empty-state">
      <div class="empty-icon">🕳</div>
      <div class="empty-title">Select a device</div>
      <div class="empty-sub">Choose a machine from the fleet on the left</div>
    </div>

    <!-- Device panel (hidden until selection) -->
    <div class="device-panel" id="device-panel">

      <!-- Tabs -->
      <div class="tabs">
        <div class="tab active" data-tab="details">Details</div>
        <div class="tab" data-tab="terminal">Terminal</div>
        <div class="tab" data-tab="tunnels">Tunnels</div>
        <div class="tab" data-tab="exec">Exec</div>
        <div class="tab" data-tab="files">Files</div>
        <div class="tab" data-tab="acl">ACL</div>
        <div class="tab" data-tab="audit">Audit</div>
      </div>

      <!-- Details panel -->
      <div class="panel show" id="panel-details">
        <div class="card">
          <div class="device-header">
            <div class="device-title" id="d-name"></div>
            <div class="badge badge-checking" id="d-badge">
              <span class="dot dot-yellow"></span> Checking...
            </div>
            <button class="btn btn-sm btn-danger" id="btn-dev-delete" style="margin-left:auto" title="Remove device from registry">Remove</button>
          </div>
          <div class="kv-grid">
            <div class="kv-label">Public Key</div>
            <div class="kv-value copy" id="d-key" title="Click to copy full key"></div>
            <div class="kv-label">Hostname</div>
            <div class="kv-value" id="d-host"></div>
            <div class="kv-label">Last Seen</div>
            <div class="kv-value" id="d-seen"></div>
            <div class="kv-label">Added</div>
            <div class="kv-value" id="d-added"></div>
            <div class="kv-label">Services</div>
            <div class="kv-value" id="d-services"></div>
            <div class="kv-label">Health</div>
            <div class="kv-value" id="d-health"></div>
            <div class="kv-label">Tags</div>
            <div class="kv-value"><div class="tags" id="d-tags"></div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">SSH Connection</div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <label style="color:var(--muted)">User</label>
            <input type="text" id="ssh-user" placeholder="root" style="width:110px">
            <label style="color:var(--muted)">SSH key</label>
            <select id="ssh-identity" style="min-width:260px;max-width:420px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;outline:none">
              <option value="">Default for device</option>
            </select>
            <button class="btn btn-primary" id="btn-connect">&#9654; Open Terminal</button>
            <button class="btn" id="btn-ping">&#8635; Ping</button>
          </div>
          <div id="ping-result"></div>
        </div>

        <div class="card">
          <div class="card-title">Device Settings (Registry)</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="text" id="dev-user" placeholder="Default SSH user" style="width:170px;font-size:12px">
            <input type="text" id="dev-relay" placeholder="Relay host:port" style="width:190px;font-size:12px">
            <input type="text" id="dev-identity" placeholder="Identity file path" style="min-width:280px;flex:1;font-size:12px">
            <input type="text" id="dev-tags" placeholder="Tags (comma-separated)" style="min-width:240px;flex:1;font-size:12px">
            <button class="btn btn-sm btn-primary" id="btn-dev-save">Save settings</button>
          </div>
          <div id="dev-save-result" style="margin-top:8px;font-size:12px;color:var(--muted)"></div>
        </div>

        <div class="card">
          <div class="card-title">Service Keys</div>
          <div id="svc-list" style="font-size:12px;color:var(--muted);margin-bottom:10px">No services.</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="text" id="svc-name" placeholder="Service name (web, ssh, rdp...)" style="width:220px;font-size:12px">
            <input type="text" id="svc-key" placeholder="64-char service key" style="min-width:280px;flex:1;font-size:12px">
            <button class="btn btn-sm btn-primary" id="btn-svc-add">Add / Update service</button>
          </div>
          <div id="svc-result" style="margin-top:8px;font-size:12px;color:var(--muted)"></div>
        </div>

      </div>

      <!-- Terminal panel -->
      <div class="panel terminal-panel" id="panel-terminal">
        <div class="no-term" id="no-term">
          <div style="color:var(--muted)">No active session</div>
          <button class="btn btn-primary" id="btn-connect2">&#9654; Start SSH Session</button>
        </div>
        <div id="term-view" style="display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0">
          <div class="term-toolbar">
            <div class="term-title" id="term-title">terminal</div>
            <button class="btn btn-sm btn-danger" id="btn-disconnect">&#10005; Disconnect</button>
          </div>
          <div id="term-wrap"></div>
        </div>
      </div>

      <!-- Tunnels panel -->
      <div class="panel" id="panel-tunnels">
        <div class="card">
          <div class="card-title">Active tunnels</div>
          <div id="tunnels-list" style="font-size:12px;color:var(--muted);margin-bottom:12px">None open.</div>
        </div>
        <div class="card">
          <div class="card-title">Open new tunnel</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px">
            <select id="tun-service" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:13px;outline:none">
              <option value="ssh">ssh</option>
            </select>
            <input type="number" id="tun-port" placeholder="Local port (0 = auto)" min="0" max="65535" style="width:190px;font-size:13px">
            <select id="tun-identity" style="min-width:240px;max-width:420px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;color:var(--text);font-size:12px;outline:none">
              <option value="">SSH key (optional)</option>
            </select>
            <button class="btn btn-primary btn-sm" id="btn-tun-open">Open tunnel</button>
          </div>
          <div style="margin-top:10px">
            <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Quick presets:</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px" id="tun-presets">
              <button class="btn btn-sm" data-svc="ssh"   data-port="2222">SSH :2222</button>
              <button class="btn btn-sm" data-svc="web"   data-port="8080">HTTP :8080</button>
              <button class="btn btn-sm" data-svc="web"   data-port="80">HTTP :80</button>
              <button class="btn btn-sm" data-svc="web"   data-port="3000">HTTP :3000</button>
              <button class="btn btn-sm" data-svc="web"   data-port="5000">HTTP :5000</button>
              <button class="btn btn-sm" data-svc="rdp"   data-port="3389">RDP :3389</button>
              <button class="btn btn-sm" data-svc="mysql" data-port="3306">MySQL :3306</button>
              <button class="btn btn-sm" data-svc="pg"    data-port="5432">Postgres :5432</button>
              <button class="btn btn-sm" data-svc="redis" data-port="6379">Redis :6379</button>
            </div>
          </div>
          <div id="tun-result" style="margin-top:10px;font-size:12px;min-height:18px"></div>
          <div style="margin-top:8px;font-size:11px;color:var(--muted)">
            Tunnels run in the dashboard process and close when you stop it.
          </div>
        </div>
      </div>

      <!-- Exec panel -->
      <div class="panel" id="panel-exec">
        <div class="card">
          <div class="card-title">Run command</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:6px">
              <label style="color:var(--muted);white-space:nowrap;font-size:12px">Scope</label>
              <select id="exec-scope" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;color:var(--text);font-size:12px;outline:none">
                <option value="selected">This device</option>
                <option value="all">All devices</option>
              </select>
              <select id="exec-tag-filter" style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;color:var(--text);font-size:12px;outline:none">
                <option value="">All tags</option>
              </select>
            </div>
            <input type="text" id="exec-cmd" placeholder='Command  (e.g. uptime)' style="flex:1;min-width:240px;font-family:monospace;font-size:13px">
            <button class="btn btn-primary btn-sm" id="btn-exec-run">&#9654; Run</button>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
            Commands run over SSH via the DHT tunnel. Results appear below.
          </div>
        </div>
        <div class="card" id="exec-results" style="display:none">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>Results</span>
            <button class="btn btn-sm" id="btn-exec-clear">Clear</button>
          </div>
          <div id="exec-output" style="font-family:monospace;font-size:12px;white-space:pre-wrap;max-height:400px;overflow-y:auto;color:var(--text)"></div>
        </div>
      </div>

      <!-- Files panel -->
      <div class="panel" id="panel-files">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <button class="btn btn-sm" id="btn-files-back">&larr; Back</button>
          <div id="files-path" style="font-family:monospace;font-size:12px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis">/</div>
          <button class="btn btn-sm" id="btn-files-mkdir">+ Folder</button>
          <button class="btn btn-sm btn-primary" id="btn-files-upload">&#8679; Upload</button>
          <button class="btn btn-sm" id="btn-files-refresh">Refresh</button>
          <input type="file" id="files-upload-input" style="display:none">
        </div>
        <div id="files-content" class="audit-wrap" style="flex:1">
          <div style="padding:20px;color:var(--muted)">Select a device and path to browse files.</div>
        </div>
      </div>

      <!-- ACL panel (selected host) -->
      <div class="panel" id="panel-acl">
        <div class="card">
          <div class="card-title">ACL for selected host</div>
          <div id="device-acl-body" style="font-size:12px;color:var(--muted);margin-bottom:10px">Select a device to load ACL.</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
            <input type="text" id="device-acl-name" placeholder="Name (laptop, ci, ...)" style="width:180px;font-size:12px">
            <input type="text" id="device-acl-key" placeholder="64-char client key" style="flex:1;min-width:0;font-size:12px">
            <button class="btn btn-sm btn-primary" id="device-acl-add-btn">Add</button>
          </div>
          <div style="margin-top:8px;font-size:11px;color:var(--muted)">
            This edits <code>~/.hole/acl.json</code> on the selected host over SSH.
            Empty ACL means open mode (any client allowed).
          </div>
        </div>
      </div>

      <!-- Audit panel -->
      <div class="panel" id="panel-audit">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="margin:0;font-size:13px;font-weight:600;color:var(--text)">Recent Activity</h3>
          <button class="btn btn-sm" id="btn-export-audit">Export CSV</button>
        </div>
        <div id="audit-content" style="color:var(--muted)">Loading...</div>
      </div>

    </div><!-- /device-panel -->
  </main>
</div>

<!-- ── Add Device Modal ───────────────────────────────────────────────── -->
<div id="modal-overlay" style="display:none;position:fixed;inset:0;background:#00000090;z-index:100;align-items:center;justify-content:center">
  <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px 32px;width:480px;max-width:95vw">
    <div style="font-size:15px;font-weight:700;margin-bottom:20px">Add device</div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input type="text" id="add-dev-name" placeholder="Name  (e.g. my-server)" style="width:100%">
      <input type="text" id="add-dev-key"  placeholder="Public key  (64-char hex)" style="width:100%;font-family:monospace;font-size:12px">
      <input type="text" id="add-dev-user" placeholder="Default SSH user  (optional)" style="width:100%">
      <input type="text" id="add-dev-tags" placeholder="Tags, comma-separated  (optional)" style="width:100%">
    </div>
    <div id="add-dev-err" style="color:var(--red);font-size:12px;margin-top:10px;min-height:16px"></div>
    <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
      <button class="btn" id="btn-modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="btn-modal-confirm">Add</button>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
// ── State ────────────────────────────────────────────────────────────────
var S = {
  devices: {},
  sshKeys: [],
  selected: null,
  ws: null,
  term: null,
  fit: null,
  filterText: '',
  filterTag: 'all',
  token: '${token || ''}'
}

// Patch fetch to always include Authorization header
var _origFetch = window.fetch
window.fetch = function(url, opts) {
  opts = opts || {}
  opts.headers = opts.headers || {}
  if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token
  return _origFetch(url, opts)
}

// ── Boot ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function(t) {
  t.addEventListener('click', function() { switchTab(t.dataset.tab) })
})
document.getElementById('btn-connect').addEventListener('click', openTerminal)
document.getElementById('btn-connect2').addEventListener('click', openTerminal)
document.getElementById('btn-disconnect').addEventListener('click', killTerminal)
document.getElementById('btn-ping').addEventListener('click', doPing)
document.getElementById('btn-export-audit').addEventListener('click', exportAudit)
document.getElementById('btn-dev-save').addEventListener('click', saveDeviceSettings)
document.getElementById('btn-svc-add').addEventListener('click', addOrUpdateService)
document.getElementById('device-acl-add-btn').addEventListener('click', addDeviceAclEntry)
document.getElementById('btn-dev-delete').addEventListener('click', function() {
  var name = S.selected; if (!name) return
  if (!confirm('Remove "' + name + '" from the local registry? This does not affect the remote agent.')) return
  fetch('/api/devices/' + encodeURIComponent(name), { method: 'DELETE' })
    .then(function(r) { return r.json() })
    .then(function(data) {
      if (data.error) { alert(data.error); return }
      S.selected = null
      document.getElementById('device-panel').classList.remove('show')
      document.getElementById('empty-state').style.display = ''
      delete S.devices[name]
      renderFleet()
      updateHeader()
    })
    .catch(function(e) { alert('Error: ' + e.message) })
})

// Global copy-to-clipboard handler for elements with .copy class
document.addEventListener('click', function(e) {
  var el = e.target.closest('.copy')
  if (!el) return
  var full = el.dataset.full
  if (!full) return
  navigator.clipboard.writeText(full).then(function() {
    var prev = el.textContent
    el.textContent = 'Copied!'
    setTimeout(function() { el.textContent = prev }, 1500)
  })
})

var fleetSearch = document.getElementById('fleet-search')
if (fleetSearch) {
  fleetSearch.addEventListener('input', function() {
    S.filterText = this.value
    renderFleet()
  })
}

loadFleet()
setInterval(loadFleet, 30000)
loadSSHKeys()

// ── Fleet ─────────────────────────────────────────────────────────────────
function loadSSHKeys() {
  fetch('/api/ssh-keys')
    .then(function(r) { return r.json() })
    .then(function(body) {
      S.sshKeys = body.keys || []
      populateIdentitySelectors()
    })
    .catch(function() {
      S.sshKeys = []
      populateIdentitySelectors()
    })
}

function populateIdentitySelectors() {
  var sshSel = document.getElementById('ssh-identity')
  var tunSel = document.getElementById('tun-identity')
  var dev = S.selected ? (S.devices[S.selected] || {}) : {}
  var devIdentity = dev.identity || ''

  if (sshSel) {
    var html = '<option value=\"\">Default for device' + (devIdentity ? (' (' + esc(devIdentity) + ')') : '') + '</option>'
    S.sshKeys.forEach(function(k) {
      html += '<option value=\"' + esc(k) + '\">' + esc(k) + '</option>'
    })
    sshSel.innerHTML = html
    sshSel.value = devIdentity && S.sshKeys.indexOf(devIdentity) !== -1 ? devIdentity : ''
  }

  if (tunSel) {
    var html2 = '<option value=\"\">No SSH key override</option>'
    S.sshKeys.forEach(function(k) {
      html2 += '<option value=\"' + esc(k) + '\">' + esc(k) + '</option>'
    })
    tunSel.innerHTML = html2
    tunSel.value = devIdentity && S.sshKeys.indexOf(devIdentity) !== -1 ? devIdentity : ''
  }
}

function loadFleet() {
  fetch('/api/devices').then(function(r) { return r.json() }).then(function(body) {
    S.devices = {}
    body.devices.forEach(function(d) { S.devices[d.name] = d })
    buildFleetTags()
    renderFleet()
    updateHeader()
    body.devices.forEach(function(d) { pingBackground(d.name) })
  })
}

function buildFleetTags() {
  var el = document.getElementById('fleet-tags')
  if (!el) return
  var devs = Object.values(S.devices)
  var tags = new Set()
  devs.forEach(function(d) {
    (d.tags || []).forEach(function(t) { tags.add(String(t)) })
  })
  var all = Array.from(tags).sort()
  var html = ''
  html += '<span class="fleet-tag' + (S.filterTag === 'all' ? ' active' : '') + '" data-tag="all">All</span>'
  all.forEach(function(t) {
    html += '<span class="fleet-tag' + (S.filterTag === t ? ' active' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + '</span>'
  })
  el.innerHTML = html
  el.querySelectorAll('.fleet-tag').forEach(function(node) {
    node.addEventListener('click', function() {
      var tag = this.getAttribute('data-tag') || 'all'
      S.filterTag = tag
      buildFleetTags()
      renderFleet()
    })
  })
}

function renderFleet() {
  var el    = document.getElementById('fleet-list')
  var devs  = Object.values(S.devices)

  // Apply text and tag filters
  var q   = (S.filterText || '').trim().toLowerCase()
  var tag = S.filterTag || 'all'
  if (tag !== 'all') {
    devs = devs.filter(function(d) {
      return (d.tags || []).indexOf(tag) !== -1
    })
  }
  if (q) {
    devs = devs.filter(function(d) {
      var name = (d.name || '').toLowerCase()
      var tags = (d.tags || []).map(function(t) { return String(t).toLowerCase() })
      return name.indexOf(q) !== -1 || tags.some(function(t) { return t.indexOf(q) !== -1 })
    })
  }

  if (!devs.length) {
    el.innerHTML = '<div style="padding:10px 6px;color:var(--muted);line-height:1.6">No devices registered.<br>Click <strong>+ Add device</strong> below or run:<br><code>hole add &lt;name&gt; &lt;key&gt;</code></div>'
    return
  }
  el.innerHTML = devs.map(function(d) {
    var n = d.name
    var dot = d._s === 'online' ? 'dot-green' : d._s === 'offline' ? 'dot-red' : 'dot-yellow'
    var active = S.selected === n ? ' active' : ''
    var metaBits = []
    var tags = (d.tags || [])
    if (tags.length) metaBits.push(tags.join(', '))
    if (d._lat) {
      metaBits.push(d._lat + 'ms')
    } else if (d.lastSeen) {
      metaBits.push(ago(d.lastSeen))
    }
    var meta = metaBits.join(' · ') || 'never'
    return '<div class="device-item' + active + '" data-name="' + esc(n) + '">' +
      '<span class="dot ' + dot + '"></span>' +
      '<span class="device-name">' + esc(n) + '</span>' +
      '<span class="device-meta">' + esc(meta) + '</span>' +
      '</div>'
  }).join('')
  el.querySelectorAll('.device-item').forEach(function(el) {
    el.addEventListener('click', function() { selectDevice(this.dataset.name) })
  })
}

function updateHeader() {
  var devs = Object.values(S.devices)
  var on   = devs.filter(function(d) { return d._s === 'online' }).length
  var off  = devs.filter(function(d) { return d._s === 'offline' }).length
  document.getElementById('h-online').textContent  = on + ' online'
  document.getElementById('h-offline').textContent = off + ' offline'
  document.getElementById('h-total').textContent   = devs.length + ' device' + (devs.length !== 1 ? 's' : '')
  document.getElementById('fleet-foot').textContent =
    devs.length + ' device' + (devs.length !== 1 ? 's' : '') + ' \u00b7 ' + on + ' reachable'
}

function pingBackground(name) {
  if (S.devices[name]) S.devices[name]._s = 'checking'
  renderFleet()
  fetch('/api/ping/' + encodeURIComponent(name))
    .then(function(r) { return r.json() })
    .then(function(data) {
      if (!S.devices[name]) return
      S.devices[name]._s   = data.online ? 'online' : 'offline'
      S.devices[name]._lat = data.online ? data.latencyMs : null
      renderFleet()
      updateHeader()
      if (S.selected === name) refreshBadge()
    })
    .catch(function() {
      if (S.devices[name]) S.devices[name]._s = 'offline'
      renderFleet(); updateHeader()
    })
}

// ── Device selection ─────────────────────────────────────────────────────
function selectDevice(name) {
  S.selected = name
  renderFleet()

  document.getElementById('empty-state').style.display = 'none'
  document.getElementById('device-panel').classList.add('show')

  var d = S.devices[name]
  document.getElementById('d-name').textContent = name
  var keyEl = document.getElementById('d-key')
  keyEl.textContent = d.key ? d.key.slice(0,20) + '...' : '\u2014'
  keyEl.dataset.full = d.key || ''
  document.getElementById('d-host').textContent     = d.host || '\u2014'
  document.getElementById('d-seen').textContent     = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : 'never'
  document.getElementById('d-added').textContent    = d.addedAt  ? new Date(d.addedAt).toLocaleString()  : '\u2014'
  document.getElementById('d-services').textContent = Object.keys(d.services || {}).join(', ') || '\u2014'

  var m = d.metrics
  var hEl = document.getElementById('d-health')
  if (m) {
    var up = m.uptime > 86400 ? Math.floor(m.uptime/86400) + 'd' : Math.floor(m.uptime/3600) + 'h'
    hEl.innerHTML = 'CPU ' + m.cpu + ' · RAM ' + m.mem + '% · UP ' + up
    hEl.style.color = 'var(--text)'
  } else {
    hEl.textContent = '\u2014'
    hEl.style.color = 'var(--muted)'
  }

  var tags = d.tags || []
  document.getElementById('d-tags').innerHTML = tags.length
    ? tags.map(function(t) { return '<span class="tag">' + esc(t) + '</span>' }).join('')
    : '<span style="color:var(--muted)">none</span>'

  document.getElementById('ssh-user').value = d.user || ''
  document.getElementById('dev-user').value = d.user || ''
  document.getElementById('dev-relay').value = d.relay || ''
  document.getElementById('dev-identity').value = d.identity || ''
  document.getElementById('dev-tags').value = (d.tags || []).join(', ')
  renderServiceList()
  document.getElementById('dev-save-result').textContent = ''
  document.getElementById('svc-result').textContent = ''
  document.getElementById('ping-result').textContent = ''
  populateIdentitySelectors()

  refreshBadge()
  if (document.querySelector('.tab.active') && document.querySelector('.tab.active').dataset.tab === 'acl') {
    loadDeviceAclUI()
  }
  switchTab('details')
}

function getSelectedDevice() {
  var name = S.selected
  return name ? (S.devices[name] || null) : null
}

function renderServiceList() {
  var d = getSelectedDevice()
  var el = document.getElementById('svc-list')
  if (!el) return
  var services = d && d.services ? d.services : {}
  var names = Object.keys(services)
  if (!names.length) {
    el.innerHTML = '<div style="color:var(--muted)">No services registered.</div>'
    return
  }
  var html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
    '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">Service</th>' +
    '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">Key</th>' +
    '<th style="width:80px"></th>' +
    '</tr></thead><tbody>'
  names.sort().forEach(function(name) {
    var key = services[name]
    html += '<tr>' +
      '<td style="padding:4px 0">' + esc(name) + '</td>' +
      '<td style="padding:4px 0;font-family:monospace">' + esc(String(key).slice(0, 16)) + '...</td>' +
      '<td style="padding:4px 0;text-align:right"><button class="btn btn-sm btn-danger" data-svc-del="' + esc(name) + '">Remove</button></td>' +
      '</tr>'
  })
  html += '</tbody></table>'
  el.innerHTML = html
  el.querySelectorAll('[data-svc-del]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var svc = this.getAttribute('data-svc-del')
      removeService(svc)
    })
  })
}

function saveDevicePatch(patch) {
  var name = S.selected
  return fetch('/api/devices/' + encodeURIComponent(name), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  }).then(function(r) { return r.json() })
}

function saveDeviceSettings() {
  var d = getSelectedDevice(); if (!d) return
  var tags = (document.getElementById('dev-tags').value || '')
    .split(',')
    .map(function(t) { return t.trim() })
    .filter(Boolean)
  var patch = {
    user: document.getElementById('dev-user').value.trim(),
    relay: document.getElementById('dev-relay').value.trim(),
    identity: document.getElementById('dev-identity').value.trim(),
    tags: tags
  }
  var out = document.getElementById('dev-save-result')
  out.style.color = 'var(--muted)'
  out.textContent = 'Saving...'
  saveDevicePatch(patch).then(function(res) {
    if (res.error) {
      out.style.color = 'var(--red)'
      out.textContent = 'Error: ' + res.error
      return
    }
    S.devices[S.selected] = Object.assign({}, S.devices[S.selected], res.device)
    populateIdentitySelectors()
    var tagsEl = document.getElementById('d-tags')
    var tags = res.device.tags || []
    tagsEl.innerHTML = tags.length
      ? tags.map(function(t) { return '<span class="tag">' + esc(t) + '</span>' }).join('')
      : '<span style="color:var(--muted)">none</span>'
    renderFleet()
    out.style.color = 'var(--green)'
    out.textContent = 'Saved.'
  }).catch(function(e) {
    out.style.color = 'var(--red)'
    out.textContent = 'Error: ' + e.message
  })
}

function addOrUpdateService() {
  var d = getSelectedDevice(); if (!d) return
  var svc = (document.getElementById('svc-name').value || '').trim()
  var key = (document.getElementById('svc-key').value || '').trim().toLowerCase()
  var out = document.getElementById('svc-result')
  if (!svc) { out.style.color = 'var(--red)'; out.textContent = 'Service name is required.'; return }
  if (!/^[0-9a-f]{64}$/i.test(key)) { out.style.color = 'var(--red)'; out.textContent = 'Service key must be 64-char hex.'; return }
  var next = Object.assign({}, d.services || {})
  next[svc] = key
  out.style.color = 'var(--muted)'
  out.textContent = 'Saving...'
  saveDevicePatch({ services: next }).then(function(res) {
    if (res.error) {
      out.style.color = 'var(--red)'
      out.textContent = 'Error: ' + res.error
      return
    }
    S.devices[S.selected] = Object.assign({}, S.devices[S.selected], res.device)
    document.getElementById('svc-name').value = ''
    document.getElementById('svc-key').value = ''
    document.getElementById('d-services').textContent = Object.keys(res.device.services || {}).join(', ') || '\u2014'
    renderServiceList()
    loadTunnelsUI()
    out.style.color = 'var(--green)'
    out.textContent = 'Service saved.'
  }).catch(function(e) {
    out.style.color = 'var(--red)'
    out.textContent = 'Error: ' + e.message
  })
}

function removeService(svc) {
  var d = getSelectedDevice(); if (!d) return
  var next = Object.assign({}, d.services || {})
  delete next[svc]
  var out = document.getElementById('svc-result')
  out.style.color = 'var(--muted)'
  out.textContent = 'Saving...'
  saveDevicePatch({ services: next }).then(function(res) {
    if (res.error) {
      out.style.color = 'var(--red)'
      out.textContent = 'Error: ' + res.error
      return
    }
    S.devices[S.selected] = Object.assign({}, S.devices[S.selected], res.device)
    document.getElementById('d-services').textContent = Object.keys(res.device.services || {}).join(', ') || '\u2014'
    renderServiceList()
    loadTunnelsUI()
    out.style.color = 'var(--green)'
    out.textContent = 'Service removed.'
  }).catch(function(e) {
    out.style.color = 'var(--red)'
    out.textContent = 'Error: ' + e.message
  })
}

function refreshBadge() {
  var name = S.selected; if (!name) return
  var d    = S.devices[name]
  var badge = document.getElementById('d-badge')
  if (d._s === 'online') {
    badge.className = 'badge badge-online'
    badge.innerHTML = '<span class="dot dot-green"></span> Online' + (d._lat ? ' \u00b7 ' + d._lat + 'ms' : '')
  } else if (d._s === 'offline') {
    badge.className = 'badge badge-offline'
    badge.innerHTML = '<span class="dot dot-red"></span> Offline'
  } else {
    badge.className = 'badge badge-checking'
    badge.innerHTML = '<span class="dot dot-yellow"></span> Checking...'
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === name)
  })
  document.getElementById('panel-details').classList.toggle('show', name === 'details')
  document.getElementById('panel-terminal').classList.toggle('show', name === 'terminal')
  document.getElementById('panel-tunnels').classList.toggle('show', name === 'tunnels')
  document.getElementById('panel-exec').classList.toggle('show', name === 'exec')
  document.getElementById('panel-files').classList.toggle('show', name === 'files')
  document.getElementById('panel-acl').classList.toggle('show', name === 'acl')
  document.getElementById('panel-audit').classList.toggle('show', name === 'audit')
  if (name === 'audit')   loadAudit()
  if (name === 'files')   loadFiles()
  if (name === 'tunnels') loadTunnelsUI()
  if (name === 'exec')    initExecTab()
  if (name === 'acl')     loadDeviceAclUI()
  if (name === 'terminal' && S.fit) setTimeout(function() { S.fit.fit() }, 40)
}

// ── Ping ─────────────────────────────────────────────────────────────────
function doPing() {
  var name = S.selected; if (!name) return
  var el   = document.getElementById('ping-result')
  el.style.color   = 'var(--muted)'
  el.textContent   = 'Pinging...'
  fetch('/api/ping/' + encodeURIComponent(name))
    .then(function(r) { return r.json() })
    .then(function(d) {
      if (d.online) {
        el.style.color = 'var(--green)'
        el.textContent = '\u2713 Reachable \u00b7 ' + d.latencyMs + 'ms round-trip'
      } else {
        el.style.color = 'var(--red)'
        el.textContent = '\u2717 Unreachable \u00b7 ' + (d.error || 'timeout')
      }
      pingBackground(name)
    })
}

// ── Terminal ─────────────────────────────────────────────────────────────
function openTerminal() {
  var name = S.selected; if (!name) return
  var user = document.getElementById('ssh-user').value.trim() || null
  var identity = document.getElementById('ssh-identity').value || null
  switchTab('terminal')
  startTerminal(name, user, identity)
}

function startTerminal(device, user, identity) {
  killTerminal()

  document.getElementById('no-term').style.display = 'none'
  var view = document.getElementById('term-view')
  view.style.display = 'flex'
  document.getElementById('term-title').textContent = (user ? user + '@' : '') + device

  var wrap = document.getElementById('term-wrap')
  wrap.innerHTML = ''

  var term = new Terminal({
    theme: {
      background: '#0d1117', foreground: '#e6edf3',
      cursor: '#58a6ff', selectionBackground: '#264f7860',
      black: '#484f58', brightBlack: '#6e7681'
    },
    fontFamily: '"Fira Code","Cascadia Code","SF Mono",Menlo,monospace',
    fontSize: 14, lineHeight: 1.45,
    cursorBlink: true, scrollback: 2000
  })
  var fitAddon = new FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(wrap)
  // Force a layout flush so fitAddon sees real pixel dimensions, not 0x0
  wrap.getBoundingClientRect()
  fitAddon.fit()
  console.log('[hole] terminal opened, initial size:', term.cols, 'x', term.rows)
  S.term = term; S.fit = fitAddon

  var wsUrl = 'ws://' + location.host + '/ws' + (S.token ? '?token=' + encodeURIComponent(S.token) : '')
  var ws = new WebSocket(wsUrl)
  S.ws = ws

  ws.onopen = function() {
    // Re-fit here too — WS connection is fast, browser may now have final layout
    fitAddon.fit()
    var cols = term.cols || 80
    var rows = term.rows || 24
    console.log('[hole] WS open — connecting device:', device, 'user:', user, 'identity:', identity, 'cols:', cols, 'rows:', rows)
    ws.send(JSON.stringify({ type: 'connect', device: device, user: user, identity: identity, cols: cols, rows: rows }))
  }

  ws.onmessage = function(e) {
    var msg
    try { msg = JSON.parse(e.data) } catch(err) {
      console.error('[hole] ws.onmessage parse error:', err, 'raw:', e.data && e.data.slice(0, 80))
      return
    }
    if (msg.type === 'output') {
      try {
        // Write raw bytes — lets xterm.js process the terminal byte stream natively
        term.write(b64ToU8(msg.data))
      } catch(err) {
        console.error('[hole] term.write error:', err, 'b64 snippet:', msg.data && msg.data.slice(0, 40))
      }
    } else if (msg.type === 'exit') {
      console.log('[hole] SSH exited, code:', msg.code)
      var bye = new TextEncoder().encode('\\r\\n\\x1b[90m--- session ended (exit ' + msg.code + ') ---\\x1b[0m\\r\\n')
      term.write(bye)
      S.ws = null
    } else if (msg.type === 'error') {
      console.error('[hole] server error:', msg.message)
      var errBytes = new TextEncoder().encode('\\r\\n\\x1b[31m[hole error] ' + msg.message + '\\x1b[0m\\r\\n')
      term.write(errBytes)
      S.ws = null
    }
  }

  ws.onclose = function(ev) {
    console.log('[hole] WS closed, code:', ev.code, 'reason:', ev.reason)
    if (S.ws) {
      var disc = new TextEncoder().encode('\\r\\n\\x1b[90m--- disconnected (ws ' + ev.code + ') ---\\x1b[0m\\r\\n')
      term.write(disc)
      S.ws = null
    }
  }

  ws.onerror = function(ev) {
    console.error('[hole] WS error:', ev)
  }

  // Input: encode as UTF-8 bytes → binary base64 so server decodes correctly
  term.onData(function(data) {
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ type: 'input', data: strToB64(data) }))
    }
  })

  var ro = new ResizeObserver(function() {
    fitAddon.fit()
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
  })
  ro.observe(wrap)
}

function killTerminal() {
  if (S.ws)   { S.ws.close();    S.ws   = null }
  if (S.term) { S.term.dispose(); S.term = null }
  S.fit = null
  document.getElementById('term-wrap').innerHTML = ''
  document.getElementById('term-view').style.display = 'none'
  document.getElementById('no-term').style.display   = 'flex'
}

// ── Tunnels ───────────────────────────────────────────────────────────────
function loadTunnelsUI() {
  var name = S.selected; if (!name) return
  // Populate service selector from device services
  var sel = document.getElementById('tun-service')
  if (sel) {
    var d = S.devices[name] || {}
    var svcs = Object.keys(d.services || {})
    var common = ['ssh', 'web', 'http', 'https', 'rdp', 'mysql', 'pg', 'redis']
    common.forEach(function(s) { if (svcs.indexOf(s) === -1) svcs.push(s) })
    if (!svcs.length) svcs = ['ssh', 'web', 'http']
    sel.innerHTML = svcs.map(function(s) {
      return '<option value="' + esc(s) + '">' + esc(s) + '</option>'
    }).join('')
  }
  // Wire up preset buttons — only services the device actually has get presets highlighted
  var d = S.devices[name] || {}
  document.querySelectorAll('#tun-presets [data-svc]').forEach(function(btn) {
    var svc  = btn.getAttribute('data-svc')
    var port = btn.getAttribute('data-port')
    // With SSH-forward fallback enabled, presets can work even if the service
    // key is not explicitly registered in local devices.json.
    btn.style.opacity = '1'
    btn.onclick = function() {
      var selEl  = document.getElementById('tun-service')
      var portEl = document.getElementById('tun-port')
      // If the service exists in the selector, select it; otherwise use the raw name
      if (selEl) {
        var opt = Array.from(selEl.options).find(function(o) { return o.value === svc })
        if (opt) selEl.value = svc
        else selEl.value = selEl.options[0] ? selEl.options[0].value : svc
      }
      if (portEl) portEl.value = port
    }
  })
  refreshTunnelList()
}

function refreshTunnelList() {
  var name = S.selected
  fetch('/api/tunnels')
    .then(function(r) { return r.json() })
    .then(function(body) {
      var el = document.getElementById('tunnels-list')
      if (!el) return
      var rows = (body.tunnels || []).filter(function(t) { return t.device === name })
      if (!rows.length) {
        el.innerHTML = '<div style="color:var(--muted)">No open tunnels for this device.</div>'
        return
      }
      var html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
        '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">Service</th>' +
        '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">Local port</th>' +
        '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">URL</th>' +
        '<th style="width:80px"></th>' +
        '</tr></thead><tbody>'
      rows.forEach(function(t) {
        var isHttp = t.service === 'web' || t.service === 'http' || t.service === 'https'
        var urlVal = isHttp
          ? '<a href="http://localhost:' + t.localPort + '" target="_blank" style="color:var(--accent)">http://localhost:' + t.localPort + '</a>'
          : 'localhost:' + t.localPort
        html += '<tr>' +
          '<td style="padding:5px 0">' + esc(t.service) + '</td>' +
          '<td style="padding:5px 0;font-family:monospace">' + t.localPort + '</td>' +
          '<td style="padding:5px 0">' + urlVal + '</td>' +
          '<td style="padding:5px 0;text-align:right">' +
            '<button class="btn btn-sm btn-danger" data-tun-stop="' + esc(t.id) + '">Stop</button>' +
          '</td>' +
          '</tr>'
      })
      html += '</tbody></table>'
      el.innerHTML = html
      el.querySelectorAll('[data-tun-stop]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var id = this.getAttribute('data-tun-stop')
          fetch('/api/tunnels/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(function() { refreshTunnelList() })
        })
      })
    })
}

document.addEventListener('DOMContentLoaded', function() {
  var openBtn = document.getElementById('btn-tun-open')
  if (openBtn) {
    openBtn.addEventListener('click', function() {
      var name    = S.selected; if (!name) return
      var service = (document.getElementById('tun-service').value || '').trim() || null
      var portVal = parseInt(document.getElementById('tun-port').value || '0', 10)
      var port    = isNaN(portVal) ? 0 : portVal
      var identity = (document.getElementById('tun-identity').value || '').trim() || null
      var res     = document.getElementById('tun-result')
      if (port > 0 && port < 1024) {
        res.style.color = 'var(--red)'
        res.textContent = 'Port ' + port + ' is privileged (<1024). Use >=1024 (e.g. 8080) or run dashboard as root.'
        return
      }
      res.style.color = 'var(--muted)'
      res.textContent = 'Opening tunnel...'
      openBtn.disabled = true
      fetch('/api/tunnels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: name, service: service, port: port, identity: identity })
      })
        .then(function(r) { return r.json() })
        .then(function(data) {
          openBtn.disabled = false
          if (data.error) {
            res.style.color = 'var(--red)'
            var msg = data.error
            if (msg.indexOf('Service "') === 0 && msg.indexOf('not found on device') !== -1) {
              msg += ' Add this service key to the device registry first (or run agent with --forward and register the printed service key).'
            }
            res.textContent = 'Error: ' + msg
            return
          }
          var t = data.tunnel
          res.style.color = 'var(--green)'
          var isHttp = t.service === 'web' || t.service === 'http'
          if (isHttp) {
            res.innerHTML = '&#10003; Tunnel open: <code>localhost:' + t.localPort + '</code>' +
              ' &nbsp;&mdash;&nbsp; <a href="http://localhost:' + t.localPort + '" target="_blank" style="color:var(--accent)">Open in browser</a>'
          } else if (t.service === 'ssh') {
            var user = (document.getElementById('ssh-user').value || 'root').trim() || 'root'
            var keyArg = identity ? (' -i ' + identity) : ''
            res.innerHTML = '&#10003; Tunnel open: <code>localhost:' + t.localPort + '</code>' +
              ' &nbsp;&mdash;&nbsp; <code>ssh' + keyArg + ' -p ' + t.localPort + ' ' + user + '@localhost</code>'
          } else {
            res.innerHTML = '&#10003; Tunnel open: <code>localhost:' + t.localPort + '</code>'
          }
          refreshTunnelList()
        })
        .catch(function(e) {
          openBtn.disabled = false
          res.style.color = 'var(--red)'
          res.textContent = 'Request failed: ' + e.message
        })
    })
  }
})

// ── Add Device Modal ─────────────────────────────────────────────────────
function openAddDeviceModal() {
  var overlay = document.getElementById('modal-overlay')
  overlay.style.display = 'flex'
  document.getElementById('add-dev-name').value = ''
  document.getElementById('add-dev-key').value  = ''
  document.getElementById('add-dev-user').value = ''
  document.getElementById('add-dev-tags').value = ''
  document.getElementById('add-dev-err').textContent = ''
  setTimeout(function() { document.getElementById('add-dev-name').focus() }, 50)
}

function closeAddDeviceModal() {
  document.getElementById('modal-overlay').style.display = 'none'
}

function submitAddDevice() {
  var name = document.getElementById('add-dev-name').value.trim()
  var key  = document.getElementById('add-dev-key').value.trim()
  var user = document.getElementById('add-dev-user').value.trim()
  var tags = document.getElementById('add-dev-tags').value.trim()
  var errEl = document.getElementById('add-dev-err')

  if (!name) { errEl.textContent = 'Name is required.'; return }
  if (!/^[0-9a-f]{64}$/i.test(key)) { errEl.textContent = 'Key must be a 64-character hex string.'; return }

  errEl.textContent = ''
  document.getElementById('btn-modal-confirm').disabled = true
  fetch('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name,
      key: key,
      user: user || undefined,
      tags: tags ? tags.split(',').map(function(t) { return t.trim() }).filter(Boolean) : []
    })
  })
    .then(function(r) { return r.json() })
    .then(function(data) {
      document.getElementById('btn-modal-confirm').disabled = false
      if (data.error) { errEl.textContent = data.error; return }
      closeAddDeviceModal()
      loadFleet()
    })
    .catch(function(e) {
      document.getElementById('btn-modal-confirm').disabled = false
      errEl.textContent = 'Error: ' + e.message
    })
}

document.getElementById('btn-add-device').addEventListener('click', openAddDeviceModal)
document.getElementById('btn-modal-cancel').addEventListener('click', closeAddDeviceModal)
document.getElementById('btn-modal-confirm').addEventListener('click', submitAddDevice)
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeAddDeviceModal()
})
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeAddDeviceModal()
  if (e.key === 'Enter' && document.getElementById('modal-overlay').style.display === 'flex') submitAddDevice()
})

// ── Exec tab ──────────────────────────────────────────────────────────────
function initExecTab() {
  // Populate tag filter in exec scope selector
  var tagSel = document.getElementById('exec-tag-filter')
  if (!tagSel) return
  var devs = Object.values(S.devices)
  var tags = new Set()
  devs.forEach(function(d) { (d.tags || []).forEach(function(t) { tags.add(String(t)) }) })
  var all = Array.from(tags).sort()
  tagSel.innerHTML = '<option value="">All tags</option>'
  all.forEach(function(t) {
    tagSel.innerHTML += '<option value="' + esc(t) + '">' + esc(t) + '</option>'
  })
}

document.getElementById('btn-exec-run').addEventListener('click', function() {
  var cmd    = document.getElementById('exec-cmd').value.trim()
  var scope  = document.getElementById('exec-scope').value
  var tag    = document.getElementById('exec-tag-filter').value

  if (!cmd) { alert('Enter a command to run.'); return }

  var targets = []
  if (scope === 'selected' && S.selected) {
    targets = [S.selected]
  } else {
    targets = Object.values(S.devices)
      .filter(function(d) { return !tag || (d.tags || []).indexOf(tag) !== -1 })
      .map(function(d) { return d.name })
  }
  if (!targets.length) { alert('No matching devices.'); return }

  var outEl = document.getElementById('exec-output')
  var card  = document.getElementById('exec-results')
  card.style.display = ''
  outEl.innerHTML = '<span style="color:var(--muted)">Running on ' + targets.length + ' device(s)...</span>\n'
  document.getElementById('btn-exec-run').disabled = true

  fetch('/api/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd: cmd, devices: targets })
  })
    .then(function(r) { return r.json() })
    .then(function(data) {
      document.getElementById('btn-exec-run').disabled = false
      if (data.error) { outEl.innerHTML += '<span style="color:var(--red)">Error: ' + esc(data.error) + '</span>\n'; return }
      var html = ''
      ;(data.results || []).forEach(function(r) {
        var col = r.ok ? 'var(--green)' : 'var(--red)'
        html += '<div style="margin-bottom:14px">'
        html += '<div style="color:' + col + ';font-weight:600;margin-bottom:4px">'
        html += esc(r.name)
        if (r.ok) html += ' <span style="color:var(--muted);font-weight:400">(' + r.durationMs + 'ms)</span>'
        html += '</div>'
        if (r.ok) {
          html += '<pre style="margin:0;padding:8px;background:var(--bg);border-radius:6px;overflow-x:auto;white-space:pre-wrap">' + esc(r.output) + '</pre>'
        } else {
          html += '<div style="color:var(--red);padding:4px 0">' + esc(r.error) + '</div>'
        }
        html += '</div>'
      })
      outEl.innerHTML = html
    })
    .catch(function(e) {
      document.getElementById('btn-exec-run').disabled = false
      outEl.innerHTML += '<span style="color:var(--red)">Request failed: ' + esc(e.message) + '</span>\n'
    })
})

document.getElementById('btn-exec-clear').addEventListener('click', function() {
  document.getElementById('exec-output').innerHTML = ''
  document.getElementById('exec-results').style.display = 'none'
})

// ── Audit ─────────────────────────────────────────────────────────────────
function loadAudit() {
  var el = document.getElementById('audit-content')
  el.innerHTML = '<div style="color:var(--muted)">Loading...</div>'
  fetch('/api/audit?tail=100').then(function(r) { return r.json() }).then(function(body) {
    var rows = body.entries.slice().reverse()
    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--muted)">No audit entries yet.</div>'; return
    }
    var html = '<div class="audit-wrap"><table><thead><tr>' +
      '<th>Time</th><th>Event</th><th>Device / Target</th><th>Service</th><th>Client Key</th><th>Duration</th>' +
      '</tr></thead><tbody>'
    rows.forEach(function(r) {
      var evCls = r.event === 'CONNECT' ? 'ev-connect' : r.event && r.event.indexOf('CLIENT') === 0 ? 'ev-client' : 'ev-close'
      var dur   = r.durationMs != null ? (r.durationMs / 1000).toFixed(1) + 's' : ''
      var ckey  = r.clientKey ? r.clientKey.slice(0,12) + '...' : ''
      html += '<tr>' +
        '<td>' + esc((r.ts||'').slice(0,19).replace('T',' ')) + '</td>' +
        '<td class="' + evCls + '">' + esc(r.event||'') + '</td>' +
        '<td>' + esc(r.device||r.target||'') + '</td>' +
        '<td>' + esc(r.service||'') + '</td>' +
        '<td style="font-family:monospace;cursor:pointer" class="copy" data-full="' + esc(r.clientKey||'') + '" title="Click to copy full key">' + esc(ckey) + '</td>' +
        '<td>' + esc(dur) + '</td>' +
        '</tr>'
    })
    el.innerHTML = html + '</tbody></table></div>'
  })
}

// ── Files ─────────────────────────────────────────────────────────────────
var currentPath = '/'

function loadFiles(path) {
  var name = S.selected; if (!name) return
  if (path != null) currentPath = path
  var el = document.getElementById('files-content')
  var pathEl = document.getElementById('files-path')
  pathEl.textContent = currentPath
  el.innerHTML = '<div style="padding:20px;color:var(--muted)">Loading files...</div>'

  fetch('/api/files/' + encodeURIComponent(name) + '?path=' + encodeURIComponent(currentPath))
    .then(function(r) { return r.json() })
    .then(function(data) {
      if (data.error) {
        el.innerHTML = '<div style="padding:20px;color:var(--red)">' + esc(data.error) + '</div>'
        return
      }
      var html = '<table style="width:100%"><thead><tr><th>Name</th><th style="width:100px">Type</th><th style="width:140px;text-align:right">Actions</th></tr></thead><tbody>'
      data.files.forEach(function(f) {
        var icon = f.isDir ? '📁' : '📄'
        var style = f.isDir ? 'font-weight:600;cursor:pointer;color:var(--accent)' : ''
        var rowAttr = f.isDir ? 'data-navigate="' + esc(f.name) + '"' : ''
        
        html += '<tr style="' + (f.isDir ? 'cursor:pointer' : '') + '">' +
          '<td ' + rowAttr + ' style="' + style + '">' + icon + ' ' + esc(f.name) + '</td>' +
          '<td style="color:var(--muted)">' + (f.isDir ? 'Directory' : 'File') + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' +
            (f.isDir ? '' : '<button class="btn btn-sm" title="Download" data-dl="' + esc(f.name) + '">&#10515;</button> ') +
            '<button class="btn btn-sm" title="Rename" data-ren="' + esc(f.name) + '">&#9998;</button> ' +
            '<button class="btn btn-sm btn-danger" title="Delete" data-del="' + esc(f.name) + '">&#10005;</button>' +
          '</td>' +
          '</tr>'
      })
      el.innerHTML = html + '</tbody></table>'
      
      el.querySelectorAll('[data-navigate]').forEach(function(node) {
        node.addEventListener('click', function() { navigateFiles(this.getAttribute('data-navigate')) })
      })
      el.querySelectorAll('[data-dl]').forEach(function(node) {
        node.addEventListener('click', function() { downloadFile(this.getAttribute('data-dl')) })
      })
      el.querySelectorAll('[data-ren]').forEach(function(node) {
        node.addEventListener('click', function() { renameFile(this.getAttribute('data-ren')) })
      })
      el.querySelectorAll('[data-del]').forEach(function(node) {
        node.addEventListener('click', function() { deleteFile(this.getAttribute('data-del')) })
      })
    })
    .catch(function(e) {
      el.innerHTML = '<div style="padding:20px;color:var(--red)">' + esc(e.message) + '</div>'
    })
}

function navigateFiles(sub) {
  var p = currentPath
  if (!p.endsWith('/')) p += '/'
  loadFiles(p + sub)
}

function downloadFile(name) {
  var dev = S.selected; if (!dev) return
  var path = currentPath; if (!path.endsWith('/')) path += '/'
  window.open('/api/files/' + encodeURIComponent(dev) + '/download?path=' + encodeURIComponent(path + name))
}

function renameFile(old) {
  var dev = S.selected; if (!dev) return
  var path = currentPath; if (!path.endsWith('/')) path += '/'
  var neu = prompt('Rename "' + old + '" to:', old)
  if (!neu || neu === old) return
  fetch('/api/files/' + encodeURIComponent(dev) + '/rename?path=' + encodeURIComponent(path + old) + '&to=' + encodeURIComponent(path + neu), { method: 'POST' })
    .then(function(r) { return r.json() })
    .then(function(res) {
      if (res.error) alert(res.error)
      loadFiles()
    })
}

function deleteFile(name) {
  var dev = S.selected; if (!dev) return
  var path = currentPath; if (!path.endsWith('/')) path += '/'
  if (!confirm('Are you sure you want to delete "' + name + '"?')) return
  fetch('/api/files/' + encodeURIComponent(dev) + '?path=' + encodeURIComponent(path + name), { method: 'DELETE' })
    .then(function(r) { return r.json() })
    .then(function(res) {
      if (res.error) alert(res.error)
      loadFiles()
    })
}

document.getElementById('btn-files-mkdir').addEventListener('click', function() {
  var dev = S.selected; if (!dev) return
  var name = prompt('New folder name:')
  if (!name) return
  var path = currentPath; if (!path.endsWith('/')) path += '/'
  fetch('/api/files/' + encodeURIComponent(dev) + '/mkdir?path=' + encodeURIComponent(path + name), { method: 'POST' })
    .then(function(r) { return r.json() })
    .then(function(res) {
      if (res.error) alert(res.error)
      loadFiles()
    })
})

document.getElementById('btn-files-upload').addEventListener('click', function() {
  document.getElementById('files-upload-input').click()
})

document.getElementById('files-upload-input').addEventListener('change', function(e) {
  var file = e.target.files[0]
  if (!file) return
  var dev = S.selected; if (!dev) return
  var path = currentPath; if (!path.endsWith('/')) path += '/'
  
  var el = document.getElementById('files-content')
  var prev = el.innerHTML
  el.innerHTML = '<div style="padding:20px;color:var(--accent)">Uploading ' + esc(file.name) + '...</div>'

  fetch('/api/files/' + encodeURIComponent(dev) + '/upload?path=' + encodeURIComponent(path + file.name), {
    method: 'POST',
    body: file
  })
    .then(function(r) { return r.json() })
    .then(function(res) {
      if (res.error) alert(res.error)
      loadFiles()
    })
    .catch(function(err) {
      alert('Upload failed: ' + err.message)
      loadFiles()
    })
})

document.getElementById('btn-files-back').addEventListener('click', function() {
  if (currentPath === '/' || currentPath === '') return
  var parts = currentPath.split('/').filter(Boolean)
  parts.pop()
  loadFiles('/' + parts.join('/'))
})

document.getElementById('btn-files-refresh').addEventListener('click', function() {
  loadFiles()
})

function exportAudit() {
  fetch('/api/audit?tail=1000').then(function(r) { return r.json() }).then(function(body) {
    var rows = body.entries
    if (!rows.length) return alert('No data to export')
    var csv = 'Time,Event,Device/Target,Service,Client Key,Duration(s)\\n'
    rows.forEach(function(r) {
      csv += [
        (r.ts||'').replace('T',' ').slice(0,19),
        r.event||'',
        r.device||r.target||'',
        r.service||'',
        r.clientKey||'',
        r.durationMs != null ? (r.durationMs/1000).toFixed(1) : ''
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"' }).join(',') + '\\n'
    })
    var blob = new Blob([csv], { type: 'text/csv' })
    var url  = URL.createObjectURL(blob)
    var a    = document.createElement('a')
    a.href = url; a.download = 'hole-audit-' + new Date().toISOString().slice(0,10) + '.csv'
    a.click()
    URL.revokeObjectURL(url)
  })
}

// ── Per-device ACL UI ──────────────────────────────────────────────────────
function loadDeviceAclUI() {
  var body = document.getElementById('device-acl-body')
  var device = S.selected
  if (!body || !device) return

  // Show offline warning but still try to connect
  var dev = S.devices[device] || {}
  if (dev._s === 'offline') {
    body.innerHTML = '<div style="color:var(--yellow);margin-bottom:8px">&#9888; Device appears offline. ACL load may time out.</div>'
  } else {
    body.textContent = 'Loading...'
  }

  fetch('/api/device-acl/' + encodeURIComponent(device))
    .then(function(r) { return r.json() })
    .then(function(data) {
      if (data.error) {
        var isOffline = data.error.toLowerCase().indexOf('time') !== -1 || data.error.toLowerCase().indexOf('connect') !== -1
        body.innerHTML = '<div style="color:var(--red)">Error: ' + esc(data.error) + '</div>' +
          (isOffline ? '<div style="color:var(--muted);font-size:11px;margin-top:6px">Device may be offline or unreachable via SSH.</div>' : '')
        return
      }
      renderDeviceAcl(data.acl || {})
    })
    .catch(function(e) {
      body.innerHTML = '<span style="color:var(--red)">Failed to load ACL: ' + esc(e.message) + '</span>'
    })
}

function renderDeviceAcl(acl) {
  var body = document.getElementById('device-acl-body')
  if (!body) return
  var names = Object.keys(acl)
  if (!names.length) {
    body.innerHTML = '<div style="color:var(--muted)">Open mode: any client key may connect.</div>'
    return
  }
  var html = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>' +
    '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">Name</th>' +
    '<th style="text-align:left;padding:4px 0;color:var(--muted);font-weight:500">Client key</th>' +
    '<th style="width:70px"></th>' +
    '</tr></thead><tbody>'
  names.sort().forEach(function(name) {
    var key = acl[name] || ''
    var short = key ? esc(key.slice(0, 16) + '...') : ''
    html += '<tr>' +
      '<td style="padding:4px 0">' + esc(name) + '</td>' +
      '<td style="padding:4px 0;font-family:monospace;cursor:pointer" class="copy" data-full="' + esc(key) + '" title="Click to copy full key">' + short + '</td>' +
      '<td style="padding:4px 0;text-align:right">' +
        '<button class="btn btn-sm btn-danger" data-device-acl-remove="' + esc(name) + '">Remove</button>' +
      '</td>' +
      '</tr>'
  })
  html += '</tbody></table>'
  body.innerHTML = html
  body.querySelectorAll('[data-device-acl-remove]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var entry = this.getAttribute('data-device-acl-remove')
      removeDeviceAclEntry(entry)
    })
  })
}

function addDeviceAclEntry() {
  var device = S.selected
  if (!device) return
  var nameEl = document.getElementById('device-acl-name')
  var keyEl  = document.getElementById('device-acl-key')
  var name   = (nameEl.value || '').trim()
  var key    = (keyEl.value  || '').trim()
  if (!name || !key) { alert('Both name and key are required.'); return }
  fetch('/api/device-acl/' + encodeURIComponent(device), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, key: key })
  })
    .then(function(r) { return r.json() })
    .then(function(res) {
      if (res.error) { alert(res.error); return }
      nameEl.value = ''
      keyEl.value  = ''
      renderDeviceAcl(res.acl || {})
    })
}

function removeDeviceAclEntry(entry) {
  var device = S.selected
  if (!device || !entry) return
  if (!confirm('Remove ACL entry "' + entry + '" from ' + device + '?')) return
  fetch('/api/device-acl/' + encodeURIComponent(device) + '?name=' + encodeURIComponent(entry), {
    method: 'DELETE'
  })
    .then(function(r) { return r.json() })
    .then(function(res) {
      if (res.error) { alert(res.error); return }
      renderDeviceAcl(res.acl || {})
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function ago(iso) {
  var d = Date.now() - new Date(iso).getTime()
  if (d < 60000)   return Math.floor(d/1000)   + 's ago'
  if (d < 3600000) return Math.floor(d/60000)  + 'm ago'
  if (d < 86400000)return Math.floor(d/3600000)+ 'h ago'
  return Math.floor(d/86400000) + 'd ago'
}
// Decode server base64 output → raw Uint8Array so xterm.js handles bytes directly
function b64ToU8(s) {
  var bin = window.atob(s)
  var bytes = new Uint8Array(bin.length)
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
// Encode xterm user input (UTF-8 string) → binary base64 for the server
function strToB64(s) {
  var bytes = new TextEncoder().encode(s)
  var bin = ''
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return window.btoa(bin)
}
</script>
</body>
</html>`
}
