/**
 * Publishes the built site to the `gh-pages` branch.
 *
 * GitHub Pages is configured to serve that branch directly, so deploying is
 * just "build, then force-push dist/ as the branch tip". No CI runner is
 * involved — a deliberate choice after the Actions runner proved unable to
 * even run `npm ci`.
 *
 * Run with `npm run deploy`.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const BRANCH = 'gh-pages'

/** Runs a command, streaming output, and throws on a non-zero exit. */
function run(cmd, args, cwd = ROOT) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function capture(cmd, args, cwd = ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
}

function main() {
  // Refuse to publish from a dirty tree: whatever goes live should correspond
  // to a commit you can actually get back to.
  const dirty = capture('git', ['status', '--porcelain'])
  if (dirty && !process.argv.includes('--force')) {
    console.error('Working tree has uncommitted changes:\n')
    console.error(dirty)
    console.error('\nCommit them first, or re-run with --force to deploy anyway.')
    process.exit(1)
  }

  const origin = capture('git', ['remote', 'get-url', 'origin'])
  const sha = capture('git', ['rev-parse', '--short', 'HEAD'])

  console.log('\n▸ Building…')
  run('npm', ['run', 'build'])

  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('Build produced no dist/index.html — aborting.')
    process.exit(1)
  }

  // Stage the build in a throwaway repo. Doing it outside the working tree
  // keeps dist/ gitignored in the main repo and avoids leaving the checkout
  // on a different branch if anything fails midway.
  const staging = mkdtempSync(join(tmpdir(), 'briscola-deploy-'))
  try {
    cpSync(DIST, staging, { recursive: true })
    // Stop Pages running the files through Jekyll, which would drop anything
    // whose name begins with an underscore.
    writeFileSync(join(staging, '.nojekyll'), '')

    console.log('\n▸ Publishing to ' + BRANCH + '…')
    run('git', ['init', '-q', '-b', BRANCH], staging)

    // A fresh repo would otherwise fall back to the global git identity. Reuse
    // whatever the main repo commits as, which is deliberately the GitHub
    // noreply address rather than a real email address.
    for (const key of ['user.name', 'user.email']) {
      run('git', ['config', key, capture('git', ['config', key])], staging)
    }
    run('git', ['remote', 'add', 'origin', origin], staging)

    // Build on top of the existing branch rather than force-pushing a fresh
    // root commit. A rewritten history makes GitHub Pages treat every file as
    // new on every deploy, and the push stays a plain fast-forward.
    let onTopOfExisting = false
    try {
      execFileSync('git', ['fetch', '-q', '--depth=1', 'origin', BRANCH], {
        cwd: staging,
        stdio: 'pipe',
      })
      run('git', ['reset', '--soft', 'FETCH_HEAD'], staging)
      onTopOfExisting = true
    } catch {
      // First deploy: no remote branch yet, so an orphan commit is correct.
    }

    run('git', ['add', '-A'], staging)
    run('git', ['commit', '-q', '-m', `Deploy ${sha}`], staging)
    run('git', ['push', '-q', ...(onTopOfExisting ? [] : ['-f']), 'origin', BRANCH], staging)

    console.log(`\n✓ Deployed ${sha} → ${BRANCH}`)
    console.log('  https://mattyvioo.github.io/briscola-project/')
    console.log('  (Pages usually reflects the change within a minute.)\n')
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

main()
