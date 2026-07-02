import net from 'net'
import DHT from 'hyperdht'
import { log, warn, hintForConnectionStatus } from './utils.js'
import { resolveTarget, connectWithRetry, findFreePort } from './client.js'
import { parseGreeting, parseConnectRequest, buildMethodReply, buildConnectReply, REP } from './socks5.js'

// ---------------------------------------------------------------------------
// Reads from `socket` until `parseFn(buf)` returns a non-null { length, ... },
// then resolves with that result plus any bytes past `length` as `rest`.
// ---------------------------------------------------------------------------
function readParsed (socket, parseFn, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let buf = initial

    const tryParse = () => {
      let parsed
      try {
        parsed = parseFn(buf)
      } catch (e) {
        cleanup()
        reject(e)
        return true
      }
      if (parsed) {
        cleanup()
        resolve({ ...parsed, rest: buf.slice(parsed.length) })
        return true
      }
      return false
    }

    const onData  = (chunk) => { buf = Buffer.concat([buf, chunk]); tryParse() }
    const onError = (e) => { cleanup(); reject(e) }
    const onClose = () => { cleanup(); reject(new Error('connection closed')) }
    function cleanup () {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    if (tryParse()) return
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function parseProxyResponse (buf) {
  const nl = buf.indexOf(10)
  if (nl === -1) return null
  let resp
  try {
    resp = JSON.parse(buf.slice(0, nl).toString())
  } catch (e) {
    throw new Error('Invalid response from proxy service')
  }
  return { resp, length: nl + 1 }
}

// ---------------------------------------------------------------------------
// Handles one local SOCKS5 client: negotiate, read the CONNECT request,
// open a DHT tunnel to the remote proxy service, relay the target through it.
// ---------------------------------------------------------------------------
async function handleSocksConnection (client, dht, serverPubKey, relay) {
  const greeting = await readParsed(client, parseGreeting)
  client.write(buildMethodReply(0x00))

  const request = await readParsed(client, parseConnectRequest, greeting.rest)
  const { host, port } = request

  let remote
  try {
    remote = await connectWithRetry(dht, serverPubKey)
  } catch (e) {
    const hint = hintForConnectionStatus(e.code, relay)
    warn(`[proxy] could not reach remote service: ${e.message}${hint ? ` — ${hint}` : ''}`)
    client.write(buildConnectReply(REP.HOST_UNREACHABLE))
    client.end()
    return
  }

  remote.write(Buffer.from(JSON.stringify({ host, port }) + '\n'))

  let reply
  try {
    reply = await readParsed(remote, parseProxyResponse)
  } catch (e) {
    warn(`[proxy] ${host}:${port} — ${e.message}`)
    client.write(buildConnectReply(REP.HOST_UNREACHABLE))
    client.end()
    remote.destroy()
    return
  }

  if (!reply.resp.ok) {
    warn(`[proxy] ${host}:${port} — ${reply.resp.error || 'connection failed'}`)
    client.write(buildConnectReply(REP.HOST_UNREACHABLE))
    client.end()
    remote.destroy()
    return
  }

  client.write(buildConnectReply(REP.SUCCESS))
  if (reply.rest.length) client.write(reply.rest)

  client.pipe(remote)
  remote.pipe(client)

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    client.destroy()
    remote.destroy()
  }
  client.on('error', cleanup)
  client.on('close', cleanup)
  remote.on('error', cleanup)
  remote.on('close', cleanup)
}

// ---------------------------------------------------------------------------
// run({ target, relay, port })
//
// Starts a local SOCKS5 server. Each CONNECT is tunneled over HyperDHT to a
// peer running `hole up --proxy`, which dials the real destination.
// ---------------------------------------------------------------------------
export async function run ({ target, relay = null, port = 1080 }) {
  const hexKey = resolveTarget(target, 'proxy')
  const serverPubKey = Buffer.from(hexKey, 'hex')
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()
  log(`DHT bootstrapped${relay ? ` (relay: ${relay})` : ''}`)

  const localPort = await findFreePort(port)

  const server = net.createServer((client) => {
    handleSocksConnection(client, dht, serverPubKey, relay).catch(e => {
      warn(`[proxy] ${e.message}`)
      client.destroy()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  server.on('error', (e) => warn(`[proxy] ${e.message}`))

  console.log('')
  console.log('=== Hole Proxy ===')
  console.log(`Remote : ${target}  (${hexKey.slice(0, 12)}...)`)
  if (relay) console.log(`Relay  : ${relay}`)
  console.log(`SOCKS5 : 127.0.0.1:${localPort}`)
  console.log('')
  console.log('Point a browser or app at this SOCKS5 proxy, e.g.:')
  console.log(`  curl --socks5-hostname 127.0.0.1:${localPort} https://example.com`)
  console.log('')
  console.log('Press Ctrl+C to stop.\n')

  process.on('SIGINT', async () => {
    log('Shutting down...')
    server.close()
    await dht.destroy()
    process.exit(0)
  })
}
