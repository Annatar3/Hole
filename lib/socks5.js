// ---------------------------------------------------------------------------
// Minimal SOCKS5 parser/builder — just enough for CONNECT (RFC 1928).
// No auth negotiation beyond "no auth", no BIND, no UDP ASSOCIATE.
// ---------------------------------------------------------------------------

export const REP = {
  SUCCESS:                    0x00,
  GENERAL_FAILURE:            0x01,
  CONNECTION_NOT_ALLOWED:     0x02,
  NETWORK_UNREACHABLE:        0x03,
  HOST_UNREACHABLE:           0x04,
  CONNECTION_REFUSED:         0x05,
  COMMAND_NOT_SUPPORTED:      0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08
}

// Parses the initial greeting: VER(1) NMETHODS(1) METHODS(n)
// Returns { length } once enough bytes have arrived, or null if incomplete.
export function parseGreeting (buf) {
  if (buf.length < 2) return null
  if (buf[0] !== 0x05) throw new Error('Unsupported SOCKS version (expected 5)')
  const nmethods = buf[1]
  const total = 2 + nmethods
  if (buf.length < total) return null
  return { length: total }
}

export function buildMethodReply (method = 0x00) {
  return Buffer.from([0x05, method])
}

// Parses a CONNECT request: VER(1) CMD(1) RSV(1) ATYP(1) ADDR(n) PORT(2)
// Returns { host, port, length } once enough bytes have arrived, or null if incomplete.
export function parseConnectRequest (buf) {
  if (buf.length < 4) return null
  if (buf[0] !== 0x05) throw new Error('Unsupported SOCKS version (expected 5)')
  if (buf[1] !== 0x01) throw new Error('Only the CONNECT command is supported')

  const atyp = buf[3]
  let host, offset

  if (atyp === 0x01) { // IPv4
    if (buf.length < 4 + 4 + 2) return null
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
    offset = 4 + 4
  } else if (atyp === 0x03) { // domain name
    if (buf.length < 5) return null
    const len = buf[4]
    if (buf.length < 5 + len + 2) return null
    host = buf.slice(5, 5 + len).toString('ascii')
    offset = 5 + len
  } else if (atyp === 0x04) { // IPv6
    if (buf.length < 4 + 16 + 2) return null
    const parts = []
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
    host = parts.join(':')
    offset = 4 + 16
  } else {
    throw new Error('Unsupported SOCKS address type')
  }

  const port = buf.readUInt16BE(offset)
  return { host, port, length: offset + 2 }
}

// Reply: VER(1) REP(1) RSV(1) ATYP(1) BNDADDR(4) BNDPORT(2)
// We don't have a real bind address (the far side dials on our behalf), so
// echo 0.0.0.0:0 — standard practice for proxies that don't expose bind info.
export function buildConnectReply (rep = REP.SUCCESS) {
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}
