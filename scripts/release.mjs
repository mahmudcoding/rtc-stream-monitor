#!/usr/bin/env node
// Cut a release: bump every version marker together, rebuild, run the full
// dependency-free suite, tag, and publish the extension zip to GitHub Releases.
//
// The version lives in three places that MUST agree — src's in-page VERSION
// (which drives the stale-instance replacement) and both manifests. build.sh
// enforces the agreement; this script is what keeps them in step.
//
//   node scripts/release.mjs 1.7.1
//   node scripts/release.mjs 1.7.1 --dry-run
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', ...opts })

process.on('uncaughtException', (error) => {
  console.error('\nrelease failed: ' + error.message)
  process.exit(1)
})

const version = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: node scripts/release.mjs <major.minor.patch> [--dry-run]')
  process.exit(2)
}

const current = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).version
const cmp = (a, b) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
if (cmp(version, current) <= 0) {
  throw new Error(`${version} is not newer than the current ${current}`)
}

// A dirty tree means the release would not match what is committed.
if (run('git', ['status', '--porcelain']).trim() && !dryRun) {
  throw new Error('working tree is dirty — commit or stash before releasing')
}

console.log(`releasing ${current} -> ${version}${dryRun ? ' (dry run)' : ''}\n`)

const edits = [
  ['src/rtc-stream-monitor.js', /var VERSION = '[^']+'/, `var VERSION = '${version}'`],
  ['extension/manifest.json', /"version": "[^"]+"/, `"version": "${version}"`],
  ['extension-dev/manifest.json', /"version": "[^"]+"/, `"version": "${version}"`]
]
for (const [file, pattern, replacement] of edits) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const after = before.replace(pattern, replacement)
  if (after === before) throw new Error(`version marker not found in ${file}`)
  writeFileSync(path, after)
  console.log('  bumped ' + file)
}

console.log('\nbuilding…')
console.log(run('bash', ['build.sh']).trim())

console.log('\nrunning suites…')
for (const suite of ['names-unit', 'background-unit', 'stats-unit', 'zoom-media-unit',
                     'zoom-background-unit', 'zoom-capture-unit', 'manifest-unit',
                     'launcher-unit']) {
  try {
    run('node', [`test/${suite}.js`])
    console.log('  PASS ' + suite)
  } catch (error) {
    throw new Error(`${suite} failed — release aborted\n${error.stdout || ''}${error.stderr || ''}`)
  }
}
console.log('\n  NOTE: the real-Chrome suite (test/run.js) is not run here; run it yourself\n' +
            '        for anything beyond a doc-only release.')

if (dryRun) {
  console.log('\ndry run complete — files bumped and built, nothing committed or published.')
  process.exit(0)
}

const notes = process.env.RELEASE_NOTES ||
  `RTC Stream Monitor ${version}\n\n` +
  `Install: download stream-monitor-extension.zip, extract it, then\n` +
  `chrome://extensions -> Developer mode -> Load unpacked -> pick the folder.\n\n` +
  `Existing installs on the auto-update agent pick this up within a day.`

run('git', ['add', '-A'])
run('git', ['-c', 'user.name=Mahmud Nosirov', '-c', 'user.email=mahmudnosirov@icloud.com',
            'commit', '-m', `Release ${version}`])
run('git', ['tag', '-a', `v${version}`, '-m', `RTC Stream Monitor ${version}`])
run('git', ['push', 'origin', 'HEAD', '--tags'])
console.log('\npushed commit and tag v' + version)

run('gh', ['release', 'create', `v${version}`,
           join(root, 'dist/stream-monitor-extension.zip'),
           '--title', `RTC Stream Monitor ${version}`, '--notes', notes])
console.log('published https://github.com/mahmudcoding/rtc-stream-monitor/releases/tag/v' + version)
