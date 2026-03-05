import DHT from 'hyperdht'
import net from 'net'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const KEYFILE = path.join(__dirname, '.agent-keypair')

// ---------------------------------------------------------------------------
// Keypair — generated once, persisted so the public key stays stable across
// restarts. Clients need the public key to reach this host.
// ---------------------------------------------------------------------------
function loadOrCreateKeyPair () {
  if (fs.existsSync(KEYFILE)) {
    const raw = fs.readFileSync(KEYFILE)
    return {
      publicKey: raw.slice(0, 32),
      secretKey: raw.slice(32)
    }
  }
  const kp = DHT.keyPair()
  fs.writeFileSync(KEYFILE, Buffer.concat([kp.publicKey, kp.secretKey]), { mode: 0o600 })
  return kp
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const SSH_HOST = process.env.SSH_HOST || '127.0.0.1'
const SSH_PORT = parseInt(process.env.SSH_PORT || '22', 10)

const keyPair = loadOrCreateKeyPair()

console.log('=== Hole Agent ===')
console.log('Public key (share with clients):')
console.log(keyPair.publicKey.toString('hex'))
console.log('')

const dht = new DHT()

await dht.ready()
console.log('[i] DHT bootstrapped')

const server = dht.createServer(conn => {
  const tag = conn.remotePublicKey?.toString('hex').slice(0, 12) ?? 'unknown'
  console.log(`[+] connection from ${tag}...`)

  const ssh = net.connect(SSH_PORT, SSH_HOST)

  conn.pipe(ssh)
  ssh.pipe(conn)

  const cleanup = (label) => () => {
    console.log(`[-] ${tag} disconnected (${label})`)
    conn.destroy()
    ssh.destroy()
  }

  conn.on('error', cleanup('dht side'))
  conn.on('close', cleanup('dht close'))
  ssh.on('error', cleanup('ssh side'))
})

await server.listen(keyPair)

console.log(`Tunnelling DHT → ${SSH_HOST}:${SSH_PORT}`)
console.log('Waiting for connections...\n')

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await server.close()
  await dht.destroy()
  process.exit(0)
})
