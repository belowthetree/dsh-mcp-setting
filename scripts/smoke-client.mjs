/**
 * Load-smoke for the built client bundle against the DSH 0.2.0-rc.2 platform
 * module surface. Not a test-suite member: verifies the real `lib/client.js`
 * registers through `__ModuleLoader__` and calls `apply` with the client
 * context services the plugin declares (`slots`, `locale`).
 */
import { readFileSync } from 'node:fs'
import * as store from '@deepseek-ai/dsh-client-store'
import * as react from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

const PLATFORM = {
  react,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': store,
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}

let registration
let loadCount = 0
const window_ = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loadCount += 1
      const exposed = factory((specifier) => {
        if (specifier in PLATFORM) return PLATFORM[specifier]
        throw new Error(`unknown platform module: ${specifier}`)
      })
      registration = { id, exposed }
    },
  },
}

/** Minimal DOM surface the bundle's inlined CSS-module loader touches. */
const appended = []
const document_ = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => appended.push(tag) },
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', 'document', source)(window_, document_)

if (loadCount !== 1) throw new Error(`expected one load() call, got ${loadCount}`)
if (registration.id !== 'dsh-mcp-setting') throw new Error(`unexpected bundle id: ${registration.id}`)

const calls = []
const ctx = {
  effect: (fn, label) => { calls.push(['effect', label]); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  locale: {
    register: (ns, dicts) => { calls.push(['locale.register', ns, Object.keys(dicts)]); return () => {} },
    bind: (ns) => { calls.push(['locale.bind', ns]); return (key) => `${ns}:${key}` },
  },
  slots: {
    inject: (name, fn) => { calls.push(['slots.inject', name]); return fn() },
    register: (spec, component) => {
      calls.push(['slots.register', spec.name, spec.id, typeof component, Object.keys(spec.inject()).sort()])
      return () => {}
    },
  },
}

const apply = registration.exposed.apply
if (typeof apply !== 'function') throw new Error('bundle did not export apply()')
if (JSON.stringify(registration.exposed.inject) !== JSON.stringify(['slots', 'locale'])) {
  throw new Error(`unexpected inject: ${JSON.stringify(registration.exposed.inject)}`)
}
apply(ctx)
// Re-registering on a second mount must not throw (hot-reload path).
apply(ctx)

console.log(JSON.stringify({
  bundleId: registration.id,
  exports: Object.keys(registration.exposed),
  styleTagsAppended: appended.length,
  calls,
}, null, 1))
