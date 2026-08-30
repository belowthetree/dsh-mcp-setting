/**
 * Live connection-status inference for the MCP server rows, derived entirely
 * from facts the Host already observes — no `@deepseek-ai/dsh-mcp-client`
 * internals, which stay closed behind the plugin's own context. A row's state
 * is read from its loader entry (does the fiber exist, is the row disabled)
 * and the tool registry (are `mcp__<serverName>__*` tools currently
 * registered). Pure functions — the Host route layer owns the live probes.
 */

import type { McpServerStatus, McpServerView, McpServerState } from './types.ts'

/** Tool-name prefix one server's registered tools carry. */
function toolPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

/** Whether a row lives in a profile layer (only the active profile loads live). */
function isProfileScope(row: McpServerView): boolean {
  return row.scope.startsWith('profile:')
}

/** The minimal loader-entry surface the Host probes. */
export interface LoaderEntryProbe {
  /** Loader row id. */
  options?: { id?: string; name?: unknown }
  /** Live plugin fiber; undefined when the row never activated (disabled/failed). */
  fiber?: unknown
}

/**
 * Count the tools one server currently has registered.
 * @param config - the row's stored config (reads `serverName`).
 * @param toolNames - every currently registered tool name.
 * @returns the number of tools under the server's namespace.
 */
export function countServerTools(config: Record<string, unknown>, toolNames: Iterable<string>): number {
  const serverName = config['serverName']
  if (typeof serverName !== 'string' || serverName.length === 0) return 0
  const prefix = toolPrefix(serverName)
  let count = 0
  for (const name of toolNames) {
    if (name.startsWith(prefix)) count += 1
  }
  return count
}

/**
 * Infer one row's live status.
 * @param row - the managed server row.
 * @param entry - the row's live loader entry, or undefined when the row is
 * not mounted in this run's composition.
 * @param toolNames - every currently registered tool name.
 * @returns the inferred status.
 */
export function inferServerStatus(
  row: McpServerView,
  entry: LoaderEntryProbe | undefined,
  toolNames: Iterable<string>,
): McpServerStatus {
  // The patch file's disabled flag is authoritative for the toggle; a disabled
  // row has no fiber by definition.
  if (row.disabled) return { state: 'disabled', toolCount: 0 }
  // No loader entry: a home/profile row added moments ago is still awaiting the
  // config hot-reload; a row in a non-active profile never mounts here.
  if (entry === undefined) {
    return { state: isProfileScope(row) ? 'unloaded' : 'loading', toolCount: 0 }
  }
  // An entry without a fiber means activation failed (or is still starting).
  if (entry.fiber === undefined) return { state: 'failed', toolCount: 0 }
  // A live fiber with registered tools is serving requests. Note: a server
  // whose connection dropped keeps its previously synced tools registered
  // while the reconnect supervisor backs off, so the connected state can lag a
  // real outage by the backoff window.
  const toolCount = countServerTools(row.config, toolNames)
  return { state: toolCount > 0 ? 'connected' : 'disconnected', toolCount }
}

/** Every state the UI can render, for copy and style mapping. */
export const SERVER_STATES: readonly McpServerState[] = [
  'disabled', 'loading', 'failed', 'unloaded', 'connected', 'disconnected',
]
