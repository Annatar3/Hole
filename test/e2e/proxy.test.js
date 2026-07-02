import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'net'
import {
  freePort,
  makeTempHome,
  removeTempHome,
  spawnHole,
  stopProcess,
  waitForOutput
} from '../helpers.js'

function startEchoServer () {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(chunk))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

// Reads from `socket` until at least `n` bytes have arrived, then resolves
// with the first `n` bytes and any leftover as `rest`.
function recvExact (socket, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) {
        cleanup()
        resolve({ head: buf.slice(0, n), rest: buf.slice(n) })
      }
    }
    const onError = (e) => { cleanup(); reject(e) }
    function cleanup () {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
    }
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

function buildConnectRequestIPv4 (host, port) {
  const parts = host.split('.').map(Number)
  const buf = Buffer.alloc(10)
  buf[0] = 0x05
  buf[1] = 0x01
  buf[2] = 0x00
  buf[3] = 0x01
  buf[4] = parts[0]; buf[5] = parts[1]; buf[6] = parts[2]; buf[7] = parts[3]
  buf.writeUInt16BE(port, 8)
  return buf
}

// Performs a real SOCKS5 handshake against `hole proxy`'s local listener and
// returns a connected socket ready to exchange application bytes.
async function socks5Connect (socksPort, targetHost, targetPort) {
  const sock = net.connect(socksPort, '127.0.0.1')
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })

  sock.write(Buffer.from([0x05, 0x01, 0x00])) // version 5, 1 method, no-auth
  const { head: methodReply, rest: r1 } = await recvExact(sock, 2)
  assert.deepEqual(methodReply, Buffer.from([0x05, 0x00]), 'server must accept no-auth')

  sock.write(buildConnectRequestIPv4(targetHost, targetPort))
  let connectReply = r1
  while (connectReply.length < 10) {
    const { head } = await recvExact(sock, 10 - connectReply.length)
    connectReply = Buffer.concat([connectReply, head])
  }
  assert.equal(connectReply[0], 0x05)
  assert.equal(connectReply[1], 0x00, 'CONNECT must succeed')

  return sock
}

test('local relay + hole up --proxy + hole proxy relays a SOCKS5 CONNECT over HyperDHT', { timeout: 90000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-proxy-server-')
  const clientHome = makeTempHome('hole-e2e-proxy-client-')
  const relayHome  = makeTempHome('hole-e2e-proxy-relay-')
  let echoServer
  let relay
  let up
  let proxy

  try {
    const echo = await startEchoServer()
    echoServer = echo.server
    const relayPort = await freePort()
    const socksPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    // --proxy-allow-lan is required here because the test target is 127.0.0.1;
    // real deployments should leave it off unless the exit node's LAN is trusted.
    up = spawnHole(['up', '--name', 'ci-exit', '--proxy', '--proxy-allow-lan', '--relay', relayAddr], { home: serverHome })
    const upOutput = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 30000 })
    const keys = [...upOutput.matchAll(/key:\s+([0-9a-f]{64})/gi)].map(m => m[1])
    const proxyKey = keys[keys.length - 1]
    assert.match(proxyKey, /^[0-9a-f]{64}$/)

    proxy = spawnHole(['proxy', proxyKey, '--port', String(socksPort), '--relay', relayAddr], { home: clientHome })
    await waitForOutput(proxy, new RegExp(`SOCKS5\\s+:\\s+127\\.0\\.0\\.1:${socksPort}`), { timeoutMs: 30000 })

    const sock = await socks5Connect(socksPort, '127.0.0.1', echo.port)
    const payload = `hole-proxy-e2e-${Date.now()}`

    const response = await new Promise((resolve, reject) => {
      const chunks = []
      const timer = setTimeout(() => reject(new Error('Timed out waiting for echo response')), 15000)
      sock.on('data', (chunk) => {
        chunks.push(chunk)
        const data = Buffer.concat(chunks).toString()
        if (data.length >= payload.length) {
          clearTimeout(timer)
          sock.end()
          resolve(data)
        }
      })
      sock.once('error', (e) => { clearTimeout(timer); reject(e) })
      sock.write(payload)
    })

    assert.equal(response, payload)
  } finally {
    await stopProcess(proxy)
    await stopProcess(up)
    await stopProcess(relay)
    await new Promise((resolve) => echoServer?.close(resolve) ?? resolve())
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})

test('hole up --proxy refuses to dial private addresses unless --proxy-allow-lan is set', { timeout: 90000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-proxy-guard-server-')
  const clientHome = makeTempHome('hole-e2e-proxy-guard-client-')
  const relayHome  = makeTempHome('hole-e2e-proxy-guard-relay-')
  let echoServer
  let relay
  let up
  let proxy

  try {
    const echo = await startEchoServer()
    echoServer = echo.server
    const relayPort = await freePort()
    const socksPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    up = spawnHole(['up', '--name', 'ci-exit-guarded', '--proxy', '--relay', relayAddr], { home: serverHome })
    const upOutput = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 30000 })
    const keys = [...upOutput.matchAll(/key:\s+([0-9a-f]{64})/gi)].map(m => m[1])
    const proxyKey = keys[keys.length - 1]

    proxy = spawnHole(['proxy', proxyKey, '--port', String(socksPort), '--relay', relayAddr], { home: clientHome })
    await waitForOutput(proxy, new RegExp(`SOCKS5\\s+:\\s+127\\.0\\.0\\.1:${socksPort}`), { timeoutMs: 30000 })

    const sock = net.connect(socksPort, '127.0.0.1')
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    await recvExact(sock, 2)

    sock.write(buildConnectRequestIPv4('127.0.0.1', echo.port))
    const { head: connectReply } = await recvExact(sock, 10)
    assert.equal(connectReply[0], 0x05)
    assert.notEqual(connectReply[1], 0x00, 'CONNECT to a private address must be refused by default')

    // A SOCKS5 client normally resets its side right after a rejected CONNECT.
    // The exit node must not treat that as an unhandled error and crash.
    sock.destroy()
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.equal(up.exitCode, null, '`hole up --proxy` must still be running after a rejected + reset connection')
  } finally {
    await stopProcess(proxy)
    await stopProcess(up)
    await stopProcess(relay)
    await new Promise((resolve) => echoServer?.close(resolve) ?? resolve())
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})
