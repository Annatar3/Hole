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
 * GET  /api/acl    → ACL list
 * WS   /ws         → SSH terminal session
 */
import http   from 'http'
import { WebSocketServer } from 'ws'
import { createRequire } from 'module'
import { spawn }  from 'child_process'
import DHT        from 'hyperdht'
import { loadRegistry } from './registry.js'
import { loadAcl }  from './acl.js'
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

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------
async function handleRequest (req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  // ── Root → serve dashboard UI ──────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(buildUI())
    return
  }

  // ── GET /api/devices ────────────────────────────────────────────────────
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    const reg = loadRegistry()
    const devices = Object.entries(reg).map(([name, d]) => ({ name, ...d }))
    json({ devices })
    return
  }

  // ── GET /api/ping/:name ─────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/ping/') && req.method === 'GET') {
    const name   = decodeURIComponent(url.pathname.slice('/api/ping/'.length))
    const result = await pingDevice(name)
    json(result)
    return
  }

  // ── GET /api/audit ──────────────────────────────────────────────────────
  if (url.pathname === '/api/audit' && req.method === 'GET') {
    const tail    = parseInt(url.searchParams.get('tail') ?? '100', 10)
    const entries = loadAuditEntries(tail)
    json({ entries })
    return
  }

  // ── GET /api/acl ────────────────────────────────────────────────────────
  if (url.pathname === '/api/acl' && req.method === 'GET') {
    json({ acl: loadAcl() })
    return
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
      const { device, user, cols = 80, rows = 24 } = msg

      if (!pty) {
        send({ type: 'error', message: 'node-pty is not available. Run: npm install node-pty' })
        return
      }

      send({ type: 'output', data: btoa('\x1b[90m[hole] Connecting to ' + device + '...\x1b[0m\r\n') })

      const reg = loadRegistry()
      const dev = reg[device] ?? null
      const relay    = dev?.relay ?? null
      const identity = dev?.identity ?? null

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
  const server = http.createServer(handleRequest)
  const wss    = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://h')
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, ws => handleTerminalWS(ws))
    } else {
      socket.destroy()
    }
  })

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve)
    server.once('error', reject)
  })

  const url = `http://localhost:${port}`
  console.log('\n=== Hole Dashboard ===')
  console.log(`URL    : ${url}`)
  console.log(`Devices: ${Object.keys(loadRegistry()).length} registered`)
  if (!pty) console.log('\n[!] node-pty not found — web terminal disabled (run: npm install node-pty)')
  console.log('\nPress Ctrl+C to stop.\n')

  // Auto-open browser
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref()

  process.on('SIGINT', async () => {
    log('Shutting down dashboard...')
    server.close()
    if (_dht) await _dht.destroy().catch(() => {})
    process.exit(0)
  })
}

// ---------------------------------------------------------------------------
// buildUI — returns the full dashboard HTML as a string
// ---------------------------------------------------------------------------
function buildUI () {
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
    <div class="device-list" id="fleet-list">
      <div style="padding:10px 6px;color:var(--muted)">Loading...</div>
    </div>
    <div class="sidebar-foot" id="fleet-foot"></div>
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
            <div class="kv-label">Tags</div>
            <div class="kv-value"><div class="tags" id="d-tags"></div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">SSH Connection</div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <label style="color:var(--muted)">User</label>
            <input type="text" id="ssh-user" placeholder="root" style="width:110px">
            <button class="btn btn-primary" id="btn-connect">&#9654; Open Terminal</button>
            <button class="btn" id="btn-ping">&#8635; Ping</button>
          </div>
          <div id="ping-result"></div>
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

      <!-- Audit panel -->
      <div class="panel" id="panel-audit">
        <div id="audit-content" style="color:var(--muted)">Loading...</div>
      </div>

    </div><!-- /device-panel -->
  </main>
</div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
// ── State ────────────────────────────────────────────────────────────────
var S = { devices: {}, selected: null, ws: null, term: null, fit: null }

// ── Boot ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function(t) {
  t.addEventListener('click', function() { switchTab(t.dataset.tab) })
})
document.getElementById('btn-connect').addEventListener('click', openTerminal)
document.getElementById('btn-connect2').addEventListener('click', openTerminal)
document.getElementById('btn-disconnect').addEventListener('click', killTerminal)
document.getElementById('btn-ping').addEventListener('click', doPing)
document.getElementById('d-key').addEventListener('click', function() {
  var full = this.dataset.full
  if (!full) return
  navigator.clipboard.writeText(full).then(function() {
    var el = document.getElementById('d-key')
    var prev = el.textContent
    el.textContent = 'Copied!'
    setTimeout(function() { el.textContent = prev }, 1500)
  })
})

loadFleet()
setInterval(loadFleet, 30000)

// ── Fleet ─────────────────────────────────────────────────────────────────
function loadFleet() {
  fetch('/api/devices').then(function(r) { return r.json() }).then(function(body) {
    S.devices = {}
    body.devices.forEach(function(d) { S.devices[d.name] = d })
    renderFleet()
    updateHeader()
    body.devices.forEach(function(d) { pingBackground(d.name) })
  })
}

function renderFleet() {
  var el    = document.getElementById('fleet-list')
  var names = Object.keys(S.devices)
  if (!names.length) {
    el.innerHTML = '<div style="padding:10px 6px;color:var(--muted);line-height:1.6">No devices registered.<br>Run: <code>hole add &lt;name&gt; &lt;key&gt;</code></div>'
    return
  }
  el.innerHTML = names.map(function(n) {
    var d = S.devices[n]
    var dot = d._s === 'online' ? 'dot-green' : d._s === 'offline' ? 'dot-red' : 'dot-yellow'
    var active = S.selected === n ? ' active' : ''
    var meta = d._lat ? (d._lat + 'ms') : (d.lastSeen ? ago(d.lastSeen) : 'never')
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

  var tags = d.tags || []
  document.getElementById('d-tags').innerHTML = tags.length
    ? tags.map(function(t) { return '<span class="tag">' + esc(t) + '</span>' }).join('')
    : '<span style="color:var(--muted)">none</span>'

  if (d.user) document.getElementById('ssh-user').value = d.user
  document.getElementById('ping-result').textContent = ''

  refreshBadge()
  switchTab('details')
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
  document.getElementById('panel-audit').classList.toggle('show', name === 'audit')
  if (name === 'audit')    loadAudit()
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
  switchTab('terminal')
  startTerminal(name, user)
}

function startTerminal(device, user) {
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

  var ws = new WebSocket('ws://' + location.host + '/ws')
  S.ws = ws

  ws.onopen = function() {
    // Re-fit here too — WS connection is fast, browser may now have final layout
    fitAddon.fit()
    var cols = term.cols || 80
    var rows = term.rows || 24
    console.log('[hole] WS open — connecting device:', device, 'user:', user, 'cols:', cols, 'rows:', rows)
    ws.send(JSON.stringify({ type: 'connect', device: device, user: user, cols: cols, rows: rows }))
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
        '<td style="font-family:monospace">' + esc(ckey) + '</td>' +
        '<td>' + esc(dur) + '</td>' +
        '</tr>'
    })
    el.innerHTML = html + '</tbody></table></div>'
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
