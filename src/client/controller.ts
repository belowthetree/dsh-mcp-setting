/**
 * Settings-page transport for the MCP server editor: reads the server list
 * and applies user edits through the Host's `/dsh-mcp-setting/api` routes,
 * mirroring results in a snapshot store the section renders through. Every
 * mutation reloads the list so the page always reflects the committed file
 * state.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { SERVERS_ROUTE } from '../types.ts'
import type { McpApiResponse, McpServerDraft, McpServerView } from '../types.ts'

/** Snapshot state mirrored from the Host's server list. */
export interface McpSettingsState {
  /** `loading` until the first accepted list; `error` after a failed load. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Absolute path of the home patch new servers are added to. */
  homeFile: string | null
  /** Every managed server row, in file order. */
  servers: McpServerView[]
  /** Human failure text of the latest load or mutation; null while healthy. */
  error: string | null
}

/** Human text for a rejected wire call or transport failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Call one API endpoint and unwrap the envelope. A non-ok envelope or a
 * transport failure throws with the Host's (or a synthesized) message.
 * @param path - absolute API path.
 * @param init - fetch options (method, body).
 * @returns the ok-branch payload.
 */
async function callApi(path: string, init?: RequestInit): Promise<Extract<McpApiResponse, { ok: true }>> {
  let response: Response
  try {
    response = await fetch(path, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...init,
    })
  } catch (error) {
    throw new Error(`无法连接 MCP 配置服务：${messageOf(error)}`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`MCP 配置服务返回了无法解析的响应（HTTP ${response.status}）`)
  }
  if (typeof body !== 'object' || body === null || typeof (body as McpApiResponse)['ok'] !== 'boolean') {
    throw new Error(`MCP 配置服务返回了无法识别的响应（HTTP ${response.status}）`)
  }
  const envelope = body as McpApiResponse
  if (!envelope.ok) throw new Error(envelope.message)
  return envelope
}

/**
 * Serializes the Host list and mutation calls behind one snapshot store.
 * Latest load wins; a refused mutation reloads the list so the form
 * re-renders from the fresh state.
 */
export class McpSettingsController {
  /** uSES-safe state source the section renders through its hooks compartment. */
  readonly store: SnapshotStore<McpSettingsState> = createSnapshotStore<McpSettingsState>({
    status: 'idle', homeFile: null, servers: [], error: null,
  })

  private generation = 0

  /**
   * Refresh the snapshot from `GET /servers`; a failure keeps the last good
   * state and surfaces the error.
   * @returns settlement after the read.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const response = await callApi(SERVERS_ROUTE)
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'ready'
        state.homeFile = response.homeFile
        state.servers = response.servers
        state.error = null
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
    }
  }

  /**
   * Apply one mutation and reload; a refusal returns its message.
   * @param request - the fetch request (method, path, optional JSON body).
   * @returns null on success; the Host's failure text otherwise.
   */
  private async mutate(request: { path: string; method: 'POST' | 'PUT' | 'DELETE'; body?: string }): Promise<string | null> {
    try {
      const init: RequestInit = {
        method: request.method,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      }
      if (request.body !== undefined) init.body = request.body
      await callApi(request.path, init)
    } catch (error) {
      await this.load()
      return messageOf(error)
    }
    await this.load()
    return null
  }

  /**
   * Add one new server to the home patch.
   * @param id - new loader row id.
   * @param draft - validated form values.
   * @returns null on success; the Host's failure text otherwise.
   */
  add(id: string, draft: McpServerDraft): Promise<string | null> {
    return this.mutate({ path: SERVERS_ROUTE, method: 'POST', body: JSON.stringify({ id, ...draft }) })
  }

  /**
   * Update one server in place (id is immutable).
   * @param id - loader row id of the server to update.
   * @param draft - validated form values.
   * @returns null on success; the Host's failure text otherwise.
   */
  update(id: string, draft: McpServerDraft): Promise<string | null> {
    return this.mutate({ path: `${SERVERS_ROUTE}/${encodeURIComponent(id)}`, method: 'PUT', body: JSON.stringify(draft) })
  }

  /**
   * Remove one server from whichever patch file it lives in.
   * @param id - loader row id of the server to remove.
   * @returns null on success; the Host's failure text otherwise.
   */
  remove(id: string): Promise<string | null> {
    return this.mutate({ path: `${SERVERS_ROUTE}/${encodeURIComponent(id)}`, method: 'DELETE' })
  }
}
