import { spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const node = process.execPath

export function makeTempHome (prefix = 'hole-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function removeTempHome (dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

export function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Runs `hole.js` asynchronously (non-blocking). Use inside `async` tests instead of spawnSync so
 * the test runner timeouts and TAP output can flush; spawnSync freezes the event loop and can hang CI.
 */
export function runHoleAsync (home, args, { expectCode = 0, timeoutMs = 120000, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['hole.js', ...args], {
      cwd: root,
      env: { ...process.env, HOME: home ?? process.env.HOME, ...extraEnv },
      encoding: 'utf8'
    })

    let out = ''
    const append = (d) => { out += String(d) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(
        `hole.js ${args.join(' ')} timed out after ${timeoutMs}ms\n${out}`
      ))
    }, timeoutMs)

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal === 'SIGKILL') {
        reject(new Error(`hole.js SIGKILL (likely timeout)\n${out}`))
        return
      }
      if (code !== expectCode) {
        reject(new Error(`hole.js exited ${code}, expected ${expectCode}\n${out}`))
        return
      }
      resolve(out)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export function spawnHole (args, { home, extraEnv = {} } = {}) {
  const child = spawn(node, ['hole.js', ...args], {
    cwd: root,
    env: { ...process.env, HOME: home ?? process.env.HOME, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.output = ''
  child.stdout.on('data', (d) => { child.output += String(d) })
  child.stderr.on('data', (d) => { child.output += String(d) })
  return child
}

export function waitForOutput (child, pattern, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${child.output}`))
    }, timeoutMs)
    const onData = () => {
      if (pattern.test(child.output)) {
        cleanup()
        resolve(child.output)
      }
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`Process exited with ${code} before ${pattern}. Output:\n${child.output}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', onExit)
    onData()
  })
}

export function stopProcess (child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) return resolve()
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      resolve()
    }, 2500)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGINT') } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}
