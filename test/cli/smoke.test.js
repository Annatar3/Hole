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
  } finally {
    removeTempHome(home)
  }
})
