#!/usr/bin/env node
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const res = spawnSync(process.execPath, ['--test', 'test/cli/*.test.js'], {
  cwd: root,
  stdio: 'inherit',
  shell: true
})

process.exit(res.status ?? 1)
