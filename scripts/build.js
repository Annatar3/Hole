#!/usr/bin/env node
/**
 * Build pipeline:
 *   1. esbuild  — bundles all JS into dist/bundle.cjs (sodium-native / udx-native left as external requires)
 *   2. @yao-pkg/pkg — wraps dist/bundle.cjs + native .node prebuilds into single binaries per platform
 *
 * Output (matches GitHub Actions release workflow expectations):
 *   dist/hole-linux-x64        linux  x64
 *   dist/hole-linux-arm64      linux  arm64
 *   dist/hole-win-x64.exe      windows x64
 *   dist/hole-macos-x64        macOS  x64
 *   dist/hole-macos-arm64      macOS  arm64 (Apple Silicon)
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
// 2. Package into binaries  (@yao-pkg/pkg is the maintained pkg fork)
// ---------------------------------------------------------------------------
console.log('\n=== Step 2: @yao-pkg/pkg binaries ===')
const targets = [
  'node18-linux-x64',
  'node18-linux-arm64',
  'node18-win-x64',
  'node18-macos-x64',
  'node18-macos-arm64'
].join(',')

// pkg outputs: hole-linux, hole-linux-arm64, hole-win.exe, hole-macos, hole-macos-arm64
// (x64 targets use the short platform name without the arch suffix)
run(
  `npx @yao-pkg/pkg dist/bundle.cjs` +
  ` --targets ${targets}` +
  ` --output dist/hole` +
  ` --compress Brotli`
)

// ---------------------------------------------------------------------------
// 3. Rename to the canonical names the release workflow expects
// ---------------------------------------------------------------------------
console.log('\n=== Step 3: rename outputs ===')
const renames = [
  ['dist/hole-linux',    'dist/hole-linux-x64'],
  ['dist/hole-win.exe',  'dist/hole-win-x64.exe'],
  ['dist/hole-macos',    'dist/hole-macos-x64'],
]
for (const [from, to] of renames) {
  const src = path.join(root, from)
  const dst = path.join(root, to)
  if (fs.existsSync(src)) {
    fs.renameSync(src, dst)
    console.log(`  ${from} → ${to}`)
  } else {
    console.log(`  (skip) ${from} not found`)
  }
}

// ---------------------------------------------------------------------------
// 4. Print output sizes
// ---------------------------------------------------------------------------
console.log('\n=== Output ===')
const outFiles = fs.readdirSync(path.join(root, 'dist'))
  .filter(f => f.startsWith('hole') && !f.endsWith('.cjs'))
  .map(f => {
    const p  = path.join(root, 'dist', f)
    const mb = (fs.statSync(p).size / 1024 / 1024).toFixed(1)
    return `  ${f.padEnd(30)} ${mb} MB`
  })
console.log(outFiles.join('\n'))
console.log('\nDone.')
