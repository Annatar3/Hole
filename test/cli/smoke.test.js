import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { makeTempHome, node, removeTempHome, root } from '../helpers.js'

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

test('CLI smoke uses isolated HOME and validates core commands', () => {
  const home = makeTempHome('hole-cli-')
  try {
    assert.match(runHole(home, ['help']), /hole up/)

    const key = runHole(home, ['key', '--raw']).trim()
    assert.match(key, /^[0-9a-f]{64}$/)

    assert.match(runHole(home, ['services']), /No devices registered/)
    assert.match(runHole(home, ['add', 'local', key]), /Added "local"/)
    assert.match(runHole(home, ['list']), /local/)
    assert.match(runHole(home, ['services', 'local']), /Key\s+:/)

    const tunnel = runHole(home, ['tunnel'], { expectCode: 1 })
    assert.match(tunnel, /Usage: hole tunnel/)

    const proxy = runHole(home, ['proxy'], { expectCode: 1 })
    assert.match(proxy, /Usage: hole proxy/)

    const help = runHole(home, ['help'])
    assert.match(help, /hole relay --host <ip>/)
    assert.match(help, /hole invite/)
    assert.match(help, /hole accept <code>/)
    assert.match(help, /hole doctor --relay 203\.0\.113\.10:49737/)
    assert.match(help, /hole proxy <target>/)
    assert.match(help, /--proxy-allow-lan/)

    const badRelay = runHole(home, ['add', 'bad-relay', key, '--relay', 'relay-only-host'], { expectCode: 1 })
    assert.match(badRelay, /--relay must be host:port/)

    const badPort = runHole(home, ['relay', '--host', '203.0.113.10', '--port', '70000'], { expectCode: 1 })
    assert.match(badPort, /--port must be an integer from 1 to 65535/)

    // hole up with no reachable service should exit with a clear message, not a crash
    const noServices = runHole(home, ['up', '--port', '19999'], { expectCode: 1 })
    assert.match(noServices, /No services are reachable/)

    // hole share with no file arg should exit with usage hint
    const noFile = runHole(home, ['share'], { expectCode: 1 })
    assert.match(noFile, /Usage: hole share/)

    // hole receive with no code arg should exit with usage hint
    const noCode = runHole(home, ['receive'], { expectCode: 1 })
    assert.match(noCode, /Usage: hole receive/)
  } finally {
    removeTempHome(home)
  }
})
