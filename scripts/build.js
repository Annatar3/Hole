#!/usr/bin/env node
/**
 * Build pipeline:
 *   1. esbuild  — bundles all JS into dist/bundle.cjs (CJS, sodium-native / udx-native left as external requires)
 *   2. pkg      — wraps dist/bundle.cjs + native .node prebuilds into single binaries per platform
 *
 * Output:
 *   dist/hole-linux        linux  x64
 *   dist/hole-linux-arm64  linux  arm64
 *   dist/hole-win.exe      windows x64
 *   dist/hole-macos        macOS  x64
 *   dist/hole-macos-arm64  macOS  arm64 (Apple Silicon)
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function run (cmd) {
  console.log(`\n$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root })
}

// ---------------------------------------------------------------------------
// 1. Bundle JS → dist/bundle.cjs
// ---------------------------------------------------------------------------
console.log('\n=== Step 1: esbuild bundle ===')
run(
  'npx esbuild hole.js' +
  ' --bundle' +
  ' --platform=node' +
  ' --target=node20' +
  ' --format=cjs' +
  ' --outfile=dist/bundle.cjs' +
  ' --external:sodium-native' +     // native crypto — kept as require()
  ' --external:udx-native' +        // native UDP    — kept as require()
  ' --log-level=info'
)

// ---------------------------------------------------------------------------
// 2. Package into binaries
// ---------------------------------------------------------------------------
console.log('\n=== Step 2: pkg binaries ===')
// Use pkg v5 with Node 18 targets for maximum compatibility
const targets = [
  'node18-linux-x64',
  'node18-linux-arm64',
  'node18-win-x64',
  'node18-macos-x64',
  'node18-macos-arm64'
].join(',')

run(
  `npx pkg dist/bundle.cjs` +
  ` --targets ${targets}` +
  ` --output dist/hole` +
  ` --compress Brotli`
)

// ---------------------------------------------------------------------------
// 3. Print output sizes
// ---------------------------------------------------------------------------
console.log('\n=== Output ===')
const outFiles = fs.readdirSync(path.join(root, 'dist'))
  .filter(f => f.startsWith('hole') && !f.endsWith('.cjs'))
  .map(f => {
    const p    = path.join(root, 'dist', f)
    const mb   = (fs.statSync(p).size / 1024 / 1024).toFixed(1)
    return `  ${f.padEnd(30)} ${mb} MB`
  })
console.log(outFiles.join('\n'))
console.log('\nDone.')
