/**
 * dsh-mcp-setting host half: a settings-managed editor for the MCP server
 * rows in the harness's cordis patch files. Registers `/dsh-mcp-setting/api/*`
 * routes on the web server so the browser settings page can list, add, update,
 * and delete `@deepseek-ai/dsh-mcp-client` rows in `$DSH_HOME/cordis.patch.yml`
 * (home layer) and every `$DSH_HOME/profiles/<name>/cordis.patch.yml` (profile
 * layers).
 *
 * All writes are loopback-only, validate every field against the mcp-client
 * config contract before touching the file, run under a per-process write
 * chain, and keep a `.bak` copy of the previous file content. Changes take
 * effect at the next harness restart (loader rows are startup composition).
 *
 * @module dsh-mcp-setting
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Side-effect type import: declaration-merges `ctx.webServer`.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Document } from 'yaml'
import { API_PREFIX, SERVERS_ROUTE } from './types.ts'
import type { McpApiResponse, McpServerDraft, McpServerScope, McpServerView } from './types.ts'
import {
  MCP_CLIENT_NAME,
  SERVER_ID_PATTERN,
  appendMcpEntry,
  listRows,
  locateRow,
  mergeEditedConfig,
  openPatchDocument,
  parseDraftConfig,
  removeRow,
  serializePatch,
  setRowConfig,
} from './patch-editor.ts'

export const name = 'dsh-mcp-setting'
/** The web server carries every API route; nothing else is required. */
export const inject = ['webServer']

/** Plugin config: harness-home override for non-default layouts. */
export interface Config {
  /** Harness home; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
})

/** Name of the patch file inside the home and inside every profile directory. */
const PATCH_FILENAME = 'cordis.patch.yml'
/** Request-body size cap: a settings form never approaches 1 MiB. */
const MAX_BODY_BYTES = 1_000_000

/** One patch file the plugin manages. */
interface PatchTarget {
  /** UI-facing scope label. */
  scope: McpServerScope
  /** Absolute patch file path. */
  file: string
}

/** Failure raised by route handlers; maps to the error envelope. */
class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

/** Whether a request's Host header names the loopback (writes stay local). */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

/** Write a JSON envelope, suppressing browser caching. */
function sendJson(res: ServerResponse, status: number, body: McpApiResponse): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/** Send the shared failure envelope; RouteError keeps its status and code. */
function sendFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof RouteError) {
    sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { ok: false, code: 'INTERNAL', message })
}

/** Wrap a config-validation throw as a 400 so field errors are client errors. */
function asValidationError(error: unknown): RouteError {
  const message = error instanceof Error ? error.message : String(error)
  return new RouteError(400, 'INVALID_CONFIG', message)
}

/**
 * Mount the dsh-mcp-setting API. Registers one prefix route and owns every
 * handler; the returned fiber disposer removes the route.
 * @param ctx - Cordis context carrying the web server service.
 * @param config - composition entry; `dshHome` defaults to the harness home.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  const dshHome = resolveDshHome(config.dshHome)
  const homeTarget: PatchTarget = { scope: 'home', file: join(dshHome, PATCH_FILENAME) }
  /** Serialized write chain: every file mutation waits for the previous one. */
  let writeChain: Promise<void> = Promise.resolve()

  /** All managed patch files: the home layer first, then every profile layer. */
  async function listTargets(): Promise<PatchTarget[]> {
    const targets: PatchTarget[] = [homeTarget]
    const profilesDir = join(dshHome, 'profiles')
    let entries: string[]
    try {
      entries = await readdir(profilesDir, { withFileTypes: true })
        .then(items => items.filter(item => item.isDirectory()).map(item => item.name))
    } catch {
      return targets
    }
    for (const profile of entries.sort()) {
      targets.push({ scope: `profile:${profile}`, file: join(profilesDir, profile, PATCH_FILENAME) })
    }
    return targets
  }

  /** Read one patch file's text; undefined when the file does not exist. */
  async function readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /** Parse one target's document, or undefined when the file is absent. */
  async function readTarget(target: PatchTarget): Promise<Document | undefined> {
    const text = await readText(target.file)
    return text === undefined ? undefined : openPatchDocument(text)
  }

  /** Every MCP row across all targets, in target order. */
  async function collectServers(): Promise<McpServerView[]> {
    const servers: McpServerView[] = []
    for (const target of await listTargets()) {
      const doc = await readTarget(target)
      if (doc === undefined) continue
      servers.push(...listRows(doc, target.file, target.scope))
    }
    return servers
  }

  /**
   * Locate one row's target and document across every patch file. Reads fresh
   * so an external edit is never overwritten blindly (the write chain still
   * serializes our own mutations).
   * @returns the target, its document, and the row address.
   */
  async function locateServer(id: string): Promise<{ target: PatchTarget; doc: Document; entryIndex: number; rowIndex: number } | undefined> {
    for (const target of await listTargets()) {
      const doc = await readTarget(target)
      if (doc === undefined) continue
      const location = locateRow(doc, id)
      if (location !== undefined) {
        return { target, doc, entryIndex: location.entryIndex, rowIndex: location.rowIndex }
      }
    }
    return undefined
  }

  /**
   * Persist one target: keep a `.bak` of the previous content, then write the
   * serialized document via a same-directory temp file and rename (atomic on
   * the same volume). A never-before-existing home patch gets a header line so
   * the file is self-describing.
   */
  async function writeTarget(target: PatchTarget, doc: Document, existed: boolean): Promise<void> {
    await mkdir(join(target.file, '..'), { recursive: true })
    const backup = `${target.file}.bak`
    try {
      await copyFile(target.file, backup)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    const text = serializePatch(doc)
    const tmp = `${target.file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, existed ? text : `# MCP 服务器配置，由设置界面「MCP 服务器」维护；重启后生效。\n${text}`, 'utf8')
    await rename(tmp, target.file)
  }

  /** Read a JSON request body under the size cap. */
  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new RouteError(413, 'BODY_TOO_LARGE', '请求体过大')
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('not an object')
      }
      return value as Record<string, unknown>
    } catch {
      throw new RouteError(400, 'INVALID_JSON', '请求体不是合法 JSON 对象')
    }
  }

  /** Validate a draft field present in the request body. */
  function requireString(body: Record<string, unknown>, key: string): string {
    const value = body[key]
    if (typeof value !== 'string') throw new RouteError(400, 'INVALID_FIELD', `缺少字段 ${key}`)
    return value
  }

  /** Build the draft from a request body, defaulting absent optional fields. */
  function draftFromBody(body: Record<string, unknown>): McpServerDraft {
    const transport = body['transport']
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      throw new RouteError(400, 'INVALID_TRANSPORT', 'transport 必须是 stdio 或 streamable-http')
    }
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    return {
      serverName: requireString(body, 'serverName'),
      transport,
      command: text(body['command']),
      args: text(body['args']),
      cwd: text(body['cwd']),
      envJson: text(body['envJson']),
      url: text(body['url']),
      headersJson: text(body['headersJson']),
    }
  }

  /** Reject a duplicate serverName; the mcp-client namespace is process-wide. */
  function assertServerNameFree(servers: McpServerView[], serverName: string, exceptId?: string): void {
    const config = (server: McpServerView): Record<string, unknown> => server.config
    for (const server of servers) {
      if (server.id === exceptId) continue
      if (config(server)['serverName'] === serverName) {
        throw new RouteError(409, 'DUPLICATE_SERVER_NAME', `serverName「${serverName}」已被服务器「${server.id}」占用`)
      }
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: 'MCP 配置接口仅允许本机访问' })
        return
      }
      const pathname = new URL(req.url ?? SERVERS_ROUTE, 'http://localhost').pathname
      if (!pathname.startsWith(API_PREFIX)) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '未知接口' })
        return
      }
      const rest = pathname.slice(API_PREFIX.length)
      const collection = rest === '/servers' || rest === '/servers/'
      const itemMatch = rest.match(/^\/servers\/([A-Za-z0-9_-]+)$/)

      if (req.method === 'GET' && collection) {
        const servers = await collectServers()
        sendJson(res, 200, { ok: true, homeFile: homeTarget.file, servers })
        return
      }

      if (req.method === 'POST' && collection) {
        const body = await readJsonBody(req)
        const id = requireString(body, 'id').trim()
        if (!SERVER_ID_PATTERN.test(id)) {
          throw new RouteError(400, 'INVALID_ID', `id 必须匹配 ${String(SERVER_ID_PATTERN)}（字母/数字/-/_）`)
        }
        const servers = await collectServers()
        if (servers.some(server => server.id === id)) {
          throw new RouteError(409, 'DUPLICATE_ID', `id「${id}」已存在`)
        }
        const draft = draftFromBody(body)
        let config: Record<string, unknown>
        try {
          config = parseDraftConfig(draft)
        } catch (error) {
          throw asValidationError(error)
        }
        assertServerNameFree(servers, config['serverName'] as string)
        const text = await readText(homeTarget.file)
        const existed = text !== undefined
        const doc = openPatchDocument(text ?? '[]')
        appendMcpEntry(doc, id, config)
        await (writeChain = writeChain.then(() => writeTarget(homeTarget, doc, existed)))
        sendJson(res, 200, { ok: true, homeFile: homeTarget.file, servers: await collectServers() })
        return
      }

      if (itemMatch !== null && (req.method === 'PUT' || req.method === 'DELETE')) {
        const id = itemMatch[1] ?? ''
        const located = await locateServer(id)
        if (located === undefined) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `服务器「${id}」不存在` })
          return
        }
        if (req.method === 'DELETE') {
          const { target, doc } = located
          const existed = true
          removeRow(doc, { entryIndex: located.entryIndex, rowIndex: located.rowIndex })
          await (writeChain = writeChain.then(() => writeTarget(target, doc, existed)))
          sendJson(res, 200, { ok: true, homeFile: homeTarget.file, servers: await collectServers() })
          return
        }
        const body = await readJsonBody(req)
        const draft = draftFromBody(body)
        const servers = await collectServers()
        assertServerNameFree(servers, draft.serverName.trim(), id)
        const stored = servers.find(server => server.id === id)?.config ?? {}
        let config: Record<string, unknown>
        try {
          config = mergeEditedConfig(stored, draft)
        } catch (error) {
          throw asValidationError(error)
        }
        const { target, doc } = located
        setRowConfig(doc, { entryIndex: located.entryIndex, rowIndex: located.rowIndex }, config)
        await (writeChain = writeChain.then(() => writeTarget(target, doc, true)))
        sendJson(res, 200, { ok: true, homeFile: homeTarget.file, servers: await collectServers() })
        return
      }

      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' })
    } catch (error) {
      logger.warn(error)
      sendFailure(res, error)
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    `dsh-mcp-setting: ${API_PREFIX}`,
  )
}

/** Re-exported editing vocabulary for tests and tools. */
export { MCP_CLIENT_NAME }
