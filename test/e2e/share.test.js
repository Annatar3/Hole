import test   from 'node:test'
import assert from 'node:assert/strict'
import fs     from 'fs'
import path   from 'path'
import os     from 'os'
import {
  freePort,
  makeTempHome,
  removeTempHome,
  runHoleAsync,
  spawnHole,
  stopProcess,
  waitForOutput
} from '../helpers.js'

test('hole share + hole receive transfers a file through a local relay', { timeout: 90000 }, async () => {
  const senderHome   = makeTempHome('hole-share-src-')
  const receiverHome = makeTempHome('hole-share-dst-')
  const relayHome    = makeTempHome('hole-share-relay-')
  const srcDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'hole-share-file-'))
  const dstDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'hole-share-recv-'))

  let relay
  let sender

  try {
    // Write a test file with known content
    const srcFile = path.join(srcDir, 'hello.txt')
    fs.writeFileSync(srcFile, 'hole share test content — P2P wormhole\n'.repeat(100))
    const originalContent = fs.readFileSync(srcFile, 'utf8')

    // Start relay
    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`
    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    // Start sender
    sender = spawnHole(['share', srcFile, '--relay', relayAddr, '--ttl', '30'], { home: senderHome })
    const shareOutput = await waitForOutput(sender, /Share code:/, { timeoutMs: 20000 })

    // Extract share code from output
    const code = shareOutput.match(/Share code:\s+([a-z]+-[a-z]+-[a-z]+-\d{4})/)?.[1]
    assert.ok(code, `Expected a share code in output, got:\n${shareOutput}`)
    assert.match(code, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/)

    // Receive the file
    const recvOutput = await runHoleAsync(
      receiverHome,
      ['receive', code, '--relay', relayAddr, '--out', dstDir],
      { timeoutMs: 30000 }
    )
    assert.match(recvOutput, /Saved to/)

    // Verify content matches exactly
    const dstFile = path.join(dstDir, 'hello.txt')
    assert.ok(fs.existsSync(dstFile), 'Received file should exist')
    const receivedContent = fs.readFileSync(dstFile, 'utf8')
    assert.equal(receivedContent, originalContent, 'Received content must match original')
  } finally {
    await stopProcess(sender)
    await stopProcess(relay)
    removeTempHome(senderHome)
    removeTempHome(receiverHome)
    removeTempHome(relayHome)
    fs.rmSync(srcDir, { recursive: true, force: true })
    fs.rmSync(dstDir, { recursive: true, force: true })
  }
})

test('hole share transfers a binary file with exact byte-for-byte match', { timeout: 90000 }, async () => {
  const senderHome   = makeTempHome('hole-share-bin-src-')
  const receiverHome = makeTempHome('hole-share-bin-dst-')
  const relayHome    = makeTempHome('hole-share-bin-relay-')
  const srcDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'hole-share-bin-'))
  const dstDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'hole-share-bin-recv-'))

  let relay
  let sender

  try {
    // Create a binary file with random bytes (tests that the protocol handles non-text safely)
    const srcFile = path.join(srcDir, 'random.bin')
    const original = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
    fs.writeFileSync(srcFile, original)

    const relayPort = await freePort()
    const relayAddr = `127.0.0.1:${relayPort}`
    relay = spawnHole(['relay', '--host', '127.0.0.1', '--port', String(relayPort)], { home: relayHome })
    await waitForOutput(relay, /Relay ready/, { timeoutMs: 20000 })

    sender = spawnHole(['share', srcFile, '--relay', relayAddr, '--ttl', '30'], { home: senderHome })
    const shareOutput = await waitForOutput(sender, /Share code:/, { timeoutMs: 20000 })
    const code = shareOutput.match(/Share code:\s+([a-z]+-[a-z]+-[a-z]+-\d{4})/)?.[1]
    assert.ok(code)

    await runHoleAsync(
      receiverHome,
      ['receive', code, '--relay', relayAddr, '--out', dstDir],
      { timeoutMs: 30000 }
    )

    const received = fs.readFileSync(path.join(dstDir, 'random.bin'))
    assert.equal(received.compare(original), 0, 'Binary content must be bit-for-bit identical')
  } finally {
    await stopProcess(sender)
    await stopProcess(relay)
    removeTempHome(senderHome)
    removeTempHome(receiverHome)
    removeTempHome(relayHome)
    fs.rmSync(srcDir, { recursive: true, force: true })
    fs.rmSync(dstDir, { recursive: true, force: true })
  }
})
