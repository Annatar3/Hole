import fs from 'fs'
import crypto from 'crypto'
import DHT from 'hyperdht'
import { keypairPath } from './registry.js'

export function hasKeyPair () {
  return fs.existsSync(keypairPath())
}

export function readKeyPair () {
  const raw = fs.readFileSync(keypairPath())
  return { publicKey: raw.slice(0, 32), secretKey: raw.slice(32) }
}

export function loadOrCreateKeyPair () {
  if (hasKeyPair()) return readKeyPair()
  const kp = DHT.keyPair()
  fs.writeFileSync(keypairPath(), Buffer.concat([kp.publicKey, kp.secretKey]), { mode: 0o600 })
  return kp
}

export function publicKeyHex (keyPair = loadOrCreateKeyPair()) {
  return keyPair.publicKey.toString('hex')
}

export function deriveServiceKeyPair (masterSecretKey, serviceName) {
  const seed = crypto.createHash('sha256')
    .update(masterSecretKey)
    .update(Buffer.from(`:${serviceName}`))
    .digest()
  return DHT.keyPair(seed)
}
