import fs       from 'fs'
import path     from 'path'
import os       from 'os'
import { execSync } from 'child_process'
import { log, die } from './utils.js'

// ---------------------------------------------------------------------------
// Detect platform + binary path
// ---------------------------------------------------------------------------
function binaryPath () {
  // When running as a pkg binary, process.execPath is the binary itself
  // When running via node, use `node <hole.js path>`
  const isPkg = !!process.pkg
  if (isPkg) return process.execPath
  return `node ${path.resolve(process.argv[1])}`
}

// ---------------------------------------------------------------------------
// Linux — systemd unit
// ---------------------------------------------------------------------------
const SYSTEMD_USER_DIR  = path.join(os.homedir(), '.config', 'systemd', 'user')
const SYSTEMD_SYS_DIR   = '/etc/systemd/system'
const SERVICE_NAME      = 'hole-agent'
const SERVICE_FILE      = `${SERVICE_NAME}.service`

function systemdUnit (execStart) {
  return `[Unit]
Description=Hole — hole up via HyperDHT
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`
}

function linuxInstall (agentArgs) {
  const exec   = binaryPath()
  const args   = agentArgs.length ? ' ' + agentArgs.join(' ') : ''
  const unit   = systemdUnit(`${exec} up${args}`)

  // Use system dir if root, user dir otherwise
  const isRoot = process.getuid?.() === 0
  const dir    = isRoot ? SYSTEMD_SYS_DIR : SYSTEMD_USER_DIR
  const file   = path.join(dir, SERVICE_FILE)

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, unit)
  log(`Wrote unit file → ${file}`)

  const ctl = isRoot ? 'systemctl' : 'systemctl --user'
  try {
    execSync(`${ctl} daemon-reload`, { stdio: 'inherit' })
    execSync(`${ctl} enable --now ${SERVICE_NAME}`, { stdio: 'inherit' })
    log(`Service enabled and started.`)
    log(`Manage with: ${ctl} status ${SERVICE_NAME}`)
  } catch (e) {
    console.warn(`\nCould not start service automatically: ${e.message}`)
    console.warn(`Run manually: ${ctl} enable --now ${SERVICE_NAME}`)
  }
}

function linuxUninstall () {
  const isRoot = process.getuid?.() === 0
  const dir    = isRoot ? SYSTEMD_SYS_DIR : SYSTEMD_USER_DIR
  const file   = path.join(dir, SERVICE_FILE)
  const ctl    = isRoot ? 'systemctl' : 'systemctl --user'

  try { execSync(`${ctl} disable --now ${SERVICE_NAME}`, { stdio: 'inherit' }) } catch {}

  if (fs.existsSync(file)) {
    fs.unlinkSync(file)
    log(`Removed ${file}`)
  } else {
    console.log('No service file found.')
  }

  try { execSync(`${ctl} daemon-reload`, { stdio: 'inherit' }) } catch {}
  log('Service uninstalled.')
}

// ---------------------------------------------------------------------------
// Windows — Task Scheduler (runs at log-on, no admin needed)
// ---------------------------------------------------------------------------
function windowsInstall (agentArgs) {
  const exec = process.execPath
  const args = ['up', ...agentArgs].join(' ')

  // schtasks /create /tn "Hole Agent" /tr "C:\...\hole.exe up --name x" /sc ONLOGON /f
  const cmd = [
    'schtasks /create',
    `/tn "Hole Agent"`,
    `/tr "\\"${exec}\\" ${args}"`,
    `/sc ONLOGON`,
    `/rl HIGHEST`,
    `/f`
  ].join(' ')

  try {
    execSync(cmd, { stdio: 'inherit', shell: true })
    log('Task created. Hole Agent will start at next logon.')
    log('Start now: schtasks /run /tn "Hole Agent"')
  } catch (e) {
    die(`Could not create task: ${e.message}`)
  }
}

function windowsUninstall () {
  try {
    execSync('schtasks /delete /tn "Hole Agent" /f', { stdio: 'inherit', shell: true })
    log('Task "Hole Agent" removed.')
  } catch (e) {
    console.log('Task not found or could not be removed.')
  }
}

// ---------------------------------------------------------------------------
// macOS — launchd (Launch Agent)
// ---------------------------------------------------------------------------
const LAUNCH_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents')
const LAUNCH_ID  = 'com.hole.agent'
const LAUNCH_FILE = path.join(LAUNCH_DIR, `${LAUNCH_ID}.plist`)

function darwinInstall (agentArgs) {
  const fullPath = binaryPath()
  // If running via node, it looks like "node /path/to/hole.js"
  // We need to split it for ProgramArguments array
  const execParts = fullPath.startsWith('node ') 
    ? ['node', fullPath.slice(5)] 
    : [fullPath]
  
  const args = ['up', ...agentArgs]
  const allArgs = [...execParts, ...args]
  
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_ID}</string>
    <key>ProgramArguments</key>
    <array>
        ${allArgs.map(a => `<string>${a}</string>`).join('\n        ')}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`

  fs.mkdirSync(LAUNCH_DIR, { recursive: true })
  fs.writeFileSync(LAUNCH_FILE, plist)
  log(`Wrote plist → ${LAUNCH_FILE}`)

  try {
    execSync(`launchctl unload ${LAUNCH_FILE}`, { stdio: 'ignore' })
  } catch {}
  
  try {
    execSync(`launchctl load ${LAUNCH_FILE}`, { stdio: 'inherit' })
    log('Service loaded via launchctl.')
  } catch (e) {
    die(`Could not load service: ${e.message}`)
  }
}

function darwinUninstall () {
  if (fs.existsSync(LAUNCH_FILE)) {
    try { execSync(`launchctl unload ${LAUNCH_FILE}`, { stdio: 'inherit' }) } catch {}
    fs.unlinkSync(LAUNCH_FILE)
    log(`Removed ${LAUNCH_FILE}`)
    log('Service uninstalled.')
  } else {
    console.log('No service file found.')
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function install (agentArgs = []) {
  console.log(`\n=== Hole: Install Service ===`)
  console.log(`Platform : ${process.platform}`)
  console.log(`Binary   : ${binaryPath()}\n`)

  if (process.platform === 'linux')  return linuxInstall(agentArgs)
  if (process.platform === 'win32')  return windowsInstall(agentArgs)
  if (process.platform === 'darwin') return darwinInstall(agentArgs)
  die(`Unsupported platform: ${process.platform}. Supported: linux, win32, darwin`)
}

export function uninstall () {
  console.log(`\n=== Hole: Uninstall Service ===\n`)

  if (process.platform === 'linux')  return linuxUninstall()
  if (process.platform === 'win32')  return windowsUninstall()
  if (process.platform === 'darwin') return darwinUninstall()
  die(`Unsupported platform: ${process.platform}`)
}
