import DHT from 'hyperdht'
import net from 'net'

// ---------------------------------------------------------------------------
// Usage:
//   node client.js <hex-public-key> [local-port]
//
// Example:
//   node client.js a1b2c3...  2222
//   ssh -p 2222 user@localhost
// ---------------------------------------------------------------------------

const hexKey   = process.argv[2]
const localPort = parseInt(process.argv[3] || '2222', 10)

if (!hexKey || hexKey.length !== 64) {
  console.error('Usage: node client.js <64-char-hex-public-key> [local-port]')
  console.error('Example: node client.js a1b2c3...def 2222')
  process.exit(1)
}

const serverPublicKey = Buffer.from(hexKey, 'hex')
const dht = new DHT({ port: 49738 })

// ---------------------------------------------------------------------------
// Open a local TCP server. Every connection to it gets a fresh encrypted
// HyperDHT pipe to the remote agent.
// ---------------------------------------------------------------------------
const proxy = net.createServer(localConn => {
  console.log(`[+] local connection, opening DHT tunnel...`)

  const remote = dht.connect(serverPublicKey)

  remote.on('open', () => console.log('[~] tunnel established'))

  localConn.pipe(remote)
  remote.pipe(localConn)

  let cleaned = false
  const cleanup = (label) => (err) => {
    if (cleaned) return
    cleaned = true
    if (err) console.error(`[!] ${label} error:`, err.message)
    localConn.destroy()
    remote.destroy()
    console.log(`[-] tunnel closed (${label})`)
  }

  remote.on('error', cleanup('dht side'))
  remote.on('close', cleanup('dht close'))
  localConn.on('error', cleanup('local side'))
  localConn.on('close', cleanup('local close'))
})

await dht.ready()
console.log('[i] DHT bootstrapped')

proxy.listen(localPort, '127.0.0.1', () => {
  console.log('=== Hole Client ===')
  console.log(`Proxy listening on 127.0.0.1:${localPort}`)
  console.log('')
  console.log('Connect via SSH:')
  console.log(`  ssh -p ${localPort} user@localhost`)
  console.log('')
  console.log('Or with a specific key:')
  console.log(`  ssh -p ${localPort} -i ~/.ssh/id_ed25519 user@localhost`)
  console.log('')
  console.log('Press Ctrl+C to stop.\n')
})

process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  proxy.close()
  await dht.destroy()
  process.exit(0)
})
