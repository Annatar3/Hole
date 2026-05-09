/**
 * Minimal ssh2-backed SSH server for E2E tests (exec + pubkey auth + SFTP upload).
 */
import { timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import pkg from 'ssh2'

const { Server } = pkg
const { parseKey, generateKeyPairSync } = pkg.utils
const { OPEN_MODE, STATUS_CODE } = pkg.utils.sftp

export function generateSshKeyMaterial () {
  // Ed25519 keeps handshakes quick with modern OpenSSH (fewer rsa-sha2 quirks than 2048-bit RSA hosts).
  const hostPair = generateKeyPairSync('ed25519')
  const clientPair = generateKeyPairSync('ed25519')
  const allowedPubKey = parseKey(clientPair.public)
  return {
    hostPrivate: hostPair.private,
    clientPrivate: clientPair.private,
    clientPublic: clientPair.public,
    allowedPubKey
  }
}

function checkValue (input, allowed) {
  const a = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const b = Buffer.isBuffer(allowed) ? allowed : Buffer.from(allowed)
  const autoReject = a.length !== b.length
  const masked = autoReject ? a : b
  const isMatch = timingSafeEqual(a, masked)
  return (!autoReject && isMatch)
}

/**
 * Starts a localhost SSH listener. Exec channel runs trivial echo; SFTP accepts one upload path.
 * @param {object} opts
 * @param {string} opts.hostPrivate - OpenSSH PEM private key (host)
 * @param {ReturnType<typeof parseKey>} opts.allowedPubKey - allowed client pubkey
 * @param {string} opts.username - login name (ASCII)
 * @param {string} [opts.uploadPath] - absolute path SFTP clients may CREATE/WRITE (e.g. /tmp/x)
 * @param {Map<string, Buffer>} [opts.uploaded] - mutated on CLOSE with path → bytes
 */
export function startMiniSshd ({
  hostPrivate,
  allowedPubKey,
  username,
  uploadPath = null,
  uploaded = new Map()
}) {
  const userBuf = Buffer.from(username)

  // OpenSSH refuses to interoperate cleanly with ssh2js' default "SSH-2.0-ssh2js…"
  // ident for some setups (handshake stalls after local version).
  const server = new Server({
    hostKeys: [hostPrivate],
    ident: 'OpenSSH_9.6p2'
  }, (client) => {
    client.on('authentication', (ctx) => {
      if (!checkValue(Buffer.from(ctx.username), userBuf)) {
        return ctx.reject()
      }

      switch (ctx.method) {
        case 'publickey': {
          if (ctx.key.algo !== allowedPubKey.type ||
              !checkValue(ctx.key.data, allowedPubKey.getPublicSSH())) {
            return ctx.reject()
          }
          if (ctx.signature && allowedPubKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
            return ctx.reject()
          }
          ctx.accept()
          break
        }
        default:
          ctx.reject(['publickey'])
      }
    }).on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        session.on('exec', (accept_, reject, info) => {
          const stream = accept_()
          const cmd = info.command
          let out = ''
          if (cmd.startsWith('echo ')) {
            out = cmd.slice(5).replace(/^['"]|['"]$/g, '') + '\n'
          } else if (cmd === 'echo') {
            out = '\n'
          }
          stream.write(out)
          stream.exit(0)
          stream.end()
        })

        if (uploadPath) {
          session.on('sftp', (accept_, reject) => {
            const sftp = accept_()
            const handles = new Map()
            let next = 0

            sftp.on('REALPATH', (reqid, p) => {
              const target = p === '.' ? uploadPath : p
              sftp.name(reqid, [{
                filename: target,
                longname: `-rw-r--r-- 1 ${username} ${username} 0 Jan 1 1970 ${target.split('/').pop()}`,
                attrs: {}
              }])
            })

            const now = Date.now() / 1000
            const onStat = (reqid, path) => {
              if (path === '/tmp') {
                return sftp.attrs(reqid, {
                  mode: constants.S_IFDIR | 0o755,
                  uid: 1000,
                  gid: 1000,
                  size: 4096,
                  atime: now,
                  mtime: now
                })
              }
              if (path !== uploadPath) {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              }
              const body = uploaded.get(path)
              if (!body) {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              }
              const mode = constants.S_IFREG | 0o644
              return sftp.attrs(reqid, {
                mode,
                uid: 1000,
                gid: 1000,
                size: body.length,
                atime: now,
                mtime: now
              })
            }

            sftp.on('STAT', onStat)
            sftp.on('LSTAT', onStat)

            sftp.on('OPENDIR', (reqid, dirPath) => {
              if (dirPath !== '/tmp') {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              }
              const id = next++
              handles.set(id, { kind: 'dir', pass: 0 })
              const handle = Buffer.alloc(4)
              handle.writeUInt32BE(id, 0)
              sftp.handle(reqid, handle)
            })

            sftp.on('READDIR', (reqid, handle) => {
              const id = handle.readUInt32BE(0)
              const st = handles.get(id)
              if (!st || st.kind !== 'dir') {
                return sftp.status(reqid, STATUS_CODE.FAILURE)
              }
              if (st.pass === 0) {
                st.pass = 1
                sftp.name(reqid, [
                  {
                    filename: '.',
                    longname: `drwxr-xr-x  2 ${username} ${username} 4096 Jan  1  1970 .`,
                    attrs: { mode: constants.S_IFDIR | 0o755, size: 4096 }
                  },
                  {
                    filename: '..',
                    longname: `drwxr-xr-x  2 ${username} ${username} 4096 Jan  1  1970 ..`,
                    attrs: { mode: constants.S_IFDIR | 0o755, size: 4096 }
                  }
                ])
              } else {
                sftp.status(reqid, STATUS_CODE.EOF)
              }
            })

            sftp.on('OPEN', (reqid, filename, flags) => {
              if (filename !== uploadPath) {
                return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED)
              }
              const writeMode = (flags & (OPEN_MODE.WRITE | OPEN_MODE.CREAT)) !== 0
              if (!writeMode) {
                return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
              }
              const id = next++
              handles.set(id, { kind: 'file', chunks: [] })
              const handle = Buffer.alloc(4)
              handle.writeUInt32BE(id, 0)
              sftp.handle(reqid, handle)
            })

            sftp.on('WRITE', (reqid, handle, offset, data) => {
              const id = handle.readUInt32BE(0)
              const st = handles.get(id)
              if (!st || st.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
              st.chunks.push(data)
              sftp.status(reqid, STATUS_CODE.OK)
            })

            sftp.on('CLOSE', (reqid, handle) => {
              const id = handle.readUInt32BE(0)
              const st = handles.get(id)
              if (!st) return sftp.status(reqid, STATUS_CODE.FAILURE)
              handles.delete(id)
              if (st.kind === 'file') {
                uploaded.set(uploadPath, Buffer.concat(st.chunks))
              }
              sftp.status(reqid, STATUS_CODE.OK)
            })
          })
        }
      })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            server.close(() => res())
          })
      })
    })
  })
}
