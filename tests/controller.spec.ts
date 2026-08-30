/**
 * McpSettingsController over a fake fetch wire face (node env): loads mirror
 * the server list, mutations serialize as POST/PUT/DELETE calls, failures
 * reload and surface their message. The runtime snapshot store is mocked
 * because the published `dsh-client-runtime/client` bundle runs the browser
 * module-loader wrapper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpSettingsController } from '../src/client/controller.ts'
import type { McpServerView } from '../src/types.ts'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => {
  const createSnapshotStore = <T,>(initial: T) => {
    let state: T = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update: (mutator: (draft: T) => void) => {
        const draft = structuredClone(state) as T
        mutator(draft)
        state = draft
        for (const listener of listeners) listener()
      },
    }
  }
  return { createSnapshotStore }
})

const serverA: McpServerView = {
  id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client', disabled: false,
  status: { state: 'connected', toolCount: 2 },
  config: { transport: 'stdio', serverName: 'a', command: 'python', args: [] },
  scope: 'home', file: 'C:/dsh/cordis.patch.yml',
}

const LIST_RESPONSE = { ok: true, homeFile: 'C:/dsh/cordis.patch.yml', servers: [serverA] }

/** Fake response matching the wire surface the controller reads (status/json). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** One complete edit draft for the mutation tests. */
function draft(): Parameters<McpSettingsController['add']>[1] {
  return {
    serverName: 'new', transport: 'stdio', command: 'python', args: '', cwd: '', envJson: '', url: '', headersJson: '',
  }
}

describe('McpSettingsController', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the server list into the snapshot store', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(jsonResponse(LIST_RESPONSE))
    const controller = new McpSettingsController()
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      homeFile: 'C:/dsh/cordis.patch.yml',
      error: null,
    })
    expect(controller.store.getSnapshot().servers).toEqual([serverA])
    expect(fetchMock).toHaveBeenCalledWith('/dsh-mcp-setting/api/servers', expect.objectContaining({ cache: 'no-store' }))
  })

  it('surfaces a non-ok envelope as the error state', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: false, code: 'INTERNAL', message: '磁盘写入失败' }))
    const controller = new McpSettingsController()
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('磁盘写入失败')
  })

  it('surfaces a transport failure as the error state', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))
    const controller = new McpSettingsController()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
  })

  it('silent load keeps the ready status instead of flashing loading', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(LIST_RESPONSE))
    const controller = new McpSettingsController()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')
    await controller.load(true)
    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('add returns null on success and reloads the list', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse(LIST_RESPONSE))
    const controller = new McpSettingsController()
    const failure = await controller.add('mcp-new', draft())
    expect(failure).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const postCall = fetchMock.mock.calls[0]
    expect(postCall[0]).toBe('/dsh-mcp-setting/api/servers')
    expect(postCall[1]).toMatchObject({ method: 'POST' })
    expect(controller.store.getSnapshot().servers).toEqual([serverA])
  })

  it('add returns the Host failure text and reloads', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: false, code: 'DUPLICATE_ID', message: 'id「mcp-a」已存在' }))
      .mockResolvedValueOnce(jsonResponse(LIST_RESPONSE))
    const controller = new McpSettingsController()
    const failure = await controller.add('mcp-a', draft())
    expect(failure).toBe('id「mcp-a」已存在')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('remove issues DELETE against the item route', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ...LIST_RESPONSE, servers: [] }))
    const controller = new McpSettingsController()
    const failure = await controller.remove('mcp-a')
    expect(failure).toBeNull()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/dsh-mcp-setting/api/servers/mcp-a')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' })
    expect(controller.store.getSnapshot().servers).toEqual([])
  })

  it('setEnabled PUTs the disabled flag against the item route and reloads', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ...LIST_RESPONSE, servers: [{ ...serverA, disabled: true }] }))
    const controller = new McpSettingsController()
    const failure = await controller.setEnabled('mcp-a', true)
    expect(failure).toBeNull()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/dsh-mcp-setting/api/servers/mcp-a/disabled')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ disabled: true })
    expect(controller.store.getSnapshot().servers[0]?.disabled).toBe(true)
  })

  it('setEnabled returns the Host failure text and reloads', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: false, code: 'NOT_FOUND', message: '服务器「mcp-a」不存在' }))
      .mockResolvedValueOnce(jsonResponse(LIST_RESPONSE))
    const controller = new McpSettingsController()
    const failure = await controller.setEnabled('mcp-a', false)
    expect(failure).toBe('服务器「mcp-a」不存在')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('restart POSTs the restart route without reloading the list', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const controller = new McpSettingsController()
    const failure = await controller.restart()
    expect(failure).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/dsh-mcp-setting/api/restart')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('restart returns the Host failure text when refused', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: false, code: 'FORBIDDEN', message: '仅允许本机访问' }))
    const controller = new McpSettingsController()
    const failure = await controller.restart()
    expect(failure).toBe('仅允许本机访问')
  })
})
