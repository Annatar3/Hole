import crypto from 'crypto'
import DHT    from 'hyperdht'
import fs     from 'fs'
import path   from 'path'
import { createInviteCode, isInviteCode } from './invite.js'
import { log, warn } from './utils.js'

// Different seed prefix from invite so the same code string → different DHT keypair.
function shareSeed (code) {
  return crypto.createHash('sha256')
    .update('hole-share:v1:')
    .update(code)
    .digest()
}

function keyPairForCode (code) {
  if (!isInviteCode(code)) {
    throw new Error('Share code must look like cedar-blue-oak-7823')
  }
  return DHT.keyPair(shareSeed(code))
}

function formatBytes (n) {
  if (n < 1024)             return `${n} B`
  if (n < 1024 ** 2)        return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)        return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

// ---------------------------------------------------------------------------
// share({ filePath, relay, ttlMs, code })
//
// Announces a file on a short share code. Serves the first receiver, then exits.
//
// Wire format: one newline-terminated JSON header, then raw file bytes.
//   {"filename":"report.pdf","size":12345}\n<bytes>
// ---------------------------------------------------------------------------
export async function share ({
  filePath,
  relay  = null,
  ttlMs  = 10 * 60 * 1000,
  code   = createInviteCode()
} = {}) {
  let stat
  try { stat = fs.statSync(filePath) } catch {
    throw new Error(`File not found: ${filePath}`)
  }
  if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`)

  const filename = path.basename(filePath)
  const fileSize = stat.size
  const keyPair  = keyPairForCode(code)
  const dht      = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  const headerLine = Buffer.from(JSON.stringify({ filename, size: fileSize }) + '\n')

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await server.close() } catch {}
    try { await dht.destroy()  } catch {}
  }

  const server = dht.createServer((conn) => {
    conn.write(headerLine)

    const src  = fs.createReadStream(filePath)
    let   sent = 0

    src.on('data', (chunk) => {
      sent += chunk.length
      const pct = fileSize ? Math.round(sent / fileSize * 100) : 100
      process.stdout.write(`\rSending ${filename}... ${pct}% (${formatBytes(sent)} / ${formatBytes(fileSize)})`)
    })

    src.once('end', () => {
      process.stdout.write('\n')
      log('Transfer complete.')
      setTimeout(async () => { await close(); process.exit(0) }, 50).unref()
    })

    src.once('error', (e) => { warn(`Read error: ${e.message}`); conn.destroy() })
    conn.once('error', (e) => { warn(`Send error: ${e.message}`); src.destroy() })

    src.pipe(conn, { end: true })
  })

  await server.listen(keyPair)

  const expiry = setTimeout(async () => {
    console.error('\nShare expired — no receiver connected.\n')
    await close()
    process.exit(1)
  }, ttlMs)
  expiry.unref()

  console.log('\n=== Hole Share ===')
  console.log(`File   : ${filename} (${formatBytes(fileSize)})`)
  if (relay) console.log(`Relay  : ${relay}`)
  console.log(`Expires: ${Math.round(ttlMs / 60000)} minute(s)`)
  console.log('')
  console.log(`Share code: ${code}`)
  console.log('')
  console.log('On the other machine:')
  console.log(`  hole receive ${code}${relay ? ` --relay ${relay}` : ''}`)
  console.log('')
  console.log('Waiting for one receiver...\n')

  process.on('SIGINT', async () => { await close(); process.exit(0) })
}

// ---------------------------------------------------------------------------
// receive({ code, dest, relay })
//
// Connects to the sender, downloads the file, saves to dest (dir or file path).
// ---------------------------------------------------------------------------
export async function receive ({ code, dest = '.', relay = null } = {}) {
  if (!code) throw new Error('Usage: hole receive <share-code> [--out <path>] [--relay host:port]')

  const keyPair = keyPairForCode(code)
  const dht     = new DHT(relay ? { bootstrap: [relay] } : {})
  await dht.ready()

  log('Connecting to sender...')

  await new Promise((resolve, reject) => {
    const conn = dht.connect(keyPair.publicKey)

    const timer = setTimeout(() => {
      conn.destroy()
      reject(new Error('Timed out connecting to sender. Is `hole share` still running?'))
    }, 30000)

    let header   = null
    let buf      = Buffer.alloc(0)
    let out      = null
    let received = 0
    let outPath  = null

    conn.once('open', () => clearTimeout(timer))

    conn.on('data', (chunk) => {
      if (!header) {
        // Buffer until we see the newline that ends the JSON header.
        buf = Buffer.concat([buf, chunk])
        const nl = buf.indexOf(10) // '\n'
        if (nl === -1) return

        try {
          header = JSON.parse(buf.slice(0, nl).toString())
        } catch (e) {
          return reject(new Error(`Invalid share header: ${e.message}`))
        }

        outPath = (fs.existsSync(dest) && fs.statSync(dest).isDirectory())
          ? path.join(dest, header.filename)
          : dest

        console.log('\n=== Hole Receive ===')
        console.log(`File : ${header.filename} (${formatBytes(header.size)})`)
        console.log(`→    : ${outPath}\n`)

        out = fs.createWriteStream(outPath)
        out.once('error', reject)

        const fileBytes = buf.slice(nl + 1)
        if (fileBytes.length) {
          received += fileBytes.length
          out.write(fileBytes)
        }
        buf = null
      } else {
        received += chunk.length
        out.write(chunk)
        const pct = header.size ? Math.round(received / header.size * 100) : 100
        process.stdout.write(`\rReceiving... ${pct}% (${formatBytes(received)} / ${formatBytes(header.size)})`)
      }
    })

    conn.once('end', () => {
      if (!out) return reject(new Error('Connection closed before any data was received'))
      out.end()
      out.once('finish', () => {
        process.stdout.write('\n')
        console.log(`\nSaved to ${outPath}\n`)
        resolve()
      })
    })

    conn.once('error', (e) => { clearTimeout(timer); reject(e) })
  })

  await dht.destroy()
}
