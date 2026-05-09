import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { addDevice } from '../../lib/registry.js'
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
import { generateSshKeyMaterial, startMiniSshd } from '../mini-sshd.mjs'

const SSH_USER = 'holee2e'
const REMOTE_UPLOAD = '/tmp/hole-ci-upload.bin'

function hasOpensshClient () {
  const sshV = spawnSync('ssh', ['-V'], { encoding: 'utf8' })
  if (sshV.error || sshV.status !== 0) return false
  // `scp -V` is not universal (some distros omit it); require both binaries on PATH.
  // Avoid `sh -l` — login profiles can hang (conda, prompts); PATH is unchanged for `-c`.
  const onPath = spawnSync('sh', ['-c', 'command -v ssh >/dev/null && command -v scp >/dev/null'], {
    encoding: 'utf8'
  })
  return onPath.status === 0 && !onPath.error
}

function writeIdentity (home, privatePem) {
  const dir = path.join(home, '.ssh')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = path.join(dir, 'id_ci')
  fs.writeFileSync(p, privatePem, { mode: 0o600 })
  return p
}

function parseHoleUpServices (output) {
  const map = {}
  const re = /\n\s{2}(\S+)\s+→[^\n]+\n\s{2}key:\s+([0-9a-f]{64})/gi
  let m
  while ((m = re.exec(output)) !== null) {
    map[m[1]] = m[2]
  }
  return map
}

function runHole (home, args, { expectCode = 0 } = {}) {
  const res = spawnSync(node, ['hole.js', ...args], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  })
  const output = `${res.stdout || ''}${res.stderr || ''}`
  assert.equal(res.status, expectCode, output)
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

test('hole exec reaches local SSH over DHT (OpenSSH + mini sshd)', { skip: !hasOpensshClient(), timeout: 120000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-exec-srv-')
  const clientHome = makeTempHome('hole-e2e-exec-cli-')
  const relayHome = makeTempHome('hole-e2e-exec-relay-')
  const keys = generateSshKeyMaterial()
  const identity = writeIdentity(clientHome, keys.clientPrivate)

  let mini
  let relay
  let up

  try {
    mini = await startMiniSshd({
      hostPrivate: keys.hostPrivate,
      allowedPubKey: keys.allowedPubKey,
      username: SSH_USER
    })

    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    up = spawnHole(['up', '--name', 'ci-exec', '--port', String(mini.port), '--relay', relayAddr], { home: serverHome })
    const upOut = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 35000 })
    const masterKey = upOut.match(/key:\s+([0-9a-f]{64})/i)?.[1]
    assert.match(masterKey, /^[0-9a-f]{64}$/)

    runHole(clientHome, ['add', 'ci-exec', masterKey, '--relay', relayAddr])

    const marker = `hole-exec-e2e-${Date.now()}`
    const out = runHole(clientHome, [
      'exec', 'ci-exec', SSH_USER, '--identity', identity, '--relay', relayAddr, '--', 'echo', marker
    ])
    assert.match(out, new RegExp(marker))
  } finally {
    await stopProcess(up)
    await stopProcess(relay)
    if (mini) await mini.close()
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})

test('hole ssh runs remote command over DHT (OpenSSH + mini sshd)', { skip: !hasOpensshClient(), timeout: 120000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-ssh-srv-')
  const clientHome = makeTempHome('hole-e2e-ssh-cli-')
  const relayHome = makeTempHome('hole-e2e-ssh-relay-')
  const keys = generateSshKeyMaterial()
  const identity = writeIdentity(clientHome, keys.clientPrivate)

  let mini
  let relay
  let up

  try {
    mini = await startMiniSshd({
      hostPrivate: keys.hostPrivate,
      allowedPubKey: keys.allowedPubKey,
      username: SSH_USER
    })

    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    up = spawnHole(['up', '--name', 'ci-ssh', '--port', String(mini.port), '--relay', relayAddr], { home: serverHome })
    const upOut = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 35000 })
    const masterKey = upOut.match(/key:\s+([0-9a-f]{64})/i)?.[1]
    assert.match(masterKey, /^[0-9a-f]{64}$/)

    runHole(clientHome, ['add', 'ci-ssh', masterKey, '--relay', relayAddr])

    const marker = `hole-ssh-e2e-${Date.now()}`
    const out = runHole(clientHome, [
      'ssh', 'ci-ssh', SSH_USER, '--identity', identity, '--relay', relayAddr, '--', 'echo', marker
    ])
    assert.match(out, new RegExp(marker))
  } finally {
    await stopProcess(up)
    await stopProcess(relay)
    if (mini) await mini.close()
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})

test('hole up --forward + hole tunnel reaches a named TCP service', { timeout: 120000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-fwd-srv-')
  const clientHome = makeTempHome('hole-e2e-fwd-cli-')
  const relayHome = makeTempHome('hole-e2e-fwd-relay-')
  const keys = generateSshKeyMaterial()
  let mini
  let echoServer
  let relay
  let up
  let tunnel

  try {
    mini = await startMiniSshd({
      hostPrivate: keys.hostPrivate,
      allowedPubKey: keys.allowedPubKey,
      username: SSH_USER
    })

    const echo = await startEchoServer()
    echoServer = echo.server

    const relayPort = await freePort()
    const proxyPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    up = spawnHole([
      'up',
      '--name',
      'ci-fwd',
      '--port',
      String(mini.port),
      '--forward',
      `aux:${echo.port}`,
      '--relay',
      relayAddr
    ], { home: serverHome })
    const upOut = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 35000 })
    const svcKeys = parseHoleUpServices(upOut)
    assert.equal(typeof svcKeys.ssh, 'string')
    assert.equal(typeof svcKeys.aux, 'string')

    const oldHome = process.env.HOME
    process.env.HOME = clientHome
    try {
      addDevice('ci-fwd', svcKeys.ssh, {
        relay: relayAddr,
        services: { ssh: svcKeys.ssh, aux: svcKeys.aux }
      })
    } finally {
      process.env.HOME = oldHome
    }

    assert.match(runHole(clientHome, ['ping', 'ci-fwd', '--count', '1']), /status=UP/)

    tunnel = spawnHole(['tunnel', 'ci-fwd', 'aux', '--port', String(proxyPort), '--relay', relayAddr], { home: clientHome })
    await waitForOutput(tunnel, new RegExp(`Proxy\\s+:\\s+127\\.0\\.0\\.1:${proxyPort}`), { timeoutMs: 35000 })

    const payload = `fwd-${Date.now()}`
    assert.equal(await sendAndReceive(proxyPort, payload), payload)
  } finally {
    await stopProcess(tunnel)
    await stopProcess(up)
    await stopProcess(relay)
    if (mini) await mini.close()
    await new Promise((resolve) => echoServer?.close(resolve) ?? resolve())
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})

test('hole copy uploads through DHT + OpenSSH SFTP', { skip: !hasOpensshClient(), timeout: 120000 }, async () => {
  const serverHome = makeTempHome('hole-e2e-scp-srv-')
  const clientHome = makeTempHome('hole-e2e-scp-cli-')
  const relayHome = makeTempHome('hole-e2e-scp-relay-')
  const keys = generateSshKeyMaterial()
  const identity = writeIdentity(clientHome, keys.clientPrivate)
  const uploaded = new Map()
  const localFile = path.join(clientHome, 'upload-me.txt')
  const body = `copy-e2e-${Date.now()}\n`

  let mini
  let relay
  let up

  try {
    fs.writeFileSync(localFile, body, 'utf8')

    mini = await startMiniSshd({
      hostPrivate: keys.hostPrivate,
      allowedPubKey: keys.allowedPubKey,
      username: SSH_USER,
      uploadPath: REMOTE_UPLOAD,
      uploaded
    })

    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    up = spawnHole(['up', '--name', 'ci-copy', '--port', String(mini.port), '--relay', relayAddr], { home: serverHome })
    const upOut = await waitForOutput(up, /Waiting for connections/, { timeoutMs: 35000 })
    const masterKey = upOut.match(/key:\s+([0-9a-f]{64})/i)?.[1]
    assert.match(masterKey, /^[0-9a-f]{64}$/)

    runHole(clientHome, ['add', 'ci-copy', masterKey, '--relay', relayAddr])

    runHole(clientHome, [
      'copy',
      localFile,
      `ci-copy:${REMOTE_UPLOAD}`,
      SSH_USER,
      '--identity',
      identity,
      '--relay',
      relayAddr
    ])

    assert.equal(uploaded.get(REMOTE_UPLOAD)?.toString(), body)
  } finally {
    await stopProcess(up)
    await stopProcess(relay)
    if (mini) await mini.close()
    removeTempHome(serverHome)
    removeTempHome(clientHome)
    removeTempHome(relayHome)
  }
})
