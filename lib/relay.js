import DHT from 'hyperdht'
import { log, die } from './utils.js'

// ---------------------------------------------------------------------------
// run({ port, host })
// Runs a DHT bootstrap + relay node. Deploy on a VPS with a public IPv4.
// ---------------------------------------------------------------------------
export async function run ({ port = 49737, host } = {}) {
  if (!host) {
    die(
      'Relay requires an explicit public IPv4 host.\n' +
      'Example:\n' +
      '  hole relay --host 203.0.113.10 --port 49737\n'
    )
  }

  let node
  try {
    // HyperDHT/DHT bootstrapper requires a concrete, non-wildcard IPv4 host.
    node = DHT.bootstrapper(port, host)
    await node.ready()
  } catch (e) {
    die(`Could not start relay on port ${port}: ${e.message}`)
  }

  const addrHost = node.host
  const addrPort = node.port

  console.log('=== Hole Relay ===')
  console.log(`Host    : ${addrHost}`)
  console.log(`UDP port: ${addrPort}`)
  console.log('')
  console.log('Share this with machines and connectors:')
  console.log(`  hole up --relay ${addrHost}:${addrPort}`)
  console.log(`  hole add <name> <key> --relay ${addrHost}:${addrPort}`)
  console.log(`  hole tunnel <name|key> --relay ${addrHost}:${addrPort}`)
  console.log('')
  log('Relay ready.\n')

  process.on('SIGINT', async () => {
    log('Shutting down...')
    await node.destroy()
    process.exit(0)
  })
}
