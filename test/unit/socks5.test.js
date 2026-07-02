import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGreeting,
  parseConnectRequest,
  buildMethodReply,
  buildConnectReply,
  REP
} from '../../lib/socks5.js'

test('parseGreeting waits for the full method list before returning', () => {
  const full = Buffer.from([0x05, 0x02, 0x00, 0x02])
  assert.equal(parseGreeting(full.slice(0, 1)), null)
  assert.equal(parseGreeting(full.slice(0, 3)), null)
  assert.deepEqual(parseGreeting(full), { length: 4 })
})

test('parseGreeting rejects non-SOCKS5 versions', () => {
  assert.throws(() => parseGreeting(Buffer.from([0x04, 0x01, 0x00])), /Unsupported SOCKS version/)
})

test('buildMethodReply encodes version 5 + chosen method', () => {
  assert.deepEqual(buildMethodReply(0x00), Buffer.from([0x05, 0x00]))
})

test('parseConnectRequest handles IPv4 targets', () => {
  // VER CMD RSV ATYP 93.184.216.34 :443
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 93, 184, 216, 34, 0x01, 0xbb])
  const req = parseConnectRequest(buf)
  assert.equal(req.host, '93.184.216.34')
  assert.equal(req.port, 443)
  assert.equal(req.length, buf.length)
})

test('parseConnectRequest handles domain-name targets', () => {
  const domain = Buffer.from('example.com', 'ascii')
  const buf = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
    domain,
    Buffer.from([0x00, 0x50])
  ])
  const req = parseConnectRequest(buf)
  assert.equal(req.host, 'example.com')
  assert.equal(req.port, 80)
  assert.equal(req.length, buf.length)
})

test('parseConnectRequest returns null until enough bytes have arrived', () => {
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00])
  assert.equal(parseConnectRequest(buf), null)
})

test('parseConnectRequest reports leftover bytes are not consumed (length is exact)', () => {
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50, 0xff, 0xff])
  const req = parseConnectRequest(buf)
  assert.equal(req.length, 10)
})

test('parseConnectRequest rejects non-CONNECT commands', () => {
  const buf = Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50])
  assert.throws(() => parseConnectRequest(buf), /CONNECT/)
})

test('parseConnectRequest rejects unsupported address types', () => {
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x05, 1, 2, 3, 4, 0x00, 0x50])
  assert.throws(() => parseConnectRequest(buf), /address type/)
})

test('buildConnectReply encodes rep code with a zeroed bind address', () => {
  const reply = buildConnectReply(REP.SUCCESS)
  assert.deepEqual(reply, Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
  assert.equal(buildConnectReply(REP.HOST_UNREACHABLE)[1], REP.HOST_UNREACHABLE)
})
