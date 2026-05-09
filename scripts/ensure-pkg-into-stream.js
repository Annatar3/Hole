#!/usr/bin/env node
/**
 * @yao-pkg/pkg@6 depends on into-stream@9 (ESM-only). Its compiled code still
 * require()s it, which breaks at runtime. npm 20+ overrides usually flatten
 * this to into-stream@6; this script copies the root into-stream@6 into
 * node_modules/@yao-pkg/pkg/node_modules/ when needed (npm 8 / odd trees).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkgRoot = path.join(root, 'node_modules', '@yao-pkg', 'pkg')
const rootInto = path.join(root, 'node_modules', 'into-stream')
const nestedInto = path.join(pkgRoot, 'node_modules', 'into-stream')

if (!fs.existsSync(pkgRoot)) process.exit(0)

if (!fs.existsSync(rootInto)) {
  console.warn('[hole postinstall] skip: no top-level into-stream (devDependencies omitted?)')
  process.exit(0)
}

let ver = ''
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootInto, 'package.json'), 'utf8'))
  ver = pkg.version || ''
} catch {
  process.exit(0)
}

if (!ver.startsWith('6.')) {
  console.warn(`[hole postinstall] skip: expected into-stream@6.x at repo root, got ${ver || '?'}`)
  process.exit(0)
}

if (fs.existsSync(nestedInto)) {
  let nestedVer = ''
  try {
    const np = JSON.parse(fs.readFileSync(path.join(nestedInto, 'package.json'), 'utf8'))
    nestedVer = np.version || ''
  } catch { /* replace */ }
  if (nestedVer.startsWith('6.')) process.exit(0)
}

fs.mkdirSync(path.dirname(nestedInto), { recursive: true })
fs.rmSync(nestedInto, { recursive: true, force: true })
fs.cpSync(rootInto, nestedInto, { recursive: true })
console.log(`[hole postinstall] @yao-pkg/pkg → into-stream@${ver} (CJS)`)
