/**
 * Comment-preserving editor for the cordis patch documents that carry MCP
 * server rows. A patch file is a top-level YAML array of loader patch entries;
 * MCP servers are rows inside `insert` entries whose `name` is the mcp-client
 * package. All mutations go through `yaml`'s `Document` node API so untouched
 * comments, formatting, and `!!js` expression scalars survive the round-trip.
 * Pure functions — the Host route layer owns filesystem access and locking.
 */

import { isMap, isSeq, parseDocument, type Document } from 'yaml'
import type { McpServerDraft, McpServerScope, McpServerView } from './types.ts'

/** Canonical mcp-client package name used by loader rows. */
export const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'
/** Bare alias some patch files write instead of the scoped name. */
export const MCP_CLIENT_ALIAS = 'dsh-mcp-client'

/** Loader row id pattern (matches the loader's id vocabulary). */
export const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/
/** serverName pattern enforced by `@deepseek-ai/dsh-mcp-client` itself. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Address of one MCP server row inside a parsed patch document. */
export interface RowLocation {
  /** Index of the `insert` patch entry in the top-level array. */
  entryIndex: number
  /** Index of the row inside that entry's `insert` array. */
  rowIndex: number
}

/**
 * Parse one patch document. A null/absent contents (empty or comment-only
 * file) is normalized to an empty top-level array so every caller can append.
 * @param text - raw file text.
 * @returns the parsed document with an array contents.
 */
export function openPatchDocument(text: string): Document {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    const detail = doc.errors.map(error => error.message).join('; ')
    throw new Error(`配置文件不是合法 YAML：${detail}`)
  }
  if (doc.contents === null) {
    // A comment-only or empty file: seed an empty top-level array while
    // keeping the document (its header comments survive the round-trip).
    // The cast bridges the library's Parsed/plain node distinction: contents
    // is declared as the parsed union, createNode returns a plain node.
    doc.contents = doc.createNode([]) as unknown as typeof doc.contents
  }
  return doc
}

/** Whether one insert row names the mcp-client package. */
function isMcpClientName(name: unknown): boolean {
  return name === MCP_CLIENT_NAME || name === MCP_CLIENT_ALIAS
}

/**
 * Enumerate every MCP server row in one parsed patch document, in file order.
 * @param doc - parsed patch document (top-level array).
 * @param file - absolute path of the patch file, attached to each view.
 * @param scope - scope label of the file (`home` or `profile:<name>`).
 * @returns one view per mcp-client row.
 */
export function listRows(doc: Document, file: string, scope: McpServerScope): McpServerView[] {
  const contents = doc.contents
  if (!isSeq(contents)) return []
  const rows: McpServerView[] = []
  for (const entry of contents.items) {
    if (!isMap(entry)) continue
    const insert = entry.get('insert')
    if (!isSeq(insert)) continue
    for (const row of insert.items) {
      if (!isMap(row)) continue
      const name = row.get('name')
      if (!isMcpClientName(name)) continue
      const id = row.get('id')
      if (typeof id !== 'string' || id.length === 0) continue
      const config = row.get('config')
      rows.push({
        id,
        name: typeof name === 'string' ? name : MCP_CLIENT_NAME,
        config: isRecord(config) ? plainData(config) as Record<string, unknown> : {},
        scope,
        file,
      })
    }
  }
  return rows
}

/** Whether a value is a plain data object (mcp-client configs are maps). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-convert one yaml node (map/seq/alias) to plain JSON data; scalar raw
 * values pass through unchanged. `Document.get` returns map/seq nodes for
 * nested structures, which must not leak into wire payloads.
 * @param value - a raw value or yaml node read from a document.
 * @returns the plain JSON-compatible value.
 */
function plainData(value: unknown): unknown {
  const node = value as { toJSON?: unknown } | null
  return typeof node?.toJSON === 'function' ? (node as { toJSON(): unknown }).toJSON() : value
}

/**
 * Locate one row by loader id inside a parsed patch document.
 * @param doc - parsed patch document.
 * @param id - exact loader row id.
 * @returns the row address, or undefined when absent.
 */
export function locateRow(doc: Document, id: string): RowLocation | undefined {
  const contents = doc.contents
  if (!isSeq(contents)) return undefined
  for (let entryIndex = 0; entryIndex < contents.items.length; entryIndex += 1) {
    const entry = contents.items[entryIndex]
    if (!isMap(entry)) continue
    const insert = entry.get('insert')
    if (!isSeq(insert)) continue
    for (let rowIndex = 0; rowIndex < insert.items.length; rowIndex += 1) {
      const row = insert.items[rowIndex]
      if (!isMap(row)) continue
      if (!isMcpClientName(row.get('name'))) continue
      if (row.get('id') === id) return { entryIndex, rowIndex }
    }
  }
  return undefined
}

/**
 * Append one new mcp-client row as a fresh `insert` patch entry at the end of
 * the document. The created node uses the library's default (flow) style;
 * existing entries keep their exact formatting.
 * @param doc - parsed patch document.
 * @param id - new loader row id.
 * @param config - validated server config.
 */
export function appendMcpEntry(doc: Document, id: string, config: Record<string, unknown>): void {
  const contents = doc.contents
  if (!isSeq(contents)) {
    throw new Error('配置文件顶层必须是数组（loader patch 条目列表）')
  }
  contents.items.push(doc.createNode({ insert: [{ id, name: MCP_CLIENT_NAME, config }] }))
}

/**
 * Replace one row's config value. The `config` key node is swapped wholesale,
 * which keeps every sibling key's comments and formatting intact.
 * @param doc - parsed patch document.
 * @param location - row address from {@link locateRow}.
 * @param config - next validated config.
 */
export function setRowConfig(doc: Document, location: RowLocation, config: Record<string, unknown>): void {
  doc.setIn([location.entryIndex, 'insert', location.rowIndex, 'config'], config)
}

/**
 * Remove one row. When its `insert` array becomes empty the whole patch entry
 * is removed too.
 * @param doc - parsed patch document.
 * @param location - row address from {@link locateRow}.
 * @returns whether the enclosing patch entry was removed as well.
 */
export function removeRow(doc: Document, location: RowLocation): boolean {
  doc.deleteIn([location.entryIndex, 'insert', location.rowIndex])
  const contents = doc.contents
  if (!isSeq(contents)) return false
  const entry = contents.items[location.entryIndex]
  const insert = isMap(entry) ? entry.get('insert') : undefined
  if (isSeq(insert) && insert.items.length === 0) {
    doc.deleteIn([location.entryIndex])
    return true
  }
  return false
}

/**
 * Serialize a parsed patch document for writing.
 * @param doc - parsed patch document.
 * @returns the YAML text (with a trailing newline).
 */
export function serializePatch(doc: Document): string {
  return doc.toString()
}

/**
 * Parse a JSON object text (the env/headers advanced fields) into a
 * string-valued map, matching the mcp-client schema.
 * @param text - JSON object text; empty/whitespace-only means `{}`.
 * @param label - field name for failure messages.
 * @returns the parsed map.
 */
export function parseJsonObject(text: string, label: string): Record<string, string> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} 不是合法 JSON：${detail}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象（如 {"KEY": "value"}）`)
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`${label} 的值必须是字符串：${key}`)
    }
    out[key] = entry
  }
  return out
}

/**
 * Build the complete normalized config from a settings-form draft, validating
 * every field against the mcp-client contract. Unknown fields cannot arrive
 * through this path.
 * @param draft - raw form values.
 * @returns the validated config to store.
 */
export function parseDraftConfig(draft: McpServerDraft): Record<string, unknown> {
  const serverName = draft.serverName.trim()
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`serverName 必须匹配 ${String(SERVER_NAME_PATTERN)}（字母/数字/-/_，1–32 位）`)
  }
  if (draft.transport === 'stdio') {
    const command = draft.command.trim()
    if (command.length === 0) throw new Error('stdio 传输必须填写 command（启动命令）')
    const args = draft.args.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    return {
      transport: 'stdio',
      serverName,
      command,
      args,
      env: parseJsonObject(draft.envJson, 'env'),
      cwd: draft.cwd.trim(),
    }
  }
  const url = draft.url.trim()
  if (url.length === 0) throw new Error('streamable-http 传输必须填写 url')
  return {
    transport: 'streamable-http',
    serverName,
    url,
    headers: parseJsonObject(draft.headersJson, 'headers'),
  }
}

/**
 * Merge one edited config over the stored config for an update: every known
 * edited field replaces its stored value, fields of the other transport are
 * dropped, and unknown stored keys (reconnect, toolCallTimeoutMs,
 * failOnStartupError, …) are preserved so an edit never silently deletes
 * advanced settings the form does not render.
 * @param stored - the row's current config.
 * @param draft - the validated edited form values.
 * @returns the next complete config.
 */
export function mergeEditedConfig(stored: Record<string, unknown>, draft: McpServerDraft): Record<string, unknown> {
  const edited = parseDraftConfig(draft)
  const next: Record<string, unknown> = { ...stored }
  if (edited.transport === 'stdio') {
    delete next.url
    delete next.headers
  } else {
    delete next.command
    delete next.args
    delete next.env
    delete next.cwd
  }
  for (const key of ['transport', 'serverName', 'command', 'args', 'env', 'cwd', 'url', 'headers']) {
    if (key in edited) next[key] = edited[key]
  }
  return next
}
