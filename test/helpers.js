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
