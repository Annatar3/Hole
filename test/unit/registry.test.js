import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { addDevice, listDevices, removeDevice, touchDevice, holeDir } from '../../lib/registry.js'
import { makeTempHome, removeTempHome } from '../helpers.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

test('registry stores devices under isolated HOME and preserves metadata on update', () => {
  const oldHome = process.env.HOME
  const home = makeTempHome('hole-registry-')
  process.env.HOME = home
  try {
    addDevice('box', KEY_A, {
      host: 'box.local',
      user: 'alice',
      relay: '127.0.0.1:49737',
      identity: '~/.ssh/id_ed25519',
      tags: ['lab'],
      services: { ssh: KEY_A }
    })

    addDevice('box', KEY_B, { host: 'box-renamed' })
    const box = listDevices().box

    assert.equal(box.key, KEY_B)
    assert.equal(box.host, 'box-renamed')
    assert.equal(box.user, 'alice')
    assert.equal(box.relay, '127.0.0.1:49737')
    assert.equal(box.identity, '~/.ssh/id_ed25519')
    assert.deepEqual(box.tags, ['lab'])
    assert.deepEqual(box.services, { ssh: KEY_A })

    touchDevice('box', { metrics: { cpu: 1 } })
    assert.deepEqual(listDevices().box.metrics, { cpu: 1 })

    assert.equal(removeDevice('box'), true)
    assert.deepEqual(listDevices(), {})

    assert.equal(fs.existsSync(path.join(home, '.hole', 'devices.json')), true)
  } finally {
    process.env.HOME = oldHome
    removeTempHome(home)
  }
})

test('saveRegistry leaves no .tmp file after a successful write', () => {
  const oldHome = process.env.HOME
  const home = makeTempHome('hole-registry-atomic-')
  process.env.HOME = home
  try {
    addDevice('node', KEY_A)
    const dir = holeDir()
    assert.equal(fs.existsSync(path.join(dir, 'devices.json')), true)
    assert.equal(fs.existsSync(path.join(dir, 'devices.json.tmp')), false)
  } finally {
    process.env.HOME = oldHome
    removeTempHome(home)
  }
})
