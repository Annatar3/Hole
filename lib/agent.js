import DHT  from 'hyperdht'
import net  from 'net'
import fs   from 'fs'
import { log, warn, die, hostname } from './utils.js'
import { keypairPath, addDevice, touchDevice } from './registry.js'

// ---------------------------------------------------------------------------
// Keypair
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

// ---------------------------------------------------------------------------
// Pre-flight: make sure sshd / target port is reachable locally
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
// run({ name, relay, sshHost, sshPort })
// ---------------------------------------------------------------------------
export async function run ({ name, relay, sshHost = '127.0.0.1', sshPort = 22 }) {
  const keyPair = loadOrCreateKeyPair()
  const hexKey  = keyPair.publicKey.toString('hex')

  if (name) {
    addDevice(name, hexKey, { host: hostname() })
  }

  console.log('=== Hole Agent ===')
  if (name)  console.log(`Name   : ${name}`)
  console.log(`Target : ${sshHost}:${sshPort}`)
  if (relay) console.log(`Relay  : ${relay}`)
  console.log(`Key    : ${hexKey}`)
  console.log('')

  const ok = await checkTarget(sshHost, sshPort)
  if (!ok) die(`Cannot reach ${sshHost}:${sshPort}. Is SSH running? Use SSH_PORT=<n> to override.`)

  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()
  log('DHT bootstrapped')

  let active = 0
  let total  = 0

  const server = dht.createServer(conn => {
    const tag = conn.remotePublicKey?.toString('hex').slice(0, 8) ?? '?'
    active++
    total++
    log(`[+] ${tag}  active=${active}  total=${total}`)
    if (name) touchDevice(name)

    const ssh = net.connect(sshPort, sshHost)
    conn.pipe(ssh)
    ssh.pipe(conn)

    let done = false
    const cleanup = (label) => (e) => {
      if (done) return
      done = true
      active--
      if (e?.message) warn(`${tag} ${label}: ${e.message}`)
      log(`[-] ${tag} (${label})  active=${active}`)
      conn.destroy()
      ssh.destroy()
    }

    conn.on('error', cleanup('dht-error'))
    conn.on('close', cleanup('dht-close'))
    ssh.on('error',  cleanup('ssh-error'))
    ssh.on('close',  cleanup('ssh-close'))
  })

  await server.listen(keyPair)
  log(`Listening — tunnelling → ${sshHost}:${sshPort}`)
  log('Waiting for connections...\n')

  process.on('SIGINT', async () => {
    log('Shutting down...')
    await server.close()
    await dht.destroy()
    process.exit(0)
  })
}
