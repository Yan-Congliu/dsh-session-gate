#!/usr/bin/env node
/**
 * dsh-session-gate — installer for desktop profiles that have no
 * `plugin_manager` tool.
 *
 * It does exactly what the manual install in README.md does, and nothing more:
 *
 *   1. copy `host/` to   <DSH_HOME>/plugins/dsh-session-gate
 *   2. copy `host/` to   <profile>/node_modules/dsh-session-gate
 *   3. add the dependency + `dsh.profile.bundles` entry to <profile>/package.json
 *
 * The default is a DRY RUN: it prints what it would change and touches nothing.
 * Pass `--apply` to write. `--rollback` restores the newest backup of
 * package.json and deletes the two copied folders.
 *
 *   node install.mjs                     # dry run, auto-detects profile
 *   node install.mjs --apply             # do it
 *   node install.mjs --rollback          # undo
 *   node install.mjs --profile desktop   # pick a profile by name
 *   node install.mjs --home D:\dsh-home  # pick another DSH_HOME
 *
 * No dependencies, no network.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = 'dsh-session-gate'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(ROOT, 'host')

function parseArgs(argv) {
  const options = { apply: false, rollback: false, help: false, home: undefined, profile: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (arg === '--rollback') options.rollback = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--home') options.home = argv[++index]
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else if (arg === '--profile') options.profile = argv[++index]
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const forward = (path) => path.replace(/\\/g, '/')

async function resolveHome(given) {
  const home = given !== undefined ? resolve(given) : resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  if (!(await exists(home))) throw new Error(`DSH_HOME not found: ${home}`)
  return home
}

async function resolveProfile(home, given) {
  if (given !== undefined) {
    const direct = resolve(given)
    if (isAbsolute(given) && (await exists(join(direct, 'package.json')))) return direct
    const named = join(home, 'profiles', given)
    if (await exists(join(named, 'package.json'))) return named
    throw new Error(`profile not found: ${given} (tried ${direct} and ${named})`)
  }
  const profiles = join(home, 'profiles')
  if (!(await exists(profiles))) {
    throw new Error(`no profiles folder at ${profiles}; pass --profile <path>`)
  }
  const names = []
  for (const entry of await readdir(profiles, { withFileTypes: true })) {
    if (entry.isDirectory() && (await exists(join(profiles, entry.name, 'package.json')))) names.push(entry.name)
  }
  if (names.length === 0) throw new Error(`no profile with a package.json under ${profiles}`)
  if (names.includes('desktop')) return join(profiles, 'desktop')
  if (names.length === 1) return join(profiles, names[0])
  throw new Error(`several profiles (${names.join(', ')}); pass --profile <name>`)
}

function patchManifest(text, source) {
  const manifest = JSON.parse(text)
  const before = JSON.stringify(manifest)
  manifest.dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  manifest.dependencies[BUNDLE] = `file:${forward(source)}`
  manifest.dsh = manifest.dsh !== null && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  manifest.dsh.profile = manifest.dsh.profile !== null && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes(BUNDLE)) bundles.push(BUNDLE)
  manifest.dsh.profile.bundles = bundles
  return { manifest, changed: JSON.stringify(manifest) !== before }
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      [
        'dsh-session-gate installer',
        '',
        '  node install.mjs                        dry run (default), auto-detect profile',
        '  node install.mjs --apply                install',
        '  node install.mjs --rollback --apply     restore the newest package.json backup',
        '  node install.mjs --profile desktop      pick a profile by name or path',
        '  node install.mjs --home <dir>           pick another DSH_HOME',
        '',
        'It copies host/ into <DSH_HOME>/plugins and the profile node_modules, then adds the',
        'dependency and dsh.profile.bundles entry. Restart DSH afterwards.',
      ].join('\n'),
    )
    return
  }
  if (!(await exists(join(SOURCE, 'package.json')))) {
    throw new Error(`host/ not found next to install.mjs (expected ${SOURCE})`)
  }
  const home = await resolveHome(options.home)
  const profile = await resolveProfile(home, options.profile)
  const pluginDir = join(home, 'plugins', BUNDLE)
  const moduleDir = join(profile, 'node_modules', BUNDLE)
  const manifestPath = join(profile, 'package.json')
  const text = await readFile(manifestPath, 'utf8')

  if (options.rollback) {
    const names = (await readdir(profile)).filter((name) => name.startsWith('package.json.dsh-session-gate.bak-')).sort()
    if (names.length === 0) throw new Error(`no backup found in ${profile}`)
    const backup = join(profile, names.at(-1))
    const restored = await readFile(backup, 'utf8')
    const { changed } = patchManifest(restored, SOURCE)
    if (options.apply) {
      await writeFile(manifestPath, restored, 'utf8')
      await rm(pluginDir, { recursive: true, force: true })
      await rm(moduleDir, { recursive: true, force: true })
      console.log(`restored ${relative(process.cwd(), manifestPath)} from ${names.at(-1)}`)
      console.log('removed the two copied folders; restart DSH.')
    } else {
      console.log('[dry run] would restore', relative(process.cwd(), manifestPath), 'from', names.at(-1))
      console.log(`[dry run] that backup ${changed ? 'still differs from' : 'matches'} a bundle-free manifest`)
      console.log('re-run with --apply --rollback to write.')
    }
    return
  }

  const { manifest, changed } = patchManifest(text, SOURCE)
  const plan = [
    { action: 'copy', from: SOURCE, to: pluginDir },
    { action: 'copy', from: SOURCE, to: moduleDir },
    { action: 'patch', file: manifestPath, changed },
  ]
  for (const step of plan) {
    if (step.action === 'copy') console.log(`${options.apply ? 'copy  ' : '[dry] '} ${step.from}  ->  ${step.to}`)
    else console.log(`${options.apply ? 'patch ' : '[dry] '} ${step.file}  (${step.changed ? 'dependencies + dsh.profile.bundles' : 'already up to date'})`)
  }

  if (!options.apply) {
    console.log('\nNothing written. Re-run with --apply to install, then restart DSH.')
    return
  }

  const backup = `${manifestPath}.dsh-session-gate.bak-${stamp()}`
  await cp(manifestPath, backup)
  console.log('backup:', relative(process.cwd(), backup))
  await rm(pluginDir, { recursive: true, force: true })
  await rm(moduleDir, { recursive: true, force: true })
  await mkdir(dirname(pluginDir), { recursive: true })
  await mkdir(dirname(moduleDir), { recursive: true })
  await cp(SOURCE, pluginDir, { recursive: true })
  await cp(SOURCE, moduleDir, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`\ninstalled ${BUNDLE} into ${profile}`)
  console.log('restart DSH; the tab is on the right sidebar as 会话闸门.')
  console.log(`undo with: node ${relative(process.cwd(), fileURLToPath(import.meta.url))} --rollback --apply`)
}

main().catch((error) => {
  console.error(`install failed: ${error?.message ?? error}`)
  process.exitCode = 1
})
