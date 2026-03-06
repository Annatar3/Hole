import net from 'net'
import dgram from 'dgram'
import DHT from 'hyperdht'
import { log, warn } from './utils.js'

function checkTcp (host, port, timeout = 3000) {
  return new Promise(resolve => {
    const sock = net.connect(port, host)
    let done = false
    const finish = (ok, msg) => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ ok, msg })
    }
    sock.once('connect', () => finish(true, 'connected'))
    sock.once('error', (e) => finish(false, e.message))
    sock.setTimeout(timeout, () => finish(false, 'timeout'))
  })
}

function checkUdpBind () {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4')
    sock.once('error', (e) => {
      sock.close()
      resolve({ ok: false, msg: e.message })
    })
    sock.bind(0, '0.0.0.0', () => {
      const addr = sock.address()
      sock.close()
      resolve({ ok: true, msg: `bound to ${addr.address}:${addr.port}` })
    })
  })
}

async function checkDht () {
  const dht = new DHT()
  try {
    await dht.ready()
    const nodeId = dht.defaultKeyPair.publicKey.toString('hex').slice(0, 16)
    await dht.destroy()
    return { ok: true, msg: `bootstrapped (node ${nodeId}...)` }
  } catch (e) {
    try { await dht.destroy() } catch {}
    return { ok: false, msg: e.message }
  }
}

export async function run () {
  console.log('\n=== hole doctor ===\n')

  // 1. Basic TCP connectivity to a well-known endpoint (HTTPS)
  console.log('- TCP outbound (443) ...')
  const tcp = await checkTcp('1.1.1.1', 443)
  console.log(`  ${tcp.ok ? 'OK' : 'FAIL'}: ${tcp.msg}`)

  // 2. UDP bind (local) – ensures no local restriction on UDP sockets
  console.log('- UDP socket bind ...')
  const udp = await checkUdpBind()
  console.log(`  ${udp.ok ? 'OK' : 'FAIL'}: ${udp.msg}`)

  // 3. HyperDHT bootstrap
  console.log('- HyperDHT bootstrap ...')
  const dht = await checkDht()
  console.log(`  ${dht.ok ? 'OK' : 'FAIL'}: ${dht.msg}`)

  console.log('\nSummary:')
  if (!tcp.ok) warn('TCP 443 check failed — outbound TCP may be blocked by your network.')
  if (!udp.ok) warn('UDP bind failed — local firewall or kernel settings may block UDP.')
  if (!dht.ok) warn('HyperDHT could not bootstrap — check outbound UDP and DNS.')

  if (tcp.ok && udp.ok && dht.ok) {
    log('Environment looks good for Hole (agent/client should work).')
  } else {
    warn('Some checks failed. Hole may need relay mode or firewall changes.')
  }
}

