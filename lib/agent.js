import DHT    from 'hyperdht'
import net    from 'net'
import os     from 'os'
import { log, warn, die, hostname } from './utils.js'
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
// run({ name, relay, forwards, sshHost, sshPort })
//
//   forwards — array of { name, host, port }   e.g. [{ name:'rdp', host:'127.0.0.1', port:3389 }]
//   sshHost/sshPort — the default SSH forward (always present unless overridden)
// ---------------------------------------------------------------------------
export async function run ({ name, relay, forwards = [], sshHost = '127.0.0.1', sshPort = 22 }) {
  const masterKeyPair = loadOrCreateKeyPair()
  const acl = loadAcl()

  // The SSH forward always uses the master keypair so existing clients keep working.
  // Additional forwards each get a derived keypair.
  const allForwards = [
    { name: 'ssh', host: sshHost, port: sshPort, keyPair: masterKeyPair },
    ...forwards.map(f => ({
      ...f,
      keyPair: deriveServiceKeyPair(masterKeyPair.secretKey, f.name)
    }))
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
    console.log(`  ${f.name.padEnd(12)} → ${f.host}:${f.port}`)
    console.log(`  ${'key:'.padEnd(12)}   ${f.keyPair.publicKey.toString('hex')}`)
  }
  console.log('')

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

  // Set stopping = true on shutdown so the close handler does not trigger restarts.
  let stopping = false

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
    log(`Listening [${f.name}] → ${f.host}:${f.port}`)

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
