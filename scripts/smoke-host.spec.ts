/**
 * Host-half smoke for the DSH 0.2.0-rc.2 surface, run through the smoke vitest
 * config (`scripts/smoke.vitest.config.ts`). Unlike `tests/`, this suite
 * imports `src/index.ts` — the real plugin body — against a stubbed plugin
 * context, then drives its `/dsh-mcp-setting/api/*` route handler end to end
 * over a temporary harness home. It exercises the 0.2.0-rc.2 seams the plugin
 * depends on: `ctx.webServer.register({ kind: 'prefix', ... })`, `ctx.effect`,
 * `ctx.logger`, `resolveDshHome`, and the YAML files on disk.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** The prefix route the plugin registers, captured from its ctx.effect call. */
interface CapturedRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => Promise<void>
}

/** One decoded API reply. */
interface Reply {
  status: number
  body: Record<string, unknown>
}

/** Captured route state; assigned by the stubbed web server service. */
const state: { route?: CapturedRoute; disposals: number } = { disposals: 0 }

let home: string

/**
 * Build the request/response pair the route handler expects: a loopback Host
 * header, an async-iterable JSON body, and a response that records the write.
 * @param method - HTTP method.
 * @param path - request path, including the API prefix.
 * @param payload - JSON body for methods that carry one.
 * @returns the fake request, its response, and a promise of the decoded reply.
 */
function call(method: string, path: string, payload?: unknown): { req: unknown; res: unknown; reply: Promise<Reply> } {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text, 'utf8')
    },
  }
  let settle: (reply: Reply) => void = () => {}
  const reply = new Promise<Reply>((resolve) => { settle = resolve })
  const res = {
    status: 0,
    writeHead(status: number) {
      this.status = status
      return this
    },
    end(chunk: string) {
      settle({ status: this.status, body: JSON.parse(chunk) as Record<string, unknown> })
    },
  }
  return { req, res, reply }
}

/**
 * Run one API call through the registered route handler.
 * @param method - HTTP method.
 * @param path - request path, including the API prefix.
 * @param payload - JSON body for methods that carry one.
 * @returns the decoded reply.
 */
async function api(method: string, path: string, payload?: unknown): Promise<Reply> {
  const route = state.route
  if (route === undefined) throw new Error('plugin did not register a route')
  const { req, res, reply } = call(method, path, payload)
  await route.handler(req, res)
  return reply
}

/** The servers array of an ok list reply. */
function servers(reply: Reply): Array<Record<string, unknown>> {
  return reply.body['servers'] as Array<Record<string, unknown>>
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-mcp-setting-smoke-'))
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(join(home, 'cordis.patch.yml'), [
    '# home layer',
    '- insert:',
    "    - id: mcp-existing",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: existing',
    '        transport: stdio',
    '        command: npx',
    '        args:',
    '          - -y',
    '          - existing-mcp',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- insert:',
    "    - id: mcp-profile",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: profileone',
    '        transport: streamable-http',
    '        url: http://127.0.0.1:9999/mcp',
    '',
  ].join('\n'), 'utf8')

  const { apply } = await import('../src/index.ts')
  const ctx = {
    logger: { warn: () => {} },
    get: () => undefined,
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => {
        state.disposals += 1
        if (typeof dispose === 'function') (dispose as () => void)()
      }
    },
    webServer: {
      register(route: CapturedRoute) {
        state.route = route
        return () => { state.disposals += 1 }
      },
    },
  }
  apply(ctx as never, { dshHome: home })
})

afterAll(async () => { await rm(home, { recursive: true, force: true }) })

describe('host route layer on DSH 0.2.0-rc.2', () => {
  it('registers one prefix route through ctx.effect + webServer.register', async () => {
    const route = state.route
    expect(route?.kind).toBe('prefix')
    expect(route?.path).toBe('/dsh-mcp-setting/api')
    expect(typeof route?.handler).toBe('function')
    await import('../src/index.ts')
    expect(state.disposals).toBe(0)
  })

  it('lists servers from the home and every profile patch file', async () => {
    const reply = await api('GET', '/dsh-mcp-setting/api/servers')
    expect(reply.status).toBe(200)
    expect(reply.body['ok']).toBe(true)
    expect(reply.body['homeFile']).toBe(join(home, 'cordis.patch.yml'))
    const rows = servers(reply)
    expect(rows.map((row) => row['id'])).toEqual(['mcp-existing', 'mcp-profile'])
    expect(rows.map((row) => row['scope'])).toEqual(['home', 'profile:web'])
    // Both files are absent from any live loader, so status is inferred from
    // the file view alone: home rows are pending, other-profile rows unloaded.
    expect(rows[0]?.['status']).toEqual({ state: 'loading', toolCount: 0 })
    expect(rows[1]?.['status']).toEqual({ state: 'unloaded', toolCount: 0 })
  })

  it('adds a server to the home file with the self-describing header', async () => {
    const reply = await api('POST', '/dsh-mcp-setting/api/servers', {
      id: 'mcp-added',
      serverName: 'added',
      transport: 'stdio',
      command: 'node',
      args: 'server.js --flag',
    })
    expect(reply.status).toBe(200)
    const text = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
    expect(text.startsWith('# home layer')).toBe(true)
    expect(text).toContain('id: mcp-added')
    expect(text).toContain('serverName: added')
    // A .bak keeps the previous content.
    expect(await readFile(join(home, 'cordis.patch.yml.bak'), 'utf8')).not.toContain('mcp-added')
  })

  it('rejects an invalid draft and a duplicate id without writing', async () => {
    const before = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
    const bad = await api('POST', '/dsh-mcp-setting/api/servers', {
      id: 'mcp-bad',
      serverName: 'bad name',
      transport: 'stdio',
      command: '',
    })
    expect(bad.status).toBe(400)
    expect(bad.body['ok']).toBe(false)
    const dup = await api('POST', '/dsh-mcp-setting/api/servers', { id: 'mcp-added', serverName: 'other', transport: 'stdio', command: 'node' })
    expect(dup.status).toBe(409)
    expect(dup.body['code']).toBe('DUPLICATE_ID')
    expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(before)
  })

  it('stores the disabled toggle on the row and restores it', async () => {
    const off = await api('PUT', '/dsh-mcp-setting/api/servers/mcp-added/disabled', { disabled: true })
    expect(off.status).toBe(200)
    expect((servers(off).find((row) => row['id'] === 'mcp-added')?.['status'] as { state: string }).state).toBe('disabled')
    const on = await api('PUT', '/dsh-mcp-setting/api/servers/mcp-added/disabled', { disabled: false })
    expect((servers(on).find((row) => row['id'] === 'mcp-added')?.['status'] as { state: string }).state).toBe('loading')
  })

  it('edits a server in a profile layer without touching the home file', async () => {
    const homeBefore = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
    const reply = await api('PUT', '/dsh-mcp-setting/api/servers/mcp-profile', {
      serverName: 'profileone',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9998/mcp',
    })
    expect(reply.status).toBe(200)
    const profileText = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(profileText).toContain('9998/mcp')
    expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).toBe(homeBefore)
  })

  it('deletes a row from its own layer', async () => {
    const reply = await api('DELETE', '/dsh-mcp-setting/api/servers/mcp-added')
    expect(reply.status).toBe(200)
    expect(servers(reply).map((row) => row['id'])).toEqual(['mcp-existing', 'mcp-profile'])
    expect(await readFile(join(home, 'cordis.patch.yml'), 'utf8')).not.toContain('mcp-added')
  })

  it('refuses a non-loopback Host header', async () => {
    const route = state.route as CapturedRoute
    const { req, res, reply } = call('GET', '/dsh-mcp-setting/api/servers')
    ;(req as { headers: Record<string, string> }).headers['host'] = 'example.com'
    await route.handler(req, res)
    expect((await reply).status).toBe(403)
  })
})
