import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const expectedVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const workspace = mkdtempSync(path.join(tmpdir(), 'aribradshaw-devlog-consumer-'))
const packedWorkspace = mkdtempSync(path.join(tmpdir(), 'aribradshaw-devlog-packed-'))
const consumerWorkspace = workspace
const npmCli = process.env.npm_execpath
  || path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')

try {
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli,
    'pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', packedWorkspace,
  ], { cwd: root, encoding: 'utf8' }))
  const tarball = path.join(packedWorkspace, packed[0].filename)
  writeFileSync(path.join(consumerWorkspace, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2))
  execFileSync(process.execPath, [npmCli,
    'install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: consumerWorkspace, stdio: 'inherit' })

  writeFileSync(path.join(consumerWorkspace, 'esm.mjs'), [
    "import { assertDevLogReleaseAlignment, getDevLogCollection, validateDevLogEntry } from '@aribradshaw/devlog'",
    "import { resolveDevLogAutomationConfig } from '@aribradshaw/devlog/automation'",
    "assertDevLogReleaseAlignment({ currentVersion: '1.0.1', latestDevLogVersion: '1.0.1' })",
    "if (resolveDevLogAutomationConfig().enabled !== false) process.exit(1)",
    "const release = validateDevLogEntry({ version: '1.0.1', date: '2026-08-19', title: 'Packed', notes: ['Verified.'] })",
    "if (!release || getDevLogCollection([release]).visibleEntries.length !== 1) process.exit(1)",
  ].join('\n'))
  writeFileSync(path.join(consumerWorkspace, 'cjs.cjs'), [
    "const { getDevLogPaginationItems, resolveDevLogLifecycle } = require('@aribradshaw/devlog')",
    "if (getDevLogPaginationItems(6, 12).length !== 7) process.exit(1)",
    "if (resolveDevLogLifecycle({ readyAt: '2026-08-19T19:00:00Z' }).status !== 'ready') process.exit(1)",
  ].join('\n'))
  execFileSync(process.execPath, ['esm.mjs'], { cwd: consumerWorkspace, stdio: 'inherit' })
  execFileSync(process.execPath, ['cjs.cjs'], { cwd: consumerWorkspace, stdio: 'inherit' })

  const installed = JSON.parse(readFileSync(
    path.join(consumerWorkspace, 'node_modules', '@aribradshaw', 'devlog', 'package.json'),
    'utf8',
  ))
  if (installed.version !== expectedVersion) {
    throw new Error(`Expected packed version ${expectedVersion}, received ${installed.version}`)
  }

  const fixture = path.join(consumerWorkspace, 'fixture')
  mkdirSync(path.join(fixture, 'config'), { recursive: true })
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2))
  writeFileSync(path.join(fixture, 'config', 'devlog-releases.json'), JSON.stringify([{
    version: '1.0.1', date: '2026-08-18', title: 'First release', notes: ['Published.'],
    commit: 'a'.repeat(40),
  }], null, 2))
  writeFileSync(path.join(fixture, 'devlog.config.json'), JSON.stringify({
    enabled: true,
    productionBranches: ['main'],
    registryPath: 'config/devlog-releases.json',
    manifestPaths: ['package.json'],
  }, null, 2))
  if (installed.bin?.['devlog-release'] !== 'dist/cli.js') {
    throw new Error('Packed package is missing the devlog-release CLI mapping.')
  }
  const cli = path.join(consumerWorkspace, 'node_modules', '@aribradshaw', 'devlog', 'dist', 'cli.js')
  const productionArgs = [
    'prepare', '--root', fixture, '--production', '--branch', 'main',
    '--commit', 'b'.repeat(40), '--subject', 'Ship packed automation',
    '--released-at', '2026-08-19T18:00:00.000Z',
  ]
  execFileSync(process.execPath, [cli, ...productionArgs], {
    cwd: fixture,
    stdio: 'inherit',
  })
  const shim = path.join(consumerWorkspace, 'node_modules', '.bin', process.platform === 'win32'
    ? 'devlog-release.cmd'
    : 'devlog-release')
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', [
      '/d', '/s', '/c', `""${shim}" ${productionArgs.map((value) => `"${value}"`).join(' ')}"`,
    ], { cwd: fixture, stdio: 'inherit', windowsVerbatimArguments: true })
  } else {
    execFileSync(shim, productionArgs, {
      cwd: fixture,
      stdio: 'inherit',
    })
  }
  const automatedManifest = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8'))
  const automatedReleases = JSON.parse(readFileSync(
    path.join(fixture, 'config', 'devlog-releases.json'),
    'utf8',
  ))
  if (automatedManifest.version !== '1.0.2' || automatedReleases[0]?.commit !== 'b'.repeat(40)) {
    throw new Error('Packed CLI did not create and reuse the expected production release.')
  }
  console.log(`Verified packed ESM and CommonJS consumers for @aribradshaw/devlog ${expectedVersion}.`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(packedWorkspace, { recursive: true, force: true })
}
