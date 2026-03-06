import DHT from 'hyperdht'
import { log, die } from './utils.js'

// ---------------------------------------------------------------------------
// run({ port })
// Runs a DHT bootstrap + relay node. Deploy on a VPS with a public IP.
// ---------------------------------------------------------------------------
export async function run ({ port = 49737 } = {}) {
  let node
  try {
    node = DHT.bootstrapper(port, '0.0.0.0')
    await node.ready()
  } catch (e) {
    die(`Could not start relay on port ${port}: ${e.message}`)
  }

  const addr = node.address()

  console.log('=== Hole Relay ===')
  console.log(`UDP port : ${addr.port}`)
  console.log('')
  console.log('Share this with agent and client (replace <ip> with this machine\'s public IP):')
  console.log(`  hole agent --relay <ip>:${addr.port}`)
  console.log(`  hole client <name|key> --relay <ip>:${addr.port}`)
  console.log('')
  log('Relay ready.\n')

  process.on('SIGINT', async () => {
    log('Shutting down...')
    await node.destroy()
    process.exit(0)
  })
}
