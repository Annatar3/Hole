import DHT from 'hyperdht'
import net from 'net'
import { log, warn, die, RETRYABLE, MAX_RETRIES, RETRY_BASE_MS, CONNECT_TIMEOUT_MS } from './utils.js'
import { resolveKey, touchDevice, loadRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// Connect to a remote agent with auto-retry on transient DHT errors
// ---------------------------------------------------------------------------
async function connectWithRetry (dht, serverPublicKey, attempt = 1) {
  return new Promise((resolve, reject) => {
    const remote = dht.connect(serverPublicKey)

    const timer = setTimeout(() => {
      remote.destroy()
      const e = Object.assign(new Error('Connection timed out'), { code: 'HOLEPUNCH_TIMEOUT' })
      reject(e)
    }, CONNECT_TIMEOUT_MS)

    remote.once('open', () => {
      clearTimeout(timer)
      resolve(remote)
    })

    remote.once('error', (e) => {
      clearTimeout(timer)
      remote.destroy()
      if (RETRYABLE.has(e.code) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * attempt
        warn(`${e.code} — retry ${attempt}/${MAX_RETRIES - 1} in ${delay}ms...`)
        setTimeout(() => connectWithRetry(dht, serverPublicKey, attempt + 1).then(resolve, reject), delay)
      } else {
        reject(e)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Find a free local port starting from `start`
// ---------------------------------------------------------------------------
function findFreePort (start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && start < 65535) {
        log(`Port ${start} in use, trying ${start + 1}...`)
        findFreePort(start + 1).then(resolve, reject)
      } else {
        reject(e)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// run({ target, port, relay })
//   target — device name OR 64-char hex key
// ---------------------------------------------------------------------------
export async function run ({ target, port = 2222, relay }) {
  const hexKey = resolveKey(target)
  if (!hexKey) {
    const reg = loadRegistry()
    const names = Object.keys(reg)
    die(
      `Unknown device "${target}".\n` +
      (names.length
        ? `Known devices: ${names.join(', ')}\n` +
          `Add it with: hole add <name> <64-char-key>`
        : `No devices registered yet.\n` +
          `Add one with: hole add <name> <64-char-key>`)
    )
  }

  const serverPublicKey = Buffer.from(hexKey, 'hex')
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()
  log(`DHT bootstrapped${relay ? ` (relay: ${relay})` : ''}`)

  const localPort = await findFreePort(port)

  const proxy = net.createServer(async (localConn) => {
    log('[+] incoming connection, opening DHT tunnel...')

    let remote
    try {
      remote = await connectWithRetry(dht, serverPublicKey)
    } catch (e) {
      const hints = {
        PEER_NOT_FOUND:    '→ Is the agent running on the remote host?',
        HOLEPUNCH_ABORTED: '→ Both sides may be behind strict NAT. Try: hole client <target> --relay <host:port>',
        HOLEPUNCH_TIMEOUT: '→ Hole punch timed out. Is outbound UDP allowed?'
      }
      warn(`Could not reach agent: ${e.message}`)
      if (hints[e.code]) warn(hints[e.code])
      localConn.destroy()
      return
    }

    log('[~] tunnel established')
    localConn.pipe(remote)
    remote.pipe(localConn)

    let done = false
    const cleanup = (label) => (e) => {
      if (done) return
      done = true
      if (e?.message) warn(`${label}: ${e.message}`)
      localConn.destroy()
      remote.destroy()
      log(`[-] tunnel closed (${label})`)
    }

    remote.on('error',    cleanup('dht-error'))
    remote.on('close',    cleanup('dht-close'))
    localConn.on('error', cleanup('local-error'))
    localConn.on('close', cleanup('local-close'))
  })

  proxy.on('error', (e) => { die(`Proxy error: ${e.message}`) })

  proxy.listen(localPort, '127.0.0.1', () => {
    console.log('')
    console.log('=== Hole Client ===')
    console.log(`Remote : ${target}  (${hexKey.slice(0, 12)}...)`)
    if (relay) console.log(`Relay  : ${relay}`)
    console.log(`Proxy  : 127.0.0.1:${localPort}`)
    console.log('')
    console.log('Connect via SSH:')
    console.log(`  ssh -p ${localPort} <user>@localhost`)
    console.log('')
    console.log('Press Ctrl+C to stop.\n')
  })

  process.on('SIGINT', async () => {
    log('Shutting down...')
    proxy.close()
    await dht.destroy()
    process.exit(0)
  })
}
