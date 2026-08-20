import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const workspace = mkdtempSync(path.join(tmpdir(), 'aribradshaw-devlog-consumer-'))
const npmCli = process.env.npm_execpath
  || path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')

try {
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli,
    'pack', '--ignore-scripts', '--json', '--pack-destination', workspace,
  ], { cwd: root, encoding: 'utf8' }))
  const tarball = path.join(workspace, packed[0].filename)
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2))
  execFileSync(process.execPath, [npmCli,
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: workspace, stdio: 'inherit' })

  writeFileSync(path.join(workspace, 'esm.mjs'), [
    "import { assertDevLogReleaseAlignment } from '@aribradshaw/devlog'",
    "assertDevLogReleaseAlignment({ currentVersion: '1.0.1', latestDevLogVersion: '1.0.1' })",
  ].join('\n'))
  writeFileSync(path.join(workspace, 'cjs.cjs'), [
    "const { getDevLogPaginationItems } = require('@aribradshaw/devlog')",
    "if (getDevLogPaginationItems(6, 12).length !== 7) process.exit(1)",
  ].join('\n'))
  execFileSync(process.execPath, ['esm.mjs'], { cwd: workspace, stdio: 'inherit' })
  execFileSync(process.execPath, ['cjs.cjs'], { cwd: workspace, stdio: 'inherit' })

  const installed = JSON.parse(readFileSync(
    path.join(workspace, 'node_modules', '@aribradshaw', 'devlog', 'package.json'),
    'utf8',
  ))
  if (installed.version !== '1.0.2') {
    throw new Error(`Expected packed version 1.0.2, received ${installed.version}`)
  }
  console.log('Verified packed ESM and CommonJS consumers for @aribradshaw/devlog 1.0.2.')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
