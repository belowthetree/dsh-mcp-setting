import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { satisfies, valid } from 'semver'

/**
 * The harness refuses to install or activate a plugin whose DSH peer
 * requirements do not accept the running DSH version:
 * `@deepseek-ai/dsh-app-boot`'s `evaluatePluginCompatibility` walks every
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` entry of `peerDependencies` and
 * rejects the plugin when `semver.satisfies(runtime, range, {
 * includePrerelease: true })` is false. This suite re-checks that contract
 * against the DSH release line the plugin is built and published against, so a
 * stale peer range (the 0.1.3 → DSH 0.2.0-rc.2 breakage) fails here instead of
 * in the user's settings panel.
 */

const require = createRequire(import.meta.url)

/** The plugin manifest under test. */
interface Manifest {
  name: string
  version: string
  dsh?: { client?: { inject?: string[] } }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest

/** Package name of the DSH release the client half compiles against. */
const RUNTIME_PROBE = '@deepseek-ai/dsh-client-store'
/** The DSH release line this build targets. */
const RUNTIME_LINE = /^0\.2\.0-rc\./

/**
 * Read one installed package's version out of `node_modules`.
 * @param name - npm package name, including scope.
 * @returns the installed version.
 */
function installedVersion(name: string): string {
  const path = require.resolve(`${name}/package.json`)
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

/** Every peer dependency the harness gates on. */
function dshPeers(): Array<[string, string]> {
  return Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
}

/** Every DSH package the plugin is compiled against. */
function dshDevDependencies(): Array<[string, string]> {
  return Object.entries(manifest.devDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
}

/** The DSH runtime version this build targets. */
const runtimeVersion = installedVersion(RUNTIME_PROBE)

describe('DSH compatibility contract', () => {
  it('targets a pinned DSH prerelease of the supported line', () => {
    expect(valid(runtimeVersion)).not.toBeNull()
    expect(runtimeVersion).toMatch(RUNTIME_LINE)
  })

  it('declares at least one DSH peer so the harness has a contract to check', () => {
    expect(dshPeers().length).toBeGreaterThan(0)
  })

  it('accepts the targeted DSH runtime through every DSH peer range', () => {
    const incompatible = dshPeers()
      .filter(([, range]) => range.trim() === '' || !satisfies(runtimeVersion, range, { includePrerelease: true }))
      .map(([name, range]) => `${name}@${range}`)
    expect(incompatible, `peer ranges must accept DSH ${runtimeVersion}`).toEqual([])
    // `^0.1.2-alpha.1` accepted no 0.2.x runtime: the exact 0.1.3 failure mode.
    for (const [name, range] of dshPeers()) {
      expect(range.startsWith('workspace:'), `${name}@${range} must not use the workspace protocol`).toBe(false)
    }
  })

  it('pins every DSH development dependency to the targeted runtime', () => {
    const drifted = dshDevDependencies().filter(([, version]) => version !== runtimeVersion)
    expect(drifted, `dev dependencies must be pinned to ${runtimeVersion}`).toEqual([])
  })

  it('gates every injected DSH client package behind a peer range', () => {
    const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
    const missing = (manifest.dsh?.client?.inject ?? [])
      .filter(name => name.startsWith('@deepseek-ai/dsh-') && !peers.has(name))
    expect(missing, 'injected client packages must appear in peerDependencies').toEqual([])
  })

  it('accepts the installed non-DSH peer versions', () => {
    const peers = manifest.peerDependencies ?? {}
    for (const name of ['@deepseek-ai/cordis', 'react', '@deepseek-ai/schemastery']) {
      const range = peers[name]
      expect(range, `${name} must stay a peer dependency`).toBeDefined()
      const installed = installedVersion(name)
      expect(satisfies(installed, range as string), `${name}@${installed} vs ${String(range)}`).toBe(true)
    }
  })
})
