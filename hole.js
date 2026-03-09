#!/usr/bin/env node
/**
 * Hole — P2P SSH tunnel via HyperDHT. No port forwarding required.
 */
import { parseArgs, die } from './lib/utils.js'
import { addDevice, removeDevice, listDevices, holeDir, keypairPath, loadRegistry } from './lib/registry.js'
import { aclAdd, aclRemove, aclList } from './lib/acl.js'
import { existsSync } from 'fs'

const [,, cmd, ...rest] = process.argv
const { flags, positional } = parseArgs(rest)

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
const USAGE = `
Hole — P2P SSH tunnel over HyperDHT. No port forwarding. No VPN.

Usage:
  hole agent                   Start the tunnel agent on this host
  hole ssh <target> [user]     SSH into a remote agent (tunnel + ssh in one command)
  hole exec <target> <user>    Run a single command on a remote host (tunnel + ssh -c)
  hole copy <src> <dest>       Copy files to/from a remote host via scp
  hole ping <target>           Check if a remote agent is reachable (DHT latency)
  hole client <target> [svc]   Open a local tunnel port (manual/scripting use)
  hole relay                   Start a relay node (for CGNAT / mobile hotspot)
  hole install-service         Install agent as a system service (auto-start on boot)
  hole uninstall-service       Remove the system service

  hole list                    List known devices
  hole add <name> <key>        Add a device to the registry
  hole remove <name>           Remove a device from the registry
  hole status                  Show config paths and registry summary
  hole audit                   Show recent connection audit log

  hole acl list                List allowed client keys (empty = all allowed)
  hole acl add <name> <key>    Allow a specific client key to connect
  hole acl remove <name>       Remove a client key from the ACL

  hole doctor                  Run network diagnostics (TCP, UDP, HyperDHT)

Options for agent:
  --name    <name>             Register this agent with a friendly name
  --relay   <host:port>        Use a custom relay node
  --port    <n>                SSH port on this host (default: 22)
  --forward <svc:port>         Add a named forward, e.g. --forward rdp:3389

Options for ssh:
  --user    <name>             SSH username (default: current OS user)
  --relay   <host:port>        Use a custom relay node
  -- <args>                    Extra args passed to ssh, e.g. -- -L 8080:localhost:3000

Options for exec:
  -- <cmd>                     Command to run, e.g. hole exec server user -- ls /

Options for copy:
  Remote paths use device:/path syntax, e.g.:
    hole copy file.txt my-server:/tmp/ user
    hole copy my-server:/tmp/file.txt . user

Options for ping:
  --count   <n>                Number of probes (default: 4)
  --relay   <host:port>        Use a custom relay node

Options for audit:
  --tail    <n>                Show last N entries (default: 50)

Options for client:
  --port    <n>                Local proxy port (default: 2222)
  --relay   <host:port>        Use a custom relay node

Options for relay:
  --host    <ip>               Public IPv4 address to bind as relay
  --port    <n>                UDP port to listen on (default: 49737)

Options for install-service:
  --name    <name>             Device name to pass to agent
  --relay   <host:port>        Relay to pass to agent

Examples:
  # Register an agent, then use it:
  hole agent --name my-server              # on the server
  hole add my-server <printed-key>         # on your laptop
  hole ssh my-server alice                 # SSH in
  hole exec my-server alice -- uptime      # run one command
  hole copy file.txt my-server:/tmp/ alice # upload a file
  hole copy my-server:/var/log/app.log . alice  # download a file
  hole ping my-server                      # check if it's up

  # Multiple services on one host:
  hole agent --name my-pc --forward rdp:3389 --forward web:3000
  hole client my-pc rdp   # opens local port for RDP client
  hole client my-pc web   # opens local port for browser

  # Lock down who can connect:
  hole acl add laptop <my-laptop-public-key>
  hole agent --name my-pc     # now only 'laptop' can connect

  # Install as a service (auto-start on boot):
  hole install-service --name my-pc

  # Audit recent connections:
  hole audit
  hole audit --tail 20

Config: ${holeDir()}
`.trim()

// ---------------------------------------------------------------------------
// Parse --forward flags → array of { name, host, port }
// --forward rdp:3389  or  --forward web:127.0.0.1:3000
// ---------------------------------------------------------------------------
function parseForwards (rawForwards) {
  if (!rawForwards) return []
  const list = Array.isArray(rawForwards) ? rawForwards : [rawForwards]
  return list.map(raw => {
    const parts = raw.split(':')
    if (parts.length === 2) {
      // name:port
      return { name: parts[0], host: '127.0.0.1', port: parseInt(parts[1], 10) }
    }
    if (parts.length === 3) {
      // name:host:port
      return { name: parts[0], host: parts[1], port: parseInt(parts[2], 10) }
    }
    die(`Invalid --forward value "${raw}". Use: name:port or name:host:port`)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  switch (cmd) {

    // ── agent ──────────────────────────────────────────────────────────────
    case 'agent': {
      const { run } = await import('./lib/agent.js')
      await run({
        name:     flags.name    ?? null,
        relay:    flags.relay   ?? null,
        forwards: parseForwards(flags.forward),
        sshHost:  process.env.SSH_HOST ?? '127.0.0.1',
        sshPort:  parseInt(flags.port ?? process.env.SSH_PORT ?? '22', 10)
      })
      break
    }

    // ── ssh ────────────────────────────────────────────────────────────────
    case 'ssh': {
      const target = positional[0]
      const user   = positional[1] ?? flags.user ?? null
      if (!target) die('Usage: hole ssh <name|key> [user] [--relay host:port] [-- extra-ssh-args]')
      // Everything after `--` is forwarded directly to ssh
      const ddash    = process.argv.indexOf('--')
      const sshArgs  = ddash !== -1 ? process.argv.slice(ddash + 1) : []
      const { ssh } = await import('./lib/client.js')
      await ssh({
        target,
        user,
        relay:   flags.relay ?? null,
        sshArgs
      })
      break
    }

    // ── ping ───────────────────────────────────────────────────────────────
    case 'ping': {
      const target = positional[0]
      if (!target) die('Usage: hole ping <name|key> [--count 4] [--relay host:port]')
      const { ping } = await import('./lib/ping.js')
      await ping({
        target,
        count: parseInt(flags.count ?? '4', 10),
        relay: flags.relay ?? null
      })
      break
    }

    // ── exec ───────────────────────────────────────────────────────────────
    case 'exec': {
      const target = positional[0]
      const user   = positional[1] ?? flags.user ?? null
      if (!target) die('Usage: hole exec <name|key> <user> [--relay host:port] -- <command>')
      const ddash = process.argv.indexOf('--')
      const cmd_  = ddash !== -1 ? process.argv.slice(ddash + 1) : []
      const { exec } = await import('./lib/client.js')
      await exec({ target, user, relay: flags.relay ?? null, cmd: cmd_ })
      break
    }

    // ── copy ───────────────────────────────────────────────────────────────
    case 'copy': {
      // hole copy <src> <dest> [user]
      // remote paths: device:/path
      const src  = positional[0]
      const dest = positional[1]
      const user = positional[2] ?? flags.user ?? null
      if (!src || !dest) die('Usage: hole copy <src> <dest> [user]\n  Remote: device:/path  e.g. hole copy file.txt my-server:/tmp/ alice')
      // Derive target device name from whichever arg is remote (device:/path)
      const REMOTE_RE = /^([^/:\\]+):/
      const srcDev  = src.match(REMOTE_RE)?.[1]
      const destDev = dest.match(REMOTE_RE)?.[1]
      const target  = srcDev ?? destDev
      if (!target) die('One of src or dest must be a remote path in the form device:/path')
      const { copy } = await import('./lib/client.js')
      await copy({ target, src, dest, user, relay: flags.relay ?? null })
      break
    }

    // ── audit ──────────────────────────────────────────────────────────────
    case 'audit': {
      const { printAuditLog } = await import('./lib/audit.js')
      printAuditLog({ tail: parseInt(flags.tail ?? '50', 10) })
      break
    }

    // ── client ─────────────────────────────────────────────────────────────
    case 'client': {
      const target  = positional[0]
      const service = positional[1] ?? null   // optional: ssh | rdp | web | ...
      if (!target) die('Usage: hole client <name|key> [service] [--port 2222] [--relay host:port]')
      const { run } = await import('./lib/client.js')
      await run({
        target,
        service,
        port:  parseInt(flags.port ?? '2222', 10),
        relay: flags.relay ?? null
      })
      break
    }

    // ── relay ──────────────────────────────────────────────────────────────
    case 'relay': {
      const { run } = await import('./lib/relay.js')
      await run({
        port: parseInt(flags.port ?? '49737', 10),
        host: flags.host ?? null
      })
      break
    }

    // ── doctor ───────────────────────────────────────────────────────────────
    case 'doctor': {
      const { run } = await import('./lib/doctor.js')
      await run()
      break
    }

    // ── install-service ────────────────────────────────────────────────────
    case 'install-service': {
      const { install } = await import('./lib/installer.js')
      const agentArgs = []
      if (flags.name)  agentArgs.push('--name',  flags.name)
      if (flags.relay) agentArgs.push('--relay', flags.relay)
      install(agentArgs)
      break
    }

    case 'uninstall-service': {
      const { uninstall } = await import('./lib/installer.js')
      uninstall()
      break
    }

    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      const devices = listDevices()
      const names   = Object.keys(devices)
      if (!names.length) {
        console.log('No devices registered.\nAdd one with: hole add <name> <64-char-key>')
      } else {
        console.log(`\n${'NAME'.padEnd(20)} ${'KEY (16)'.padEnd(18)} ${'HOST'.padEnd(18)} ${'SERVICES'.padEnd(22)} LAST SEEN`)
        console.log('─'.repeat(100))
        for (const [name, d] of Object.entries(devices)) {
          const key  = (d.key ?? '').slice(0, 16) + '...'
          const host = (d.host ?? '').slice(0, 16)
          const svcs = Object.keys(d.services ?? {}).join(', ') || '—'
          const seen = (d.lastSeen ?? '').slice(0, 16).replace('T', ' ') || 'never'
          console.log(`${name.padEnd(20)} ${key.padEnd(18)} ${host.padEnd(18)} ${svcs.padEnd(22)} ${seen}`)
        }
        console.log('')
      }
      break
    }

    // ── add ────────────────────────────────────────────────────────────────
    case 'add': {
      const [name, key] = positional
      if (!name || !key) die('Usage: hole add <name> <64-char-hex-key>')
      if (!/^[0-9a-f]{64}$/i.test(key)) die('Key must be a 64-character hex string.')
      addDevice(name, key)
      console.log(`Added "${name}" → ${key.slice(0, 16)}...`)
      break
    }

    // ── remove ─────────────────────────────────────────────────────────────
    case 'remove': {
      const [name] = positional
      if (!name) die('Usage: hole remove <name>')
      removeDevice(name) ? console.log(`Removed "${name}".`) : die(`Device "${name}" not found.`)
      break
    }

    // ── status ─────────────────────────────────────────────────────────────
    case 'status': {
      const dir = holeDir()
      const kp  = keypairPath()
      const reg = loadRegistry()
      console.log('\n=== Hole Status ===')
      console.log(`Config dir : ${dir}`)
      console.log(`Keypair    : ${kp} (${existsSync(kp) ? 'exists' : 'not generated'})`)
      console.log(`Devices    : ${Object.keys(reg).length} registered`)
      console.log('')
      break
    }

    // ── acl ────────────────────────────────────────────────────────────────
    case 'acl': {
      const sub = positional[0]

      if (sub === 'list') {
        const acl = aclList()
        const entries = Object.entries(acl)
        if (!entries.length) {
          console.log('ACL is empty — all clients are allowed.')
        } else {
          console.log(`\n${'NAME'.padEnd(20)} KEY`)
          console.log('─'.repeat(70))
          for (const [name, key] of entries) {
            console.log(`${name.padEnd(20)} ${key}`)
          }
          console.log('')
        }
        break
      }

      if (sub === 'add') {
        const [, name, key] = positional
        if (!name || !key) die('Usage: hole acl add <name> <64-char-key>')
        aclAdd(name, key)
        console.log(`ACL: added "${name}" → ${key.slice(0, 16)}...`)
        break
      }

      if (sub === 'remove') {
        const [, name] = positional
        if (!name) die('Usage: hole acl remove <name>')
        aclRemove(name) ? console.log(`ACL: removed "${name}".`) : die(`"${name}" not in ACL.`)
        break
      }

      die('Usage: hole acl <list|add|remove>')
    }

    // ── help ───────────────────────────────────────────────────────────────
    case undefined:
    case '--help':
    case 'help':
      console.log(USAGE)
      break

    default:
      console.error(`Unknown command: ${cmd}\nRun 'hole help' for usage.`)
      process.exit(1)
  }
}

main().catch(e => {
  console.error(`\nFatal: ${e.message}`)
  process.exit(1)
})
