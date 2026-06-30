import crypto from 'crypto'
import DHT from 'hyperdht'
import { addDevice } from './registry.js'
import { loadOrCreateKeyPair } from './identity.js'
import { hostname, normalizeRelayAddress, normalizePort } from './utils.js'

// 256 words — exactly 2^8 so bytes[n] indexes without modulo bias.
const WORDS = [
  'acorn', 'alder', 'amber', 'apex', 'arc', 'arch', 'ash', 'aspen', 'atlas', 'atom', 'axle', 'azure',
  'bay', 'beam', 'birch', 'blaze', 'bloom', 'blue', 'bluff', 'bold', 'bolt', 'brave', 'brine', 'bronze', 'brook', 'brush', 'byte',
  'cable', 'calm', 'canyon', 'cape', 'cave', 'cedar', 'chalk', 'char', 'chip', 'chord', 'chrome', 'cinder', 'cliff', 'cloud', 'cobalt', 'coil', 'comet', 'copper', 'coral', 'core', 'cove', 'creek', 'crest', 'curl',
  'dale', 'dawn', 'delta', 'dome', 'drift', 'drum', 'dune', 'dusk', 'dust',
  'ebb', 'echo', 'edge', 'elder', 'elm', 'ember', 'epoch',
  'fade', 'fawn', 'fern', 'fiber', 'field', 'fir', 'fjord', 'flame', 'flint', 'flock', 'flow', 'flux', 'foam', 'fog', 'fold', 'forest', 'frost',
  'gale', 'gate', 'gem', 'glen', 'glow', 'gold', 'gorge', 'grain', 'grass', 'grid', 'grove', 'gulf', 'gust',
  'halo', 'harbor', 'haze', 'hazel', 'heath', 'helm', 'hill', 'hinge', 'hollow', 'hub', 'hue',
  'indigo', 'iris', 'ivory',
  'jade', 'jolt', 'juniper',
  'kelp', 'kite', 'knot',
  'lace', 'lagoon', 'lake', 'larch', 'lava', 'leaf', 'ledge', 'lens', 'lily', 'lime', 'link', 'loch', 'loft', 'loop', 'lunar',
  'maple', 'marsh', 'maze', 'mesa', 'mesh', 'mint', 'mire', 'mist', 'moon', 'moor', 'moss', 'mote', 'mound',
  'node', 'notch', 'nova', 'null',
  'oak', 'olive', 'opal', 'orbit',
  'palm', 'peak', 'peat', 'pearl', 'petal', 'pine', 'pixel', 'plain', 'plum', 'pool', 'pore', 'port', 'prairie', 'prism', 'probe', 'pulse',
  'quartz',
  'rain', 'rapid', 'ray', 'reef', 'relay', 'ridge', 'rift', 'rim', 'ring', 'rime', 'rise', 'river', 'rock', 'root', 'rose', 'ruby', 'rush', 'rust',
  'sage', 'salt', 'sand', 'sap', 'scale', 'sea', 'seal', 'seep', 'shade', 'shard', 'shore', 'signal', 'silver', 'silt', 'skew', 'sky', 'slab', 'slate', 'sleet', 'slope', 'smoke', 'snow', 'soil', 'solar', 'soot', 'spark', 'spin', 'spring', 'spruce', 'spur', 'stack', 'star', 'steel', 'stem', 'stone', 'storm', 'stream', 'summit', 'surge', 'swamp',
  'tarn', 'teal', 'thorn', 'thread', 'tick', 'tide', 'timber', 'trace', 'trail', 'trunk', 'tube', 'tundra',
  'umbra',
  'vale', 'vault', 'veil', 'vent', 'violet', 'volt',
  'wake', 'wave', 'wheat', 'willow', 'wind', 'wire', 'wood',
  'zephyr', 'zone'
]

function inviteSeed (code) {
  return crypto.createHash('sha256')
    .update('hole-invite:v1:')
    .update(code)
    .digest()
}

export function createInviteCode () {
  const bytes  = crypto.randomBytes(6)
  const first  = WORDS[bytes[0]]               // 256 words → direct index, no modulo bias
  const second = WORDS[bytes[1]]
  const third  = WORDS[bytes[2]]
  const digits = (bytes.readUIntBE(3, 3) % 10000).toString().padStart(4, '0')
  return `${first}-${second}-${third}-${digits}`
}

export function isInviteCode (code) {
  return /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/.test(code)
}

function keyPairForCode (code) {
  if (!isInviteCode(code)) {
    throw new Error('Invite code must look like blue-river-cedar-4821')
  }
  return DHT.keyPair(inviteSeed(code))
}

const INVITE_RETRYABLE = new Set([
  'PEER_NOT_FOUND',
  'PEER_CONNECTION_FAILED',
  'HOLEPUNCH_TIMEOUT',
  'HOLEPUNCH_ABORTED',
  'ETIMEDOUT',
  'INVITE_ATTEMPT_TIMEOUT'
])

async function readInvitePayload (dht, inviteKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = dht.connect(inviteKey)
    let out = ''
    let done = false
    let timer
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(value)
    }
    timer = setTimeout(() => {
      conn.destroy()
      const err = new Error('Invite attempt timed out')
      err.code = 'INVITE_ATTEMPT_TIMEOUT'
      finish(reject, err)
    }, timeoutMs)

    conn.on('data', (chunk) => { out += String(chunk) })
    conn.once('end', () => finish(resolve, out))
    conn.once('close', () => finish(resolve, out))
    conn.once('error', (e) => finish(reject, e))
  })
}

export async function invite ({
  name = null,
  relay = null,
  user = null,
  ttlMs = 10 * 60 * 1000,
  code = createInviteCode()
} = {}) {
  relay = normalizeRelayAddress(relay)
  ttlMs = normalizePort(String(Math.ceil(ttlMs / 1000)), '--ttl') * 1000

  const master = loadOrCreateKeyPair()
  const displayName = name ?? hostname()
  const key = master.publicKey.toString('hex')
  const keyPair = keyPairForCode(code)
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  const payload = JSON.stringify({
    version: 1,
    name: displayName,
    key,
    host: hostname(),
    relay: relay || undefined,
    user: user || undefined,
    services: { ssh: key }
  }) + '\n'

  const server = dht.createServer((conn) => {
    conn.end(payload)
    setTimeout(async () => {
      await close()
      process.exit(0)
    }, 50).unref()
  })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await server.close() } catch {}
    try { await dht.destroy() } catch {}
  }

  await server.listen(keyPair)

  const timeout = setTimeout(async () => {
    console.error('\nInvite expired without an accept.\n')
    await close()
    process.exit(1)
  }, ttlMs)
  timeout.unref()

  console.log('\n=== Hole Invite ===')
  console.log(`Name   : ${displayName}`)
  console.log(`Key    : ${key.slice(0, 16)}...`)
  if (relay) console.log(`Relay  : ${relay}`)
  console.log(`Expires: ${Math.round(ttlMs / 60000)} minute(s)`)
  console.log('')
  console.log(`Invite code: ${code}`)
  console.log('')
  console.log('On the other machine:')
  console.log(`  hole accept ${code}${relay ? ` --relay ${relay}` : ''}`)
  console.log('')
  console.log('Waiting for one accept...\n')

  process.on('SIGINT', async () => {
    await close()
    process.exit(0)
  })
}

export async function accept ({ code, name = null, relay = null, user = null, timeoutMs = 30000 } = {}) {
  if (!code) throw new Error('Usage: hole accept <invite-code> [--name N] [--relay host:port]')
  relay = normalizeRelayAddress(relay)
  const inviteKey = keyPairForCode(code).publicKey
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  let data
  let lastErr = null
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const attemptTimeout = Math.min(8000, Math.max(1000, remaining))
      try {
        data = await readInvitePayload(dht, inviteKey, attemptTimeout)
        break
      } catch (e) {
        lastErr = e
        const code = e?.code ?? 'error'
        if (!INVITE_RETRYABLE.has(code)) throw e
        if (Date.now() + 1200 >= deadline) break
        await new Promise(resolve => setTimeout(resolve, 1200))
      }
    }
    if (!data) {
      const reason = lastErr?.code ? ` (${lastErr.code})` : ''
      throw new Error(`Invite timed out${reason}. Is \`hole invite\` still running, and are both sides using the same relay?`)
    }
  } finally {
    await dht.destroy()
  }

  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    throw new Error('Invite returned invalid data')
  }
  if (payload.version !== 1 || !/^[0-9a-f]{64}$/i.test(payload.key)) {
    throw new Error('Invite returned an invalid device key')
  }

  const deviceName = name ?? payload.name
  if (!deviceName) throw new Error('Invite did not include a device name; pass --name <name>')

  addDevice(deviceName, payload.key, {
    host: payload.host ?? deviceName,
    relay: relay ?? payload.relay ?? undefined,
    user: user ?? payload.user ?? undefined,
    services: payload.services ?? { ssh: payload.key }
  })

  console.log(`Added "${deviceName}" from invite → ${payload.key.slice(0, 16)}...`)
  if (relay ?? payload.relay) console.log(`Relay: ${relay ?? payload.relay}`)
  console.log(`Try: hole ssh ${deviceName}`)
}
