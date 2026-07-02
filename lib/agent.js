import DHT    from 'hyperdht'
import net    from 'net'
import dns    from 'dns'
import os     from 'os'
import { log, warn, die, hostname, isPrivateAddress } from './utils.js'
import { addDevice, touchDevice } from './registry.js'
import { loadOrCreateKeyPair, deriveServiceKeyPair } from './identity.js'
import { loadAcl, aclCheck } from './acl.js'
import { auditConnect, auditClose } from './audit.js'

// ---------------------------------------------------------------------------
// Pre-flight: verify target port is reachable before announcing on DHT
// ---------------------------------------------------------------------------
function checkTarget (host, port) {
  return new Promise(resolve => {
    const probe = net.connect(port, host)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error',   () => { probe.destroy(); resolve(false) })
    probe.setTimeout(3000, () => { probe.destroy(); resolve(false) })
  })
}

// ---------------------------------------------------------------------------
// Resolve a proxy CONNECT target and refuse private/loopback/link-local
// addresses unless the operator opted in — stops the exit node from being
// used to pivot into its own LAN.
// ---------------------------------------------------------------------------
async function resolveAndGuard (host, allowLan) {
  const ip = net.isIP(host) ? host : (await dns.promises.lookup(host)).address
  if (!allowLan && isPrivateAddress(ip)) {
    throw new Error(`Refusing to connect to private address ${ip} (use --proxy-allow-lan to override)`)
  }
  return ip
}


// ---------------------------------------------------------------------------
// run({ name, relay, forwards, sshHost, sshPort })
//
//   forwards — array of { name, host, port }   e.g. [{ name:'rdp', host:'127.0.0.1', port:3389 }]
//   sshHost/sshPort — the default SSH forward (always present unless overridden)
// ---------------------------------------------------------------------------
export async function run ({ name, relay, forwards = [], sshHost = '127.0.0.1', sshPort = 22, proxy = false, proxyAllowLan = false }) {
  const masterKeyPair = loadOrCreateKeyPair()
  const acl = loadAcl()

  // The SSH forward always uses the master keypair so existing clients keep working.
  // Additional forwards each get a derived keypair. The proxy service (if enabled)
  // has no fixed target — it dials wherever each CONNECT request asks for.
  const allForwards = [
    { name: 'ssh', host: sshHost, port: sshPort, keyPair: masterKeyPair },
    ...forwards.map(f => ({
      ...f,
      keyPair: deriveServiceKeyPair(masterKeyPair.secretKey, f.name)
    })),
    ...(proxy ? [{ name: 'proxy', dynamic: true, keyPair: deriveServiceKeyPair(masterKeyPair.secretKey, 'proxy') }] : [])
  ]

  // Print header
  console.log('\n=== Hole up ===')
  if (name)  console.log(`Name   : ${name}`)
  if (relay) console.log(`Relay  : ${relay}`)
  const aclKeys = Object.keys(acl)
  console.log(`ACL    : ${aclKeys.length ? `${aclKeys.length} allowed client(s)` : 'open (all clients allowed)'}`)
  console.log('')
  console.log('Services:')
  for (const f of allForwards) {
    console.log(`  ${f.name.padEnd(12)} → ${f.dynamic ? '(dynamic outbound proxy)' : `${f.host}:${f.port}`}`)
    console.log(`  ${'key:'.padEnd(12)}   ${f.keyPair.publicKey.toString('hex')}`)
  }
  console.log('')

  if (proxy && !aclKeys.length) {
    warn('proxy is enabled with an open ACL — anyone with the proxy key can browse the internet through this machine.')
    warn('Consider `hole acl add <name> <key>` to restrict who can use it.')
  }

  // Register in registry
  if (name) {
    const serviceKeys = {}
    for (const f of allForwards) {
      serviceKeys[f.name] = f.keyPair.publicKey.toString('hex')
    }
    addDevice(name, masterKeyPair.publicKey.toString('hex'), {
      host:     hostname(),
      services: serviceKeys
    })
  }

  // Pre-flight: skip services that aren't reachable instead of aborting everything.
  // Only dies if no service at all is reachable.
  const aliveForwards = []
  for (const f of allForwards) {
    if (f.dynamic) { aliveForwards.push(f); continue }
    const ok = await checkTarget(f.host, f.port)
    if (!ok) {
      warn(`Cannot reach ${f.host}:${f.port} for service "${f.name}" — skipping`)
    } else {
      aliveForwards.push(f)
    }
  }
  if (!aliveForwards.length) die('No services are reachable. Nothing to announce.')

  // Start DHT
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()
  log('DHT bootstrapped')

  // HyperDHT recovers on its own: it re-announces every listening server on a
  // network change, and dht-rpc detects sleep/wake (a large tick gap) and forces
  // a refresh. We don't rebuild anything here — just surface it so an operator
  // watching an always-on agent can see reconnection happen after a laptop wakes
  // or the network switches (WiFi ↔ cellular).
  dht.on('network-change', () => log('Network changed — re-announcing services on the DHT'))
  dht.on('wakeup',         () => log('Woke from sleep — refreshing DHT presence'))

  // Set stopping = true on shutdown so the close handler does not trigger restarts.
  let stopping = false

  // Dynamic proxy connections carry no fixed target: the client sends a
  // newline-terminated JSON header {"host":..,"port":..} before any raw
  // bytes, we dial that target ourselves, then splice the two sockets.
  function handleProxyConnection (conn, tag, connectedAt, clientKey) {
    let buf = Buffer.alloc(0)
    let target = null
    let connectTimer = null
    let done = false

    const finish = (label, e) => {
      if (done) return
      done = true
      if (connectTimer) clearTimeout(connectTimer)
      // "connection reset by peer" / *-close are normal when the client just
      // finished reading a response and hung up — not worth a warning.
      const isNormal = !e?.message ||
        e.message.includes('connection reset by peer') ||
        e.message.includes('ECONNRESET') ||
        label === 'dht-close' ||
        label === 'target-close'
      if (e?.message && !isNormal) warn(`[proxy] ${tag} ${label}: ${e.message}`)
      auditClose({ service: 'proxy', clientKey, durationMs: Date.now() - connectedAt })
      log(`[proxy] [-] ${tag} closed`)
      conn.destroy()
      target?.destroy()
    }

    // Attach unconditionally, before any async work — a client that gets a
    // rejected CONNECT (guard, timeout, unreachable) and resets its side
    // must not turn into an unhandled 'error' event that crashes the process.
    conn.on('error', (e) => finish('dht-error', e))
    conn.on('close', () => finish('dht-close'))

    const onHeader = async (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length > 4096) { conn.destroy(); return }
      const nl = buf.indexOf(10)
      if (nl === -1) return
      conn.removeListener('data', onHeader)

      let req
      try {
        req = JSON.parse(buf.slice(0, nl).toString())
      } catch {
        conn.destroy()
        return
      }
      const extra = buf.slice(nl + 1)

      let ip
      try {
        ip = await resolveAndGuard(req.host, proxyAllowLan)
      } catch (e) {
        try { conn.write(JSON.stringify({ ok: false, error: e.message }) + '\n') } catch {}
        conn.end()
        return
      }

      let connected = false
      target = net.connect(req.port, ip)

      connectTimer = setTimeout(() => {
        if (!connected) {
          try { conn.write(JSON.stringify({ ok: false, error: 'connection timed out' }) + '\n') } catch {}
          conn.end()
          target.destroy()
        }
      }, 10000)

      target.once('connect', () => {
        connected = true
        clearTimeout(connectTimer)
        conn.write(JSON.stringify({ ok: true }) + '\n')
        if (extra.length) target.write(extra)
        conn.pipe(target)
        target.pipe(conn)
      })

      target.once('error', (e) => {
        clearTimeout(connectTimer)
        if (!connected) {
          try { conn.write(JSON.stringify({ ok: false, error: e.message }) + '\n') } catch {}
          conn.end()
        }
        finish('target-error', e)
      })
      target.once('close', () => finish('target-close'))
    }

    conn.on('data', onHeader)
  }

  async function startForward (f) {
    const server = dht.createServer(async conn => {
      if (!aclCheck(acl, conn.remotePublicKey)) {
        const who = conn.remotePublicKey?.toString('hex').slice(0, 8) ?? '?'
        warn(`[${f.name}] Rejected ${who} — not in ACL`)
        conn.destroy()
        return
      }

      const clientKey   = conn.remotePublicKey?.toString('hex') ?? '?'
      const tag         = clientKey.slice(0, 8)
      const connectedAt = Date.now()
      log(`[${f.name}] [+] ${tag}`)
      auditConnect({ service: f.name, clientKey })

      if (f.dynamic) {
        handleProxyConnection(conn, tag, connectedAt, clientKey)
        return
      }

      const target = net.connect(f.port, f.host)
      conn.pipe(target)
      target.pipe(conn)

      let done = false
      const cleanup = (side) => (e) => {
        if (done) return
        done = true
        if (e?.message) warn(`[${f.name}] ${tag} ${side}: ${e.message}`)
        auditClose({ service: f.name, clientKey, durationMs: Date.now() - connectedAt })
        log(`[${f.name}] [-] ${tag} closed`)
        conn.destroy()
        target.destroy()
      }

      conn.on('error',   cleanup('dht-error'))
      conn.on('close',   cleanup('dht-close'))
      target.on('error', cleanup('target-error'))
      target.on('close', cleanup('target-close'))
    })

    await server.listen(f.keyPair)
    log(f.dynamic ? `Listening [${f.name}] → (dynamic outbound)` : `Listening [${f.name}] → ${f.host}:${f.port}`)

    server.once('close', () => {
      if (!stopping) {
        warn(`[${f.name}] server closed unexpectedly — restarting in 3s`)
        setTimeout(() => {
          startForward(f).catch(e => warn(`[${f.name}] restart failed: ${e.message}`))
        }, 3000)
      }
    })
  }

  for (const f of aliveForwards) {
    await startForward(f)
  }

  log('Waiting for connections...\n')

  if (name) {
    const getMetrics = () => ({
      cpu: Math.round(os.loadavg()[0] * 100) / 100,
      mem: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      uptime: Math.round(os.uptime())
    })
    setInterval(() => touchDevice(name, { metrics: getMetrics() }), 60_000)
  }

  process.on('SIGINT', async () => {
    stopping = true
    log('Shutting down...')
    await dht.destroy()
    process.exit(0)
  })
}
