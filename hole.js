#!/usr/bin/env node
/**
 * Hole — P2P SSH tunnel via HyperDHT. No port forwarding required.
 */
import { parseArgs, die } from './lib/utils.js'
import { addDevice, removeDevice, listDevices, holeDir } from './lib/registry.js'

const [,, cmd, ...rest] = process.argv
const { flags, positional } = parseArgs(rest)

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
const USAGE = `
Hole — P2P SSH tunnel over HyperDHT. No port forwarding. No VPN.

Usage:
  hole agent              Start the tunnel agent on this host
  hole client <target>    Connect to a remote agent
  hole relay              Start a relay node (run on a VPS for CGNAT support)
  hole list               List known devices
  hole add <name> <key>   Add a device to the local registry
  hole remove <name>      Remove a device from the registry
  hole status             Show current config and registry path

Options for agent:
  --name   <name>         Register this agent with a friendly name
  --relay  <host:port>    Use a custom relay node
  --port   <n>            SSH port on this host (default: 22)

Options for client:
  --port   <n>            Local proxy port (default: 2222)
  --relay  <host:port>    Use a custom relay node

Options for relay:
  --port   <n>            UDP port to listen on (default: 49737)

Examples:
  # On the remote host (Windows, Linux, anywhere):
  hole agent --name my-pc

  # On your machine — add the device then connect:
  hole add my-pc <64-char-key>
  hole client my-pc
  ssh -p 2222 user@localhost

  # Or connect directly with a raw key:
  hole client ca425d44...

  # For CGNAT / mobile hotspot — use a relay:
  hole relay                                    # on a VPS
  hole agent --name my-pc --relay 1.2.3.4:49737
  hole client my-pc --relay 1.2.3.4:49737

Config & keys: ${(await import('./lib/registry.js').then(m => m.holeDir()))}
`.trim()

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
switch (cmd) {

  case 'agent': {
    const { run } = await import('./lib/agent.js')
    await run({
      name:    flags.name   ?? null,
      relay:   flags.relay  ?? null,
      sshHost: process.env.SSH_HOST ?? '127.0.0.1',
      sshPort: parseInt(flags.port ?? process.env.SSH_PORT ?? '22', 10)
    })
    break
  }

  case 'client': {
    const target = positional[0]
    if (!target) die('Usage: hole client <name|key> [--port 2222] [--relay host:port]')
    const { run } = await import('./lib/client.js')
    await run({
      target,
      port:  parseInt(flags.port ?? '2222', 10),
      relay: flags.relay ?? null
    })
    break
  }

  case 'relay': {
    const { run } = await import('./lib/relay.js')
    await run({ port: parseInt(flags.port ?? '49737', 10) })
    break
  }

  case 'list': {
    const devices = listDevices()
    const names = Object.keys(devices)
    if (!names.length) {
      console.log('No devices registered.')
      console.log('Add one with: hole add <name> <64-char-key>')
    } else {
      console.log(`\n${'NAME'.padEnd(20)} ${'KEY (first 16 chars)'.padEnd(20)} ${'HOST'.padEnd(20)} LAST SEEN`)
      console.log('─'.repeat(85))
      for (const [name, d] of Object.entries(devices)) {
        const key  = (d.key ?? '').slice(0, 16) + '...'
        const host = (d.host ?? '').slice(0, 18)
        const seen = d.lastSeen ? d.lastSeen.slice(0, 16).replace('T', ' ') : 'never'
        console.log(`${name.padEnd(20)} ${key.padEnd(20)} ${host.padEnd(20)} ${seen}`)
      }
      console.log('')
    }
    break
  }

  case 'add': {
    const [name, key] = positional
    if (!name || !key) die('Usage: hole add <name> <64-char-hex-key>')
    if (!/^[0-9a-f]{64}$/i.test(key)) die('Key must be a 64-character hex string.')
    addDevice(name, key)
    console.log(`Added "${name}" → ${key.slice(0, 16)}...`)
    break
  }

  case 'remove': {
    const [name] = positional
    if (!name) die('Usage: hole remove <name>')
    if (removeDevice(name)) {
      console.log(`Removed "${name}".`)
    } else {
      die(`Device "${name}" not found.`)
    }
    break
  }

  case 'status': {
    const { holeDir, keypairPath, loadRegistry } = await import('./lib/registry.js')
    const { existsSync } = await import('fs')
    const dir = holeDir()
    const kp  = keypairPath()
    const reg = loadRegistry()
    console.log('\n=== Hole Status ===')
    console.log(`Config dir : ${dir}`)
    console.log(`Keypair    : ${kp} (${existsSync(kp) ? 'exists' : 'not generated yet'})`)
    console.log(`Devices    : ${Object.keys(reg).length} registered`)
    console.log('')
    break
  }

  case undefined:
  case '--help':
  case 'help':
    console.log(USAGE)
    break

  default:
    console.error(`Unknown command: ${cmd}`)
    console.error('Run `hole help` for usage.')
    process.exit(1)
}
