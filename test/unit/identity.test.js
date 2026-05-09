import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { keypairPath } from '../../lib/registry.js'
import { hasKeyPair, loadOrCreateKeyPair, publicKeyHex, readKeyPair } from '../../lib/identity.js'
import { makeTempHome, removeTempHome } from '../helpers.js'

test('identity creates a stable keypair in isolated HOME', () => {
  const oldHome = process.env.HOME
  const home = makeTempHome('hole-identity-')
  process.env.HOME = home
  try {
    assert.equal(hasKeyPair(), false)
    const first = loadOrCreateKeyPair()
    assert.equal(hasKeyPair(), true)
    assert.equal(fs.existsSync(keypairPath()), true)
    assert.match(publicKeyHex(first), /^[0-9a-f]{64}$/)

    const second = readKeyPair()
    assert.equal(publicKeyHex(second), publicKeyHex(first))
    assert.equal(loadOrCreateKeyPair().publicKey.toString('hex'), first.publicKey.toString('hex'))
  } finally {
    process.env.HOME = oldHome
    removeTempHome(home)
  }
})
