import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import net from 'net'
import {
  freePort,
  makeTempHome,
  node,
  removeTempHome,
  root,
  spawnHole,
  stopProcess,
  waitForOutput
} from '../helpers.js'

function runHole (home, args) {
  const res = spawnSync(node, ['hole.js', ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`
  assert.equal(res.status, 0, output)
  return output
}

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

function sendAndReceive (port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for echo response'))
    }, 15000)

    socket.once('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const data = Buffer.concat(chunks).toString()
      if (data.length >= payload.length) {
        clearTimeout(timer)
        socket.end()
        resolve(data)
      }
    })
    socket.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

test('local relay + hole up + hole tunnel forwards bytes through a local TCP service', { timeout: 90000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-server-')
  const clientHome = makeTempHome('hole-e2e-client-')
  const relayHome = makeTempHome('hole-e2e-relay-')
  let echoServer
  let relay
  let up
  let tunnel

  try {
    const echo = await startEchoServer()
    echoServer = echo.server
    const relayPort = await freePort()
    const proxyPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    up = spawnHole(['up', '--name', 'ci-local', '--port', String(echo.port), '--relay', relayAddr], { home: serverHome })
    const upOutput = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 30000 })
    const key = upOutput.match(/key:\s+([0-9a-f]{64})/i)?.[1]
    assert.match(key, /^[0-9a-f]{64}$/)

    runHole(clientHome, ['add', 'ci-local', key, '--relay', relayAddr])
    assert.match(runHole(clientHome, ['ping', 'ci-local', '--count', '1']), /status=UP/)

    tunnel = spawnHole(['tunnel', 'ci-local', '--port', String(proxyPort)], { home: clientHome })
    await waitForOutput(tunnel, new RegExp(`Proxy\\s+:\\s+127\\.0\\.0\\.1:${proxyPort}`), { timeoutMs: 30000 })

    const payload = `hole-e2e-${Date.now()}`
    const response = await sendAndReceive(proxyPort, payload)
    assert.equal(response, payload)
  } finally {
    await stopProcess(tunnel)
    await stopProcess(up)
    await stopProcess(relay)
    await new Promise((resolve) => echoServer?.close(resolve) ?? resolve())
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})
