import fs   from 'fs'
import path  from 'path'
import { holeDir } from './registry.js'

// ---------------------------------------------------------------------------
// ACL — stores allowed client public keys in ~/.hole/acl.json
// Format: { "nick": "64-char-hex-key", ... }
// If the ACL is empty, all clients are allowed (open mode).
// If the ACL has entries, only those clients can connect.
// ---------------------------------------------------------------------------

function aclPath () {
  return path.join(holeDir(), 'acl.json')
}

export function loadAcl () {
  try {
    return JSON.parse(fs.readFileSync(aclPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveAcl (data) {
  fs.writeFileSync(aclPath(), JSON.stringify(data, null, 2) + '\n')
}

export function aclAdd (name, key) {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Key must be a 64-character hex string.')
  const acl = loadAcl()
  acl[name] = key.toLowerCase()
  saveAcl(acl)
}

export function aclRemove (name) {
  const acl = loadAcl()
  if (!acl[name]) return false
  delete acl[name]
  saveAcl(acl)
  return true
}

export function aclList () {
  return loadAcl()
}

// Returns true if connection is allowed
export function aclCheck (acl, remotePublicKeyBuffer) {
  const keys = Object.values(acl)
  if (!keys.length) return true  // open mode
  if (!remotePublicKeyBuffer) return false
  const hex = remotePublicKeyBuffer.toString('hex')
  return keys.includes(hex)
}
