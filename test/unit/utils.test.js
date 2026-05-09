import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../lib/utils.js'

test('parseArgs separates positionals, values, booleans, and repeated flags', () => {
  const parsed = parseArgs([
    'server',
    '--relay', '127.0.0.1:49737',
    '--forward', 'rdp:3389',
    '--forward', 'web:3000',
    'extra',
    '--ping'
  ])

  assert.deepEqual(parsed.positional, ['server', 'extra'])
  assert.equal(parsed.flags.relay, '127.0.0.1:49737')
  assert.deepEqual(parsed.flags.forward, ['rdp:3389', 'web:3000'])
  assert.equal(parsed.flags.ping, true)
})
