import DHT    from 'hyperdht'
import net    from 'net'
import fs     from 'fs'
import crypto from 'crypto'
import { log, warn, die, hostname } from './utils.js'
import { keypairPath, addDevice, touchDevice } from './registry.js'
import { loadAcl, aclCheck } from './acl.js'
import { auditConnect, auditClose } from './audit.js'

// ---------------------------------------------------------------------------
// Keypair management
// ---------------------------------------------------------------------------
function loadOrCreateKeyPair () {
  const kpFile = keypairPath()
  if (fs.existsSync(kpFile)) {
    const raw = fs.readFileSync(kpFile)
    return { publicKey: raw.slice(0, 32), secretKey: raw.slice(32) }
  }
  const kp = DHT.keyPair()
  fs.writeFileSync(kpFile, Buffer.concat([kp.publicKey, kp.secretKey]), { mode: 0o600 })
  return kp
}

// Derive a deterministic sub-keypair for a named service.
// Uses the master secret key + service name as HKDF input.
function deriveServiceKeyPair (masterSecretKey, serviceName) {
  const seed = crypto.createHash('sha256')
    .update(masterSecretKey)
    .update(Buffer.from(`:${serviceName}`))
    .digest()
  return DHT.keyPair(seed)
}

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
// Spin up one DHT server that pipes connections to host:port
// ---------------------------------------------------------------------------
async function startForward ({ dht, keyPair, host, port, label, acl }) {
  const server = dht.createServer(async conn => {
    // ACL check
    if (!aclCheck(acl, conn.remotePublicKey)) {
      const who = conn.remotePublicKey?.toString('hex').slice(0, 8) ?? '?'
      warn(`[${label}] Rejected ${who} — not in ACL`)
      conn.destroy()
      return
    }

    const clientKey = conn.remotePublicKey?.toString('hex') ?? '?'
    const tag       = clientKey.slice(0, 8)
    const connectedAt = Date.now()
    log(`[${label}] [+] ${tag}`)
    auditConnect({ service: label, clientKey })

    const target = net.connect(port, host)
    conn.pipe(target)
    target.pipe(conn)

    let done = false
    const cleanup = (side) => (e) => {
      if (done) return
      done = true
      if (e?.message) warn(`[${label}] ${tag} ${side}: ${e.message}`)
      auditClose({ service: label, clientKey, durationMs: Date.now() - connectedAt })
      log(`[${label}] [-] ${tag} closed`)
      conn.destroy()
      target.destroy()
    }

    conn.on('error',    cleanup('dht-error'))
    conn.on('close',    cleanup('dht-close'))
    target.on('error',  cleanup('target-error'))
    target.on('close',  cleanup('target-close'))
  })

  await server.listen(keyPair)
  return server
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

  // Build the full list of forwards.
  // The SSH (default) forward always uses the MASTER keypair so old clients work.
  // Additional forwards each get a derived keypair.
  const allForwards = [
    { name: 'ssh', host: sshHost, port: sshPort, keyPair: masterKeyPair },
    ...forwards.map(f => ({
      ...f,
      keyPair: deriveServiceKeyPair(masterKeyPair.secretKey, f.name)
    }))
  ]

  // Print header
  console.log('\n=== Hole Agent ===')
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

  // Pre-flight checks
  for (const f of allForwards) {
    const ok = await checkTarget(f.host, f.port)
    if (!ok) die(`Cannot reach ${f.host}:${f.port} for service "${f.name}". Is it running?`)
  }

  // Start DHT
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()
  log('DHT bootstrapped')

  // Start one server per forward
  const servers = []
  for (const f of allForwards) {
    const srv = await startForward({ dht, keyPair: f.keyPair, host: f.host, port: f.port, label: f.name, acl })
    servers.push(srv)
    log(`Listening [${f.name}] → ${f.host}:${f.port}`)
  }

  log('Waiting for connections...\n')

  if (name) {
    setInterval(() => touchDevice(name), 60_000)
  }

  process.on('SIGINT', async () => {
    log('Shutting down...')
    await Promise.all(servers.map(s => s.close()))
    await dht.destroy()
    process.exit(0)
  })
}
