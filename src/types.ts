/**
 * Wire vocabulary shared by the dsh-mcp-setting Host and Client halves: the
 * `/dsh-mcp-setting/api` route prefix, the server-row JSON types, and the
 * settings page's edit draft. Pure types and constants only — no Node or DOM
 * imports, so both planes (and tests) can import this module.
 */

/** Route prefix under which every dsh-mcp-setting API endpoint lives. */
export const API_PREFIX = '/dsh-mcp-setting/api'
/** Collection endpoint: GET list / POST add; item endpoints append `/:<id>`. */
export const SERVERS_ROUTE = `${API_PREFIX}/servers`

/** Transport kinds accepted by `@deepseek-ai/dsh-mcp-client`. */
export type McpTransport = 'stdio' | 'streamable-http'

/** Where one server row lives: the home patch or one profile's patch. */
export type McpServerScope = 'home' | `profile:${string}`

/** One managed server row as the settings page lists it. */
export interface McpServerView {
  /** Loader row id (`mcp-<name>`), unique across every scanned patch file. */
  id: string
  /** Plugin package name of the row (always the mcp-client package). */
  name: string
  /** Raw stored row config (JSON-safe; unknown keys preserved on update). */
  config: Record<string, unknown>
  /** Patch file this row lives in. */
  scope: McpServerScope
  /** Absolute path of the patch file this row lives in. */
  file: string
}

/**
 * One user edit from the settings form. Text fields are raw strings the Host
 * validates and normalizes: `args` is newline-separated, `envJson`/`headersJson`
 * are JSON object texts (empty string = empty object).
 */
export interface McpServerDraft {
  serverName: string
  transport: McpTransport
  command: string
  args: string
  cwd: string
  envJson: string
  url: string
  headersJson: string
}

/** GET /servers success payload. */
export interface McpServersResponse {
  ok: true
  /** Absolute path of the home patch new servers are added to. */
  homeFile: string
  /** Every MCP server row across the home patch and all profile patches. */
  servers: McpServerView[]
}

/** Failure envelope shared by every endpoint. */
export interface McpErrorResponse {
  ok: false
  /** Stable machine code, e.g. `DUPLICATE_SERVER_NAME`. */
  code: string
  /** User-facing (Chinese) failure text. */
  message: string
}

/** Union of every API response body. */
export type McpApiResponse = McpServersResponse | McpErrorResponse
