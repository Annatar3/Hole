import DHT    from 'hyperdht'
import net    from 'net'
import { spawn } from 'child_process'
import { log, warn, die, isRetryable, backoffDelay, MAX_RETRIES, CONNECT_TIMEOUT_MS, hintForConnectionStatus } from './utils.js'
import { loadRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// DHT connect with auto-retry on transient errors
// ---------------------------------------------------------------------------
export async function connectWithRetry (dht, serverPublicKey, attempt = 1) {
  return new Promise((resolve, reject) => {
    const remote = dht.connect(serverPublicKey)

    const timer = setTimeout(() => {
      remote.destroy()
      reject(Object.assign(new Error('Connection timed out'), { code: 'HOLEPUNCH_TIMEOUT' }))
    }, CONNECT_TIMEOUT_MS)

    remote.once('open', () => { clearTimeout(timer); resolve(remote) })

    remote.once('error', (e) => {
      clearTimeout(timer)
      remote.destroy()
      if (isRetryable(e.code) && attempt < MAX_RETRIES) {
        const delay = backoffDelay(attempt)
        warn(`${e.code} — retry ${attempt}/${MAX_RETRIES - 1} in ${delay}ms...`)
        setTimeout(() => connectWithRetry(dht, serverPublicKey, attempt + 1).then(resolve, reject), delay)
      } else {
        reject(e)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Find a free local port
// ---------------------------------------------------------------------------
export function findFreePort (start) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && start < 65535) {
        findFreePort(start + 1).then(resolve, reject)
      } else {
        reject(e)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Resolve device name / optional service → hex public key
// ---------------------------------------------------------------------------
export function resolveTarget (target, service) {
  if (/^[0-9a-f]{64}$/i.test(target)) return target

  const reg = loadRegistry()
  const device = reg[target]

  if (!device) {
    const names = Object.keys(reg)
    throw new Error(
      `Unknown device "${target}".\n` +
      (names.length
        ? `Known devices: ${names.join(', ')}\n` +
          `Add it with: hole add <name> <64-char-key>`
        : `No devices registered yet.\n` +
          `Add one with: hole add <name> <64-char-key>`)
    )
  }

  if (service) {
    const svcKey = device.services?.[service]
    // Backward compatibility: old registry entries may not have an explicit
    // services map; "ssh" should still resolve to the device key.
    if (!svcKey && service === 'ssh') return device.key
    if (!svcKey) {
      const available = Object.keys(device.services ?? {})
      throw new Error(
        `Service "${service}" not found on device "${target}".\n` +
        (available.length ? `Available: ${available.join(', ')}` : `No services registered.`)
      )
    }
    return svcKey
  }

  return device.key
}

// ---------------------------------------------------------------------------
// openProxy — shared core
// Returns { localPort, close() } and starts the proxy server.
// Resolves once the proxy is listening and ready to accept connections.
// ---------------------------------------------------------------------------
export async function openProxy ({ target, service = null, port = 2222, relay }) {
  const hexKey        = resolveTarget(target, service)
  const serverPubKey  = Buffer.from(hexKey, 'hex')
  const dht           = new DHT(relay ? { bootstrap: [relay] } : {})

  await dht.ready()
  log(`DHT bootstrapped${relay ? ` (relay: ${relay})` : ''}`)

  const localPort = await findFreePort(port)

  const proxy = net.createServer(async (localConn) => {
    log('[+] incoming connection, opening DHT tunnel...')

    let remote
    try {
      remote = await connectWithRetry(dht, serverPubKey)
    } catch (e) {
      warn(`Could not reach remote service: ${e.message}`)
      const hint = hintForConnectionStatus(e.code, relay)
      if (hint) warn(hint)
      localConn.destroy()
      return
    }

    log('[~] tunnel established')

    // Keep both ends alive across idle periods (important for HTTP keep-alive
    // and persistent web tunnels — prevents premature RST from the OS).
    localConn.setKeepAlive(true, 15000)
    remote.setKeepAlive && remote.setKeepAlive(true, 15000)

    localConn.pipe(remote)
    remote.pipe(localConn)

    let done = false
    const cleanup = (label) => (e) => {
      if (done) return
      done = true
      // "connection reset by peer" / dht-close are normal for HTTP keep-alive
      // connections (nginx closes idle ones). Log at info level, not warn.
      const isNormal = !e?.message ||
        e.message.includes('connection reset by peer') ||
        e.message.includes('ECONNRESET') ||
        label === 'dht-close' ||
        label === 'local-close'
      if (e?.message && !isNormal) warn(`${label}: ${e.message}`)
      localConn.destroy()
      remote.destroy()
      log(`[-] tunnel closed (${label})`)
    }

    remote.on('error',    cleanup('dht-error'))
    remote.on('close',    cleanup('dht-close'))
    localConn.on('error', cleanup('local-error'))
    localConn.on('close', cleanup('local-close'))
  })

  // Reject the openProxy promise on listen failure; don't crash the process
  // (important when openProxy is used inside the dashboard — die() kills all WS sessions)
  await new Promise((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(localPort, '127.0.0.1', () => {
      proxy.removeListener('error', reject)
      resolve()
    })
  })

  // After the server is listening, non-fatal errors (e.g. post-accept ECONNRESET) just log.
  proxy.on('error', (e) => warn(`[proxy] ${e.message}`))

  const close = async () => {
    proxy.close()
    await dht.destroy()
  }

  return { localPort, hexKey, close }
}

// ---------------------------------------------------------------------------
// run() — exposes the proxy and waits (manual mode, Ctrl+C to exit)
// ---------------------------------------------------------------------------
export async function run ({ target, service = null, port = 2222, relay }) {
  const { localPort, hexKey, close } = await openProxy({ target, service, port, relay })

  const svc = service ? ` [${service}]` : ''
  console.log('')
  console.log('=== Hole tunnel ===')
  console.log(`Remote : ${target}${svc}  (${hexKey.slice(0, 12)}...)`)
  if (relay) console.log(`Relay  : ${relay}`)
  console.log(`Proxy  : 127.0.0.1:${localPort}`)
  console.log('')
  console.log('Connect via SSH:')
  console.log(`  ssh -p ${localPort} <user>@127.0.0.1`)
  console.log('')
  console.log('Press Ctrl+C to stop.\n')

  process.on('SIGINT', async () => {
    log('Shutting down...')
    await close()
    process.exit(0)
  })
}

// ---------------------------------------------------------------------------
// exec() — run a single command on the remote host then exit
//
//   hole exec my-remote user -- ls -la /etc
// ---------------------------------------------------------------------------
export async function exec ({ target, user, service = null, relay, identity = null, cmd = [] }) {
  if (!cmd.length) {
    console.error('\nError: no command provided. Usage: hole exec <device> <user> -- <cmd>\n')
    process.exit(1)
  }

  const { localPort, hexKey, close } = await openProxy({ target, service, port: 0, relay })
  const loginUser = user || process.env.USER || process.env.USERNAME || 'user'

  const args = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-p', String(localPort)
  ]
  if (identity) args.push('-i', identity)
  args.push(`${loginUser}@127.0.0.1`, ...cmd)

  const child = spawn('ssh', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('exit', async (code) => { await close(); process.exit(code ?? 0) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
}

// ---------------------------------------------------------------------------
// copy() — copy files to/from a remote host through the tunnel
//
//   hole copy file.txt my-remote:/tmp/ user          (local → remote)
//   hole copy my-remote:/tmp/file.txt . user          (remote → local)
//
// Syntax for remote paths:  device:/absolute/path
// ---------------------------------------------------------------------------
export async function copy ({ target, src, dest, user, relay, identity = null }) {
  const loginUser = user || process.env.USER || process.env.USERNAME || 'user'

  // Determine which side is remote; rewrite device:/path → user@127.0.0.1:/path
  const REMOTE_RE = /^[^/:\\]+:(.+)$/

  let realSrc  = src
  let realDest = dest

  const srcMatch  = src.match(REMOTE_RE)
  const destMatch = dest.match(REMOTE_RE)

  if (!srcMatch && !destMatch) {
    console.error('\nError: one of source or destination must be a remote path (device:/path)\n')
    process.exit(1)
  }

  // Extract the device name from whichever side is remote
  const remoteArg = srcMatch ? src : dest
  const deviceName = remoteArg.split(':')[0]
  const remotePath = remoteArg.split(':').slice(1).join(':')

  // Resolve target from device name
  const resolvedTarget = target || deviceName

  const { localPort, close } = await openProxy({ target: resolvedTarget, port: 0, relay })

  const remoteSpec = `${loginUser}@127.0.0.1:${remotePath}`
  if (srcMatch)  realSrc  = remoteSpec
  if (destMatch) realDest = remoteSpec

  const args = [
    '-O',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-P', String(localPort)
  ]
  if (identity) args.push('-i', identity)
  args.push(realSrc, realDest)

  console.log(`\n=== Hole Copy ===`)
  console.log(`${src}  →  ${dest}  (via ${resolvedTarget})`)
  console.log(`User: ${loginUser}\n`)

  const child = spawn('scp', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('exit', async (code) => { await close(); process.exit(code ?? 0) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
}

// ---------------------------------------------------------------------------
// ssh() — opens the proxy, spawns ssh, tears down when done
//
//   hole ssh my-remote                       → ssh <$USER>@127.0.0.1
//   hole ssh my-remote admin                 → ssh admin@127.0.0.1
//   hole ssh my-remote admin -- -L 8080:localhost:3000   → with extra SSH args
// ---------------------------------------------------------------------------
export async function ssh ({ target, user, service = null, relay, identity = null, sshArgs = [] }) {
  const { localPort, hexKey, close } = await openProxy({ target, service, port: 0, relay })

  const loginUser = user || process.env.USER || process.env.USERNAME || 'user'
  const cmd = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-p', String(localPort)
  ]
  if (identity) cmd.push('-i', identity)
  cmd.push(`${loginUser}@127.0.0.1`, ...sshArgs)

  console.log('')
  console.log(`=== Hole SSH ===`)
  console.log(`Remote : ${target}  (${hexKey.slice(0, 12)}...)`)
  if (relay) console.log(`Relay  : ${relay}`)
  console.log(`User   : ${loginUser}`)
  if (sshArgs.length) console.log(`Args   : ${sshArgs.join(' ')}`)
  console.log('')

  const stdio = sshArgs.length ? ['ignore', 'inherit', 'inherit'] : 'inherit'
  const child = spawn('ssh', cmd, { stdio })

  child.on('exit', async (code) => {
    await close()
    process.exit(code ?? 0)
  })

  // Pass signals through so Ctrl+C is handled cleanly by ssh itself
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig))
  }
}
