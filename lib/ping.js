/**
 * hole ping <device> — DHT reachability check with round-trip latency.
 *
 * Opens a DHT connection to the announced service, measures time-to-open,
 * closes. Reports status and latency (or a descriptive error).
 */
import DHT from 'hyperdht'
import { log, warn, CONNECT_TIMEOUT_MS } from './utils.js'
import { loadRegistry } from './registry.js'

function resolveTarget (target) {
  if (/^[0-9a-f]{64}$/i.test(target)) {
    return { key: target, source: 'raw key', device: null }
  }
  const reg  = loadRegistry()
  const dev  = reg[target]
  if (!dev) {
    const names = Object.keys(reg)
    const hint  = names.length ? `Known: ${names.join(', ')}` : 'No devices registered.'
    throw new Error(`Unknown device "${target}". ${hint}`)
  }
  return { key: dev.key, source: 'registry', device: dev }
}

function hintForStatus (status, relay) {
  const relayHint = relay
    ? `Relay configured (${relay}); verify both sides use the same reachable relay.`
    : 'If both sides are behind strict NAT/CGNAT, try --relay <host:port>.'
  const hints = {
    PEER_CONNECTION_FAILED: `The service key was found but no announced peer accepted the connection. Is hole up running? ${relayHint}`,
    PEER_NOT_FOUND: `No peer announced this key on HyperDHT. Is hole up running on the remote machine? ${relayHint}`,
    HOLEPUNCH_ABORTED: `NAT traversal failed. ${relayHint}`,
    HOLEPUNCH_TIMEOUT: `Hole punch timed out. Check outbound UDP/firewall rules. ${relayHint}`,
    ETIMEDOUT: `Network timeout. Check connectivity and firewall rules. ${relayHint}`,
    ECONNREFUSED: 'Connection was refused by the remote DHT node.'
  }
  return hints[status] ?? null
}

// ---------------------------------------------------------------------------
// ping({ target, count, relay })
//   Pings `count` times, reports per-attempt latency, mean, and packet loss.
// ---------------------------------------------------------------------------
export async function ping ({ target, count = 4, relay }) {
  let resolved
  try { resolved = resolveTarget(target) } catch (e) { console.error(`\nError: ${e.message}\n`); process.exit(1) }
  const hexKey = resolved.key

  const serverPubKey = Buffer.from(hexKey, 'hex')
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  console.log(`\nPinging ${target} (${hexKey.slice(0, 12)}...) — ${count} attempts\n`)
  console.log(`  source : ${resolved.source}`)
  if (resolved.device?.host) console.log(`  host   : ${resolved.device.host}`)
  console.log(`  relay  : ${relay || 'default HyperDHT bootstrap'}`)
  const svcs = Object.keys(resolved.device?.services ?? {})
  if (svcs.length) console.log(`  services: ${svcs.join(', ')}`)
  console.log('')

  const results = []

  for (let i = 1; i <= count; i++) {
    const t0   = Date.now()
    let status = 'timeout'
    let ms     = null

    await new Promise(resolve => {
      const conn  = dht.connect(serverPubKey)
      const timer = setTimeout(() => { conn.destroy(); resolve() }, CONNECT_TIMEOUT_MS)

      conn.once('open', () => {
        clearTimeout(timer)
        ms     = Date.now() - t0
        status = 'ok'
        conn.destroy()
        resolve()
      })

      conn.once('error', (e) => {
        clearTimeout(timer)
        ms     = Date.now() - t0
        status = e.code ?? 'error'
        conn.destroy()
        resolve()
      })
    })

    results.push({ i, status, ms })

    if (status === 'ok') {
      console.log(`  seq=${i}  status=UP      latency=${ms}ms`)
    } else {
      console.log(`  seq=${i}  status=DOWN    reason=${status}  elapsed=${ms ?? '?'}ms`)
    }

    if (i < count) await new Promise(r => setTimeout(r, 800))
  }

  await dht.destroy()

  const ok      = results.filter(r => r.status === 'ok')
  const loss    = Math.round(((count - ok.length) / count) * 100)
  const latencies = ok.map(r => r.ms)
  const mean    = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null
  const min     = latencies.length ? Math.min(...latencies) : null
  const max     = latencies.length ? Math.max(...latencies) : null

  console.log('')
  console.log(`--- ${target} ping statistics ---`)
  console.log(`${count} probes sent, ${ok.length} received, ${loss}% packet loss`)
  if (mean !== null) {
    console.log(`Round-trip: min=${min}ms  avg=${mean}ms  max=${max}ms`)
  } else {
    const firstStatus = results.find(r => r.status !== 'ok')?.status
    const hint = firstStatus ? hintForStatus(firstStatus, relay) : null
    if (hint) console.log(`Hint: ${hint}`)
  }
  console.log('')
}

// ---------------------------------------------------------------------------
// pingOne({ target, relay })
//   Returns { online: true, ms } or { online: false, error }
//   Silent, used by `hole list --ping`.
// ---------------------------------------------------------------------------
export async function pingOne ({ target, relay }) {
  let resolved
  try { resolved = resolveTarget(target) } catch (e) { return { online: false, error: e.message } }
  const hexKey = resolved.key

  const serverPubKey = Buffer.from(hexKey, 'hex')
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  const t0 = Date.now()
  let result

  await new Promise(resolve => {
    const conn  = dht.connect(serverPubKey)
    const timer = setTimeout(() => { conn.destroy(); resolve() }, 8000)

    conn.once('open', () => {
      clearTimeout(timer)
      result = { online: true, ms: Date.now() - t0 }
      conn.destroy()
      resolve()
    })

    conn.once('error', (e) => {
      clearTimeout(timer)
      result = { online: false, error: e.code ?? 'error' }
      conn.destroy()
      resolve()
    })
  })

  await dht.destroy()
  return result || { online: false, error: 'timeout' }
}
