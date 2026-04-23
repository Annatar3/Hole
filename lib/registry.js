import fs   from 'fs'
import path from 'path'
import os   from 'os'

// ---------------------------------------------------------------------------
// All state lives in ~/.hole/
//   keypair       — this machine's agent keypair (binary, 96 bytes)
//   devices.json  — name → { key, host, addedAt, lastSeen }
// ---------------------------------------------------------------------------

export function holeDir () {
  const dir = path.join(os.homedir(), '.hole')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function keypairPath () {
  return path.join(holeDir(), 'keypair')
}

function registryPath () {
  return path.join(holeDir(), 'devices.json')
}

// ---------------------------------------------------------------------------
// Registry CRUD
// ---------------------------------------------------------------------------

export function loadRegistry () {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveRegistry (data) {
  fs.writeFileSync(registryPath(), JSON.stringify(data, null, 2) + '\n')
}

export function addDevice (name, key, meta = {}) {
  const reg = loadRegistry()
  reg[name] = {
    key,
    host:      meta.host     ?? name,
    addedAt:   reg[name]?.addedAt ?? new Date().toISOString(),
    lastSeen:  new Date().toISOString(),
    ...meta
  }
  saveRegistry(reg)
  return reg[name]
}

export function removeDevice (name) {
  const reg = loadRegistry()
  if (!reg[name]) return false
  delete reg[name]
  saveRegistry(reg)
  return true
}

export function touchDevice (name, meta = {}) {
  const reg = loadRegistry()
  if (reg[name]) {
    reg[name].lastSeen = new Date().toISOString()
    Object.assign(reg[name], meta)
    saveRegistry(reg)
  }
}

// ---------------------------------------------------------------------------
// Key resolution: accepts either a device name or a raw 64-char hex key
// ---------------------------------------------------------------------------
export function resolveKey (nameOrKey) {
  if (/^[0-9a-f]{64}$/i.test(nameOrKey)) return nameOrKey
  const reg = loadRegistry()
  return reg[nameOrKey]?.key ?? null
}

export function listDevices () {
  return loadRegistry()
}
