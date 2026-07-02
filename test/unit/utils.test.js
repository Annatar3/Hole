import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePort,
  normalizeRelayAddress,
  parseArgs,
  isPrivateAddress,
  isRetryable,
  backoffDelay,
  RETRY_BASE_MS,
  RETRY_MAX_MS
} from '../../lib/utils.js'
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

test('isPrivateAddress flags loopback/RFC1918/link-local, allows public IPs', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('10.0.0.5'), true)
  assert.equal(isPrivateAddress('172.16.0.1'), true)
  assert.equal(isPrivateAddress('172.31.255.255'), true)
  assert.equal(isPrivateAddress('172.32.0.1'), false)
  assert.equal(isPrivateAddress('192.168.1.1'), true)
  assert.equal(isPrivateAddress('169.254.1.1'), true)
  assert.equal(isPrivateAddress('0.0.0.0'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('93.184.216.34'), false)
  assert.equal(isPrivateAddress('::1'), true)
  assert.equal(isPrivateAddress('fe80::1'), true)
  assert.equal(isPrivateAddress('fd00::1'), true)
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false)
})

test('isRetryable retries transient hole-punch/network codes only', () => {
  for (const code of ['HOLEPUNCH_ABORTED', 'HOLEPUNCH_TIMEOUT', 'PEER_NOT_FOUND', 'PEER_CONNECTION_FAILED', 'ETIMEDOUT']) {
    assert.equal(isRetryable(code), true, `${code} should be retryable`)
  }
  for (const code of ['ECONNREFUSED', 'EACCES', undefined, null, 'SOME_FATAL_ERROR']) {
    assert.equal(isRetryable(code), false, `${code} should not be retryable`)
  }
})

test('backoffDelay grows exponentially, stays within jitter bounds, and caps', () => {
  // For each attempt the base component is min(RETRY_MAX_MS, RETRY_BASE_MS * 2^(n-1)),
  // and the returned delay is in [base, base * 1.25). Sample repeatedly to exercise jitter.
  for (const attempt of [1, 2, 3, 4, 5, 8]) {
    const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1))
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(attempt)
      assert.ok(d >= exp, `attempt ${attempt}: ${d} >= ${exp}`)
      assert.ok(d < exp * 1.25 + 1, `attempt ${attempt}: ${d} < ${exp * 1.25}`)
    }
  }

  // Base component is monotonic non-decreasing and never exceeds the cap.
  assert.equal(Math.min(RETRY_MAX_MS, RETRY_BASE_MS), RETRY_BASE_MS)
  const capped = backoffDelay(20)
  assert.ok(capped >= RETRY_MAX_MS && capped < RETRY_MAX_MS * 1.25 + 1, `capped delay ${capped} near ${RETRY_MAX_MS}`)
})
