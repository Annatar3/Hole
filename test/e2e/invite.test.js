import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import DHT from 'hyperdht'
import {
  freePort,
  makeTempHome,
  removeTempHome,
  runHoleAsync,
  spawnHole,
  stopProcess,
  waitForOutput
} from '../helpers.js'

// Mirrors lib/invite.js: sha256('hole-invite:v1:' + code) → DHT.keyPair(seed).
function inviteKeyForCode (code) {
  const seed = crypto.createHash('sha256').update('hole-invite:v1:').update(code).digest()
  return DHT.keyPair(seed).publicKey
}

test('hole invite + hole accept pairs a device through a local relay', { timeout: 90000 }, async () => {
  const inviteHome = makeTempHome('hole-invite-src-')
  const acceptHome = makeTempHome('hole-invite-dst-')
  const relayHome = makeTempHome('hole-invite-relay-')
  let relay
  let invite

  try {
    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    invite = spawnHole(['invite', '--name', 'invited-pc', '--relay', relayAddr, '--user', 'alice', '--ttl', '30'], {
      home: inviteHome
    })
    const inviteOutput = await waitForOutput(invite, /Invite code:\s+[a-z]+-[a-z]+-[a-z]+-\d{4}/, { timeoutMs: 30000 })
    const code = inviteOutput.match(/Invite code:\s+([a-z]+-[a-z]+-[a-z]+-\d{4})/)?.[1]
    assert.match(code, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/)

    const acceptOutput = await runHoleAsync(acceptHome, ['accept', code, '--relay', relayAddr], { timeoutMs: 30000 })
    assert.match(acceptOutput, /Added "invited-pc" from invite/)
    assert.match(acceptOutput, /Try: hole ssh invited-pc/)

    const listOutput = await runHoleAsync(acceptHome, ['list'], { timeoutMs: 30000 })
    assert.match(listOutput, /invited-pc/)
  } finally {
    await stopProcess(invite)
    await stopProcess(relay)
    removeTempHome(inviteHome)
    removeTempHome(acceptHome)
    removeTempHome(relayHome)
  }
})

test('hole invite does not crash when a peer connects to the invite key and resets', { timeout: 90000 }, async () => {
  const inviteHome = makeTempHome('hole-invite-dos-src-')
  const relayHome = makeTempHome('hole-invite-dos-relay-')
  let relay
  let invite
  let attacker

  try {
    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`

    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    invite = spawnHole(['invite', '--name', 'invited-pc', '--relay', relayAddr, '--ttl', '60'], { home: inviteHome })
    const inviteOutput = await waitForOutput(invite, /Invite code:\s+[a-z]+-[a-z]+-[a-z]+-\d{4}/, { timeoutMs: 30000 })
    const code = inviteOutput.match(/Invite code:\s+([a-z]+-[a-z]+-[a-z]+-\d{4})/)?.[1]

    // Connect to the invite key and reset on open — this used to kill the invite
    // process with an unhandled 'error' event (Node exits 1 + prints a stack).
    // The invite legitimately serves its payload to any key holder and then exits
    // 0; the regression is specifically the *crash*, so we assert it exits (or
    // stays) gracefully and never prints the unhandled-error banner.
    attacker = new DHT({ bootstrap: [relayAddr] })
    await attacker.ready()
    const conn = attacker.connect(inviteKeyForCode(code))
    conn.on('error', () => {})
    conn.once('open', () => conn.destroy())
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await attacker.destroy()
    attacker = null

    assert.notEqual(invite.exitCode, 1, '`hole invite` must not crash (exit 1) on a peer reset')
    assert.doesNotMatch(invite.output, /Emitted 'error' event|Uncaught|ERR_UNHANDLED_ERROR/,
      'invite must not print an unhandled-error crash banner')
  } finally {
    if (attacker) await attacker.destroy()
    await stopProcess(invite)
    await stopProcess(relay)
    removeTempHome(inviteHome)
    removeTempHome(relayHome)
  }
})
