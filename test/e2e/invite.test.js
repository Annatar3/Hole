import test from 'node:test'
import assert from 'node:assert/strict'
import {
  freePort,
  makeTempHome,
  removeTempHome,
  runHoleAsync,
  spawnHole,
  stopProcess,
  waitForOutput
} from '../helpers.js'

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
    const inviteOutput = await waitForOutput(invite, /Invite code:\s+[a-z]+-[a-z]+-\d{4}/, { timeoutMs: 30000 })
    const code = inviteOutput.match(/Invite code:\s+([a-z]+-[a-z]+-\d{4})/)?.[1]
    assert.match(code, /^[a-z]+-[a-z]+-\d{4}$/)

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
