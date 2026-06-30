import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePort, normalizeRelayAddress, parseArgs } from '../../lib/utils.js'
import { createInviteCode, isInviteCode } from '../../lib/invite.js'

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

test('normalizeRelayAddress accepts host:port and normalizes numeric port', () => {
  assert.equal(normalizeRelayAddress('127.0.0.1:49737'), '127.0.0.1:49737')
  assert.equal(normalizeRelayAddress('relay.example.com:0049737'), 'relay.example.com:49737')
  assert.equal(normalizeRelayAddress(null), null)
})

test('normalizeRelayAddress rejects malformed relay values', () => {
  assert.throws(() => normalizeRelayAddress('relay.example.com'), /host:port/)
  assert.throws(() => normalizeRelayAddress('relay.example.com:http'), /port/)
  assert.throws(() => normalizeRelayAddress('relay example:49737'), /spaces/)
  assert.throws(() => normalizeRelayAddress('relay.example.com:70000'), /1 to 65535/)
  assert.throws(() => normalizeRelayAddress(true), /host:port/)
})

test('normalizePort accepts valid TCP/UDP port numbers only', () => {
  assert.equal(normalizePort('49737'), 49737)
  assert.throws(() => normalizePort('0'), /1 to 65535/)
  assert.throws(() => normalizePort('70000'), /1 to 65535/)
  assert.throws(() => normalizePort('abc'), /1 to 65535/)
})

test('invite codes are three-word tokens with ~37 bits of entropy', () => {
  const code = createInviteCode()
  assert.match(code, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/)
  assert.equal(isInviteCode(code), true)
  assert.equal(isInviteCode('not-a-code'), false)
  assert.equal(isInviteCode('blue-river-4821'), false, 'old two-word format must not be accepted')

  // Verify all generated words come from the 256-word list and the digit block is valid
  const parts = code.split('-')
  assert.equal(parts.length, 4)
  assert.match(parts[3], /^\d{4}$/)
})
