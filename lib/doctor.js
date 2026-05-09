import net from 'net'
import dgram from 'dgram'
import DHT from 'hyperdht'
import { existsSync } from 'fs'
import { log, warn } from './utils.js'
import { holeDir, keypairPath, loadRegistry } from './registry.js'

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

async function checkDht ({ relay = null } = {}) {
  const dht = new DHT(relay ? { bootstrap: [relay] } : {})
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

export async function run ({ relay = null } = {}) {
  console.log('\n=== hole doctor ===\n')

  const dir = holeDir()
  const kp = keypairPath()
  const registry = loadRegistry()
  const sshHost = process.env.SSH_HOST ?? '127.0.0.1'
  const sshPort = parseInt(process.env.SSH_PORT ?? '22', 10)

  console.log('- Local config ...')
  console.log(`  OK: dir=${dir}`)
  console.log(`  ${existsSync(kp) ? 'OK' : 'WARN'}: keypair ${existsSync(kp) ? 'exists' : 'not generated yet'} (${kp})`)
  console.log(`  OK: ${Object.keys(registry).length} registered device(s)`)

  // 1. Basic TCP connectivity to a well-known endpoint (HTTPS)
  console.log('\n- TCP outbound (443) ...')
  const tcp = await checkTcp('1.1.1.1', 443)
  console.log(`  ${tcp.ok ? 'OK' : 'FAIL'}: ${tcp.msg}`)

  // 2. UDP bind (local) – ensures no local restriction on UDP sockets
  console.log('- UDP socket bind ...')
  const udp = await checkUdpBind()
  console.log(`  ${udp.ok ? 'OK' : 'FAIL'}: ${udp.msg}`)

  // 3. HyperDHT bootstrap
  console.log(`- HyperDHT bootstrap${relay ? ` via relay ${relay}` : ''} ...`)
  const dht = await checkDht({ relay })
  console.log(`  ${dht.ok ? 'OK' : 'FAIL'}: ${dht.msg}`)

  // 4. Default SSH target for `hole up`
  console.log(`- Default SSH target (${sshHost}:${sshPort}) ...`)
  const ssh = await checkTcp(sshHost, sshPort, 1500)
  console.log(`  ${ssh.ok ? 'OK' : 'WARN'}: ${ssh.ok ? 'reachable' : ssh.msg}`)

  console.log('\nSummary:')
  if (!tcp.ok) warn('TCP 443 check failed — outbound TCP may be blocked by your network.')
  if (!udp.ok) warn('UDP bind failed — local firewall or kernel settings may block UDP.')
  if (!dht.ok) {
    warn(relay
      ? `Could not bootstrap through relay ${relay} — verify UDP is open on the VPS and both sides use the same relay.`
      : 'HyperDHT could not bootstrap — check outbound UDP and DNS.')
  }
  if (!existsSync(kp)) warn('No Hole keypair yet — run `hole key` or `hole up` to create one.')
  if (!ssh.ok) warn(`Default SSH target ${sshHost}:${sshPort} is not reachable. Use SSH_HOST/SSH_PORT or --port if ` +
    '`hole up` should expose a different local service.')

  if (tcp.ok && udp.ok && dht.ok) {
    log(relay
      ? `Environment looks good for Hole with relay ${relay}. Use this same --relay on hole up and hole add.`
      : 'Environment looks good for Hole (hole up and outbound tunnels should work).')
  } else {
    warn('Some checks failed. Hole may need relay mode or firewall changes.')
  }
}

