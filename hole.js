#!/usr/bin/env node
/**
 * Hole — P2P service access via HyperDHT. No port forwarding required.
 */
import { parseArgs, die, normalizeRelayAddress, normalizePort } from './lib/utils.js'
import { addDevice, removeDevice, listDevices, holeDir, keypairPath, loadRegistry } from './lib/registry.js'
import { aclAdd, aclRemove, aclList } from './lib/acl.js'
import { existsSync } from 'fs'

const COMMAND_ALIASES = {
  up: 'agent',
  tunnel: 'client'
}

const [,, rawCmd, ...rest] = process.argv
const cmd = COMMAND_ALIASES[rawCmd] ?? rawCmd
const { flags, positional } = parseArgs(rest)

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
const USAGE = `
Hole — P2P service access over HyperDHT. No port forwarding. No VPN.

Usage:
  hole up                      Announce this machine's services on HyperDHT
  hole ssh <target> [user]     SSH over a Holepunch tunnel
  hole exec <target> <user>    Run a single command on a remote host (tunnel + ssh -c)
  hole copy <src> <dest>       Copy files to/from a remote host via scp
  hole ping <target>           Check if a remote service is reachable (DHT latency)
  hole tunnel <target> [svc]   Open a local port to a remote service
  hole relay --host <ip>       Start a relay node (for CGNAT / mobile hotspot)
  hole invite                  Create a short-lived pairing invite
  hole accept <code>           Accept a pairing invite and add the device
  hole share <file>            Send a file via a short one-time code (no pre-registration)
  hole receive <code>          Receive a file from a \`hole share\` sender
  hole install-service         Install "hole up" as a system service
  hole uninstall-service       Remove the system service
  hole completion              Generate shell completion script (bash)

  hole list                    List known devices
  hole add <name> <key>        Add a device to the registry
  hole remove <name>           Remove a device from the registry
  hole status                  Show config paths and registry summary
  hole key                     Show this machine's Hole public key
  hole services [device]       Show registered service keys
  hole audit                   Show recent connection audit log
  hole dashboard               Open the web fleet dashboard (localhost:4321)

  hole acl list                List allowed client keys (empty = all allowed)
  hole acl add <name> <key>    Allow a specific client key to connect
  hole acl remove <name>       Remove a client key from the ACL

  hole doctor                  Run network diagnostics (TCP, UDP, HyperDHT)

Options for up:
  --name    <name>             Register this machine with a friendly name
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

Options for add:
  --user    <name>             Default SSH username for this device
  --relay   <host:port>        Default relay to use for this device
  --identity <path>            Default SSH identity file (private key) for this device
  --tag     <label>            Tag this device (repeatable: --tag homelab --tag web)

Options for list:
  --tag     <label>            Filter by tag
  --ping                       Check live latency for each device
  --relay   <host:port>        Override stored relay for --ping checks

Options for key:
  --raw                         Print only the 64-char public key

Options for tunnel:
  --port    <n>                Local proxy port (default: 2222)
  --relay   <host:port>        Use a custom relay node

Options for dashboard:
  --port    <n>                Port to listen on (default: 4321)

Options for relay:
  --host    <ip>               Public IPv4 address to bind as relay
  --port    <n>                UDP port to listen on (default: 49737)

Options for invite:
  --name    <name>             Device name to share (default: hostname)
  --relay   <host:port>        Use and include a custom relay node
  --user    <name>             Default SSH username to include in the invite
  --ttl     <seconds>          Invite lifetime (default: 600)

Options for accept:
  --name    <name>             Override invited device name
  --relay   <host:port>        Use a relay to reach the invite
  --user    <name>             Override default SSH username

Options for share:
  --relay   <host:port>        Use a custom relay node
  --ttl     <seconds>          Share lifetime in seconds (default: 600)

Options for receive:
  --out     <path>             Destination file or directory (default: current dir)
  --relay   <host:port>        Use a relay to reach the sender

Options for install-service:
  --name    <name>             Device name to pass to "hole up"
  --relay   <host:port>        Relay to pass to "hole up"
  --port    <n>                SSH port to pass to "hole up"
  --forward <svc:port>         Forward to pass to "hole up" (repeatable)

Examples:
  # Announce a machine, then use it:
  hole up --name my-server                 # on the remote machine
  hole add my-server <printed-key>         # on your laptop
  hole ssh my-server alice                 # SSH in
  hole exec my-server alice -- uptime      # run one command
  hole copy file.txt my-server:/tmp/ alice # upload a file
  hole copy my-server:/var/log/app.log . alice  # download a file
  hole ping my-server                      # check if it's up
  hole key                                 # show this machine's Hole public key
  hole services my-server                  # inspect registered service keys

  # Multiple services on one host:
  hole up --name my-pc --forward rdp:3389 --forward web:3000
  hole tunnel my-pc rdp   # opens local port for RDP
  hole tunnel my-pc web   # opens local port for browser

  # Relay mode (for CGNAT / mobile networks):
  hole relay --host 203.0.113.10 --port 49737       # on a VPS with UDP 49737 open
  hole up --name my-pc --relay 203.0.113.10:49737   # on the remote machine
  hole add my-pc <printed-key> --relay 203.0.113.10:49737
  hole doctor --relay 203.0.113.10:49737            # validate the relay path

  # Pair without copying a 64-character key:
  hole invite --name my-pc                 # on the remote machine
  hole accept blue-river-4821              # on your laptop

  # Lock down who can connect:
  hole acl add laptop <my-laptop-public-key>
  hole up --name my-pc        # now only 'laptop' can connect

  # Install as a service (auto-start on boot):
  hole install-service --name my-pc

  # Audit recent connections:
  hole audit
  hole audit --tail 20

Config: ${holeDir()}
`.trim()

if (flags.help && positional.length === 0) {
  console.log(USAGE)
  process.exit(0)
}

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

function relayOrNull (relay, source = '--relay') {
  if (!relay) return null
  try {
    return normalizeRelayAddress(relay, source)
  } catch (e) {
    die(e.message)
  }
}

function portOrDie (raw, label = '--port') {
  try {
    return normalizePort(raw, label)
  } catch (e) {
    die(e.message)
  }
}

function serviceNames (device) {
  return Object.keys(device.services ?? {})
}

function printServiceRow (name, device) {
  const svcs = serviceNames(device)
  const host = device.host ?? name
  const key = (device.key ?? '').slice(0, 16) + '...'
  console.log(`${name.padEnd(20)} ${key.padEnd(18)} ${host.slice(0, 18).padEnd(20)} ${svcs.length ? svcs.join(', ') : '—'}`)
}

function printServices ({ target = null }) {
  const reg = loadRegistry()
  if (target) {
    if (/^[0-9a-f]{64}$/i.test(target)) {
      console.log('\n=== Hole Services ===')
      console.log(`Target key : ${target}`)
      console.log('Source     : raw key (no local service map)')
      console.log('\nAdd it with a name to track service keys: hole add <name> <key>\n')
      return
    }

    const device = reg[target]
    if (!device) die(`Unknown device "${target}". Add it with: hole add ${target} <64-char-key>`)
    console.log('\n=== Hole Services ===')
    console.log(`Device : ${target}`)
    console.log(`Host   : ${device.host ?? target}`)
    console.log(`Key    : ${device.key}`)
    if (device.relay) console.log(`Relay  : ${device.relay}`)
    console.log('')

    const services = Object.entries(device.services ?? {})
    if (!services.length) {
      console.log('No service keys registered.')
      console.log('Run `hole up --forward name:port` on the remote machine and register the printed service key.')
      console.log('')
      return
    }

    console.log(`${'SERVICE'.padEnd(16)} KEY`)
    console.log('─'.repeat(82))
    for (const [service, key] of services) {
      console.log(`${service.padEnd(16)} ${key}`)
    }
    console.log('')
    return
  }

  const entries = Object.entries(reg)
  if (!entries.length) {
    console.log('No devices registered.\nAdd one with: hole add <name> <64-char-key>')
    return
  }

  console.log(`\n${'NAME'.padEnd(20)} ${'KEY (16)'.padEnd(18)} ${'HOST'.padEnd(20)} SERVICES`)
  console.log('─'.repeat(84))
  for (const [name, device] of entries) printServiceRow(name, device)
  console.log('')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  switch (cmd) {

    // ── up / agent ─────────────────────────────────────────────────────────
    case 'agent': {
      const { run } = await import('./lib/agent.js')
      await run({
        name:     flags.name    ?? null,
        relay:    relayOrNull(flags.relay),
        forwards: parseForwards(flags.forward),
        sshHost:  process.env.SSH_HOST ?? '127.0.0.1',
        sshPort:  portOrDie(flags.port ?? process.env.SSH_PORT ?? '22', '--port')
      })
      break
    }

    // ── ssh ────────────────────────────────────────────────────────────────
    case 'ssh': {
      const target = positional[0]
      if (!target) die('Usage: hole ssh <name|key> [user] [--relay host:port] [-- extra-ssh-args]')
      const devices = loadRegistry()
      const dev     = /^[0-9a-f]{64}$/i.test(target) ? null : devices[target]
      const user    = positional[1] ?? flags.user ?? dev?.user ?? null
      const relay   = relayOrNull(flags.relay ?? dev?.relay ?? null, flags.relay ? '--relay' : 'registered relay')
      const identity = flags.identity ?? dev?.identity ?? null
      // Everything after `--` is forwarded directly to ssh
      const ddash    = process.argv.indexOf('--')
      const sshArgs  = ddash !== -1 ? process.argv.slice(ddash + 1) : []
      const { ssh } = await import('./lib/client.js')
      await ssh({
        target,
        user,
        relay,
        identity,
        sshArgs
      })
      break
    }

    // ── ping ───────────────────────────────────────────────────────────────
    case 'ping': {
      const target = positional[0]
      if (!target) die('Usage: hole ping <name|key> [--count 4] [--relay host:port]')
      const devices = loadRegistry()
      const dev     = /^[0-9a-f]{64}$/i.test(target) ? null : devices[target]
      const { ping } = await import('./lib/ping.js')
      await ping({
        target,
        count: parseInt(flags.count ?? '4', 10),
        relay: relayOrNull(flags.relay ?? dev?.relay ?? null, flags.relay ? '--relay' : 'registered relay')
      })
      break
    }

    // ── exec ───────────────────────────────────────────────────────────────
    case 'exec': {
      const target = positional[0]
      if (!target) die('Usage: hole exec <name|key> <user> [--relay host:port] -- <command>')
      const devices = loadRegistry()
      const dev     = /^[0-9a-f]{64}$/i.test(target) ? null : devices[target]
      const user    = positional[1] ?? flags.user ?? dev?.user ?? null
      const relay   = relayOrNull(flags.relay ?? dev?.relay ?? null, flags.relay ? '--relay' : 'registered relay')
      const identity = flags.identity ?? dev?.identity ?? null
      const ddash = process.argv.indexOf('--')
      const cmd_  = ddash !== -1 ? process.argv.slice(ddash + 1) : []
      const { exec } = await import('./lib/client.js')
      await exec({ target, user, relay, identity, cmd: cmd_ })
      break
    }

    // ── copy ───────────────────────────────────────────────────────────────
    case 'copy': {
      // hole copy <src> <dest> [user]
      // remote paths: device:/path
      const src  = positional[0]
      const dest = positional[1]
      const userFlag = positional[2] ?? flags.user ?? null
      if (!src || !dest) die('Usage: hole copy <src> <dest> [user]\n  Remote: device:/path  e.g. hole copy file.txt my-server:/tmp/ alice')
      // Derive target device name from whichever arg is remote (device:/path)
      const REMOTE_RE = /^([^/:\\]+):/
      const srcDev  = src.match(REMOTE_RE)?.[1]
      const destDev = dest.match(REMOTE_RE)?.[1]
      const target  = srcDev ?? destDev
      if (!target) die('One of src or dest must be a remote path in the form device:/path')
      const devices = loadRegistry()
      const dev     = /^[0-9a-f]{64}$/i.test(target) ? null : devices[target]
      const user    = userFlag ?? dev?.user ?? null
      const relay   = relayOrNull(flags.relay ?? dev?.relay ?? null, flags.relay ? '--relay' : 'registered relay')
      const identity = flags.identity ?? dev?.identity ?? null
      const { copy } = await import('./lib/client.js')
      await copy({ target, src, dest, user, relay, identity })
      break
    }

    // ── dashboard ──────────────────────────────────────────────────────────
    case 'dashboard': {
      const { run } = await import('./lib/dashboard.js')
      await run({ port: parseInt(flags.port ?? '4321', 10) })
      break
    }

    // ── audit ──────────────────────────────────────────────────────────────
    case 'audit': {
      const { printAuditLog } = await import('./lib/audit.js')
      printAuditLog({ tail: parseInt(flags.tail ?? '50', 10) })
      break
    }

    // ── tunnel / client ────────────────────────────────────────────────────
    case 'client': {
      const target  = positional[0]
      const service = positional[1] ?? null   // optional: ssh | rdp | web | ...
      if (!target) die('Usage: hole tunnel <name|key> [service] [--port 2222] [--relay host:port]')
      const { run } = await import('./lib/client.js')
      const devices = loadRegistry()
      const dev     = /^[0-9a-f]{64}$/i.test(target) ? null : devices[target]
      await run({
        target,
        service,
        port:  portOrDie(flags.port ?? '2222', '--port'),
        relay: relayOrNull(flags.relay ?? dev?.relay ?? null, flags.relay ? '--relay' : 'registered relay')
      })
      break
    }

    // ── relay ──────────────────────────────────────────────────────────────
    case 'relay': {
      const { run } = await import('./lib/relay.js')
      await run({
        port: portOrDie(flags.port ?? '49737', '--port'),
        host: flags.host ?? null
      })
      break
    }

    // ── doctor ───────────────────────────────────────────────────────────────
    case 'doctor': {
      const { run } = await import('./lib/doctor.js')
      await run({ relay: relayOrNull(flags.relay) })
      break
    }

    // ── invite / accept ───────────────────────────────────────────────────
    case 'invite': {
      const { invite } = await import('./lib/invite.js')
      await invite({
        name: flags.name ?? null,
        relay: relayOrNull(flags.relay),
        user: flags.user ?? null,
        ttlMs: portOrDie(flags.ttl ?? '600', '--ttl') * 1000
      })
      break
    }

    case 'accept': {
      const code = positional[0]
      const { accept } = await import('./lib/invite.js')
      await accept({
        code,
        name: flags.name ?? null,
        relay: relayOrNull(flags.relay),
        user: flags.user ?? null
      })
      break
    }

    // ── share / receive ────────────────────────────────────────────────────
    case 'share': {
      const filePath = positional[0]
      if (!filePath) die('Usage: hole share <file> [--relay host:port] [--ttl seconds]')
      const { share } = await import('./lib/share.js')
      await share({
        filePath,
        relay: relayOrNull(flags.relay),
        ttlMs: flags.ttl ? portOrDie(flags.ttl, '--ttl') * 1000 : undefined
      })
      break
    }

    case 'receive': {
      const code = positional[0]
      if (!code) die('Usage: hole receive <share-code> [--out <path>] [--relay host:port]')
      const { receive } = await import('./lib/share.js')
      await receive({
        code,
        dest:  flags.out   ?? '.',
        relay: relayOrNull(flags.relay)
      })
      break
    }

    // ── key / whoami ───────────────────────────────────────────────────────
    case 'key':
    case 'whoami': {
      const { loadOrCreateKeyPair, publicKeyHex } = await import('./lib/identity.js')
      const keyPair = loadOrCreateKeyPair()
      const key = publicKeyHex(keyPair)
      if (flags.raw) {
        console.log(key)
        break
      }
      console.log('\n=== Hole Key ===')
      console.log(`Public key : ${key}`)
      console.log(`Keypair    : ${keypairPath()}`)
      console.log('')
      console.log('Share with another machine:')
      console.log('  hole add <name> ' + key)
      console.log('')
      break
    }

    // ── services ───────────────────────────────────────────────────────────
    case 'services': {
      printServices({ target: positional[0] ?? null })
      break
    }

    // ── install-service ────────────────────────────────────────────────────
    case 'install-service': {
      const { install } = await import('./lib/installer.js')
      const agentArgs = []
      if (flags.name)  agentArgs.push('--name',  flags.name)
      if (flags.relay) agentArgs.push('--relay', relayOrNull(flags.relay))
      if (flags.port)  agentArgs.push('--port', String(portOrDie(flags.port, '--port')))
      if (flags.forward) {
        for (const forward of [].concat(flags.forward)) agentArgs.push('--forward', forward)
      }
      install(agentArgs)
      break
    }

    case 'uninstall-service': {
      const { uninstall } = await import('./lib/installer.js')
      uninstall()
      break
    }

    // ── completion ─────────────────────────────────────────────────────────
    case 'completion': {
      console.log(`
# Hole bash completion
_hole_completion() {
  local cur prev opts
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  opts="up ssh exec copy ping tunnel relay invite accept share receive install-service uninstall-service list add remove status key whoami services audit dashboard acl doctor help completion"

  case "\${prev}" in
    ssh|exec|copy|ping|tunnel|client|services|remove|add)
      local devices=$(hole list | awk 'NR>2 {print $1}' | grep -v '^─' | grep -v '^$')
      COMPREPLY=( $(compgen -W "\${devices}" -- \${cur}) )
      return 0
      ;;
    *)
      ;;
  esac

  COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}
complete -F _hole_completion hole
`.trim())
      break
    }

    // ── list ───────────────────────────────────────────────────────────────
    case 'list': {
      let devices = listDevices()
      const filterTag = flags.tag ?? null
      if (filterTag) {
        const tag = String(filterTag)
        devices = Object.fromEntries(
          Object.entries(devices).filter(([, d]) => (d.tags ?? []).includes(tag))
        )
      }
      const names = Object.keys(devices)
      if (!names.length) {
        console.log(filterTag
          ? `No devices with tag "${filterTag}".`
          : 'No devices registered.\nAdd one with: hole add <name> <64-char-key>')
      } else {
        const showPing = flags.ping === true
        const { pingOne } = showPing ? await import('./lib/ping.js') : {}

        const header = `\n${'NAME'.padEnd(20)} ${'KEY (16)'.padEnd(18)} ${'HOST'.padEnd(18)} ${'TAGS'.padEnd(18)} ${'SERVICES'.padEnd(20)} ${showPing ? 'PING'.padEnd(10) : ''}LAST SEEN`
        console.log(header)
        console.log('─'.repeat(showPing ? 118 : 108))

        for (const [name, d] of Object.entries(devices)) {
          const key  = (d.key ?? '').slice(0, 16) + '...'
          const host = (d.host ?? '').slice(0, 16)
          const tags = (d.tags ?? []).join(', ').slice(0, 16) || '—'
          const svcs = Object.keys(d.services ?? {}).join(', ') || '—'
          const seen = (d.lastSeen ?? '').slice(0, 16).replace('T', ' ') || 'never'

          let pingCol = ''
          if (showPing) {
            const res = await pingOne({ target: name, relay: relayOrNull(flags.relay ?? d.relay ?? null, flags.relay ? '--relay' : 'registered relay') })
            pingCol = (res.online ? `${res.ms}ms` : 'DOWN').padEnd(10)
          }

          console.log(`${name.padEnd(20)} ${key.padEnd(18)} ${host.padEnd(18)} ${tags.padEnd(18)} ${svcs.padEnd(20)} ${pingCol}${seen}`)
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
      const rawTags = flags.tag ?? null
      const tags    = rawTags ? [].concat(rawTags) : undefined
      addDevice(name, key, {
        user:     flags.user     ?? undefined,
        relay:    relayOrNull(flags.relay) ?? undefined,
        identity: flags.identity ?? undefined,
        tags
      })
      const extras = []
      if (flags.user)     extras.push(`user=${flags.user}`)
      if (flags.relay)    extras.push(`relay=${flags.relay}`)
      if (flags.identity) extras.push(`identity=${flags.identity}`)
      if (tags?.length)   extras.push(`tags=${tags.join(',')}`)
      console.log(`Added "${name}" → ${key.slice(0, 16)}...${extras.length ? ` (${extras.join(', ')})` : ''}`)
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
      console.error(`Unknown command: ${rawCmd}\nRun 'hole help' for usage.`)
      process.exit(1)
  }
}

main().catch(e => {
  console.error(`\nFatal: ${e.message}`)
  process.exit(1)
})
