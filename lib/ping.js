/**
 * hole ping <device> — DHT reachability check with round-trip latency.
 *
 * Opens a DHT connection to the announced service, measures time-to-open,
 * closes. Reports status and latency (or a descriptive error).
 */
import DHT from 'hyperdht'
import { log, warn, CONNECT_TIMEOUT_MS } from './utils.js'
import { loadRegistry } from './registry.js'

function resolveKey (target) {
  if (/^[0-9a-f]{64}$/i.test(target)) return target
  const reg  = loadRegistry()
  const dev  = reg[target]
  if (!dev) {
    const names = Object.keys(reg)
    const hint  = names.length ? `Known: ${names.join(', ')}` : 'No devices registered.'
    throw new Error(`Unknown device "${target}". ${hint}`)
  }
  return dev.key
}

// ---------------------------------------------------------------------------
// ping({ target, count, relay })
//   Pings `count` times, reports per-attempt latency, mean, and packet loss.
// ---------------------------------------------------------------------------
export async function ping ({ target, count = 4, relay }) {
  let hexKey
  try { hexKey = resolveKey(target) } catch (e) { console.error(`\nError: ${e.message}\n`); process.exit(1) }

  const serverPubKey = Buffer.from(hexKey, 'hex')
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  console.log(`\nPinging ${target} (${hexKey.slice(0, 12)}...) — ${count} attempts\n`)

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
  }
  console.log('')
}

// ---------------------------------------------------------------------------
// pingOne({ target, relay })
//   Returns { online: true, ms } or { online: false, error }
//   Silent, used by `hole list --ping`.
// ---------------------------------------------------------------------------
export async function pingOne ({ target, relay }) {
  let hexKey
  try { hexKey = resolveKey(target) } catch (e) { return { online: false, error: e.message } }

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
