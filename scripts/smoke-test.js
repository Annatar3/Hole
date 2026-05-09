#!/usr/bin/env node
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const node = process.execPath
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hole-smoke-'))

function run (args, { expectCode = 0 } = {}) {
  const res = spawnSync(node, ['hole.js', ...args], {
    cwd: root,
    env: { ...process.env, HOME: tmpHome },
    encoding: 'utf8'
  })
  if (res.status !== expectCode) {
    process.stderr.write(res.stdout || '')
    process.stderr.write(res.stderr || '')
    throw new Error(`node hole.js ${args.join(' ')} exited ${res.status}, expected ${expectCode}`)
  }
  return `${res.stdout || ''}${res.stderr || ''}`
}

function collectJs (dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) collectJs(p, acc)
    else if (entry.isFile() && entry.name.endsWith('.js')) acc.push(p)
  }
  return acc
}

try {
  run(['help'])

  const key = run(['key', '--raw']).trim()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`unexpected key output: ${key}`)

  const services = run(['services'])
  if (!services.includes('No devices registered')) throw new Error('services smoke did not use empty registry')

  const tunnel = run(['tunnel'], { expectCode: 1 })
  if (!tunnel.includes('Usage: hole tunnel')) throw new Error('tunnel validation smoke failed')

  const jsFiles = [
    path.join(root, 'hole.js'),
    ...collectJs(path.join(root, 'lib')),
    ...collectJs(path.join(root, 'scripts'))
  ]
  for (const file of jsFiles) {
    execFileSync(node, ['--check', file], { cwd: root, stdio: 'pipe' })
  }

  console.log(`Smoke tests passed (${jsFiles.length} JS files syntax-checked).`)
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true })
}
