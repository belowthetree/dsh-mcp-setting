import { describe, expect, it } from 'vitest'
import {
  MCP_CLIENT_NAME,
  appendMcpEntry,
  listRows,
  locateRow,
  mergeEditedConfig,
  openPatchDocument,
  parseDraftConfig,
  removeRow,
  serializePatch,
  setRowConfig,
} from '../src/patch-editor.ts'
import type { McpServerDraft } from '../src/types.ts'

/** Home-style patch: two mcp-client rows (one per entry) plus a foreign row. */
const SAMPLE_PATCH = [
  '# MCP servers, machine-local.',
  '- insert:',
  '    - id: mcp-a',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        transport: stdio',
  '        serverName: a',
  '        command: python',
  '        args:',
  '          - a.py',
  '        reconnect: {enabled: true}',
  '- insert:',
  '    - id: mcp-b',
  "      name: 'dsh-mcp-client'",
  '      config:',
  '        transport: streamable-http',
  '        serverName: b',
  '        url: http://localhost:8000/mcp',
  '- insert:',
  '    - id: other-plugin',
  "      name: 'dsh-qqbot'",
].join('\n')

const HOME = 'C:/dsh/cordis.patch.yml'

function draft(overrides: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    serverName: 'new', transport: 'stdio', command: 'python', args: 'srv.py\n--port 9000',
    cwd: '', envJson: '', url: '', headersJson: '', ...overrides,
  }
}

describe('listRows', () => {
  it('finds rows under the canonical and alias package names, in order', () => {
    const doc = openPatchDocument(SAMPLE_PATCH)
    const rows = listRows(doc, HOME, 'home')
    expect(rows.map(row => row.id)).toEqual(['mcp-a', 'mcp-b'])
    expect(rows[0]).toMatchObject({ name: MCP_CLIENT_NAME, scope: 'home', file: HOME })
    expect(rows[0]?.config).toMatchObject({ serverName: 'a', command: 'python' })
    expect(rows[1]?.config).toMatchObject({ serverName: 'b', url: 'http://localhost:8000/mcp' })
  })

  it('returns an empty list for a document without mcp rows', () => {
    const doc = openPatchDocument('- insert:\n    - id: x\n      name: "dsh-qqbot"\n')
    expect(listRows(doc, HOME, 'home')).toEqual([])
  })

  it('treats an empty or comment-only file as an empty document', () => {
    expect(listRows(openPatchDocument('# nothing'), HOME, 'home')).toEqual([])
    expect(listRows(openPatchDocument(''), HOME, 'home')).toEqual([])
  })

  it('throws with a message on invalid YAML', () => {
    expect(() => openPatchDocument('- insert: [unclosed')).toThrow(/不是合法 YAML/)
  })
})

describe('locateRow', () => {
  it('finds a row by id and reports its address', () => {
    const doc = openPatchDocument(SAMPLE_PATCH)
    expect(locateRow(doc, 'mcp-a')).toEqual({ entryIndex: 0, rowIndex: 0 })
    expect(locateRow(doc, 'mcp-b')).toEqual({ entryIndex: 1, rowIndex: 0 })
    expect(locateRow(doc, 'missing')).toBeUndefined()
  })
})

describe('appendMcpEntry', () => {
  it('appends a fresh insert entry and preserves existing comments', () => {
    const doc = openPatchDocument(SAMPLE_PATCH)
    appendMcpEntry(doc, 'mcp-c', { transport: 'stdio', serverName: 'c', command: 'node', args: [] })
    const text = serializePatch(doc)
    expect(text).toContain('# MCP servers, machine-local.')
    const reparsed = openPatchDocument(text)
    expect(listRows(reparsed, HOME, 'home').map(row => row.id)).toEqual(['mcp-a', 'mcp-b', 'mcp-c'])
    const location = locateRow(reparsed, 'mcp-c')
    expect(location).toEqual({ entryIndex: 3, rowIndex: 0 })
  })
})

describe('setRowConfig', () => {
  it('replaces only the config value and keeps sibling formatting', () => {
    const doc = openPatchDocument(SAMPLE_PATCH)
    const location = locateRow(doc, 'mcp-a')
    expect(location).toBeDefined()
    setRowConfig(doc, location!, { transport: 'stdio', serverName: 'a', command: 'python', args: ['b.py'] })
    const text = serializePatch(doc)
    expect(text).toContain('command: python')
    expect(text).toContain('- b.py')
    expect(text).toContain('# MCP servers, machine-local.')
    const rows = listRows(openPatchDocument(text), HOME, 'home')
    expect(rows[0]?.config).toEqual({ transport: 'stdio', serverName: 'a', command: 'python', args: ['b.py'] })
    expect(rows[1]?.id).toBe('mcp-b')
  })
})

describe('removeRow', () => {
  it('removes the row and leaves the entry when other rows remain', () => {
    const twoRows = [
      '- insert:',
      '    - id: mcp-a',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config: {transport: stdio, serverName: a, command: python}',
      '    - id: mcp-b',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config: {transport: stdio, serverName: b, command: node}',
    ].join('\n')
    const doc = openPatchDocument(twoRows)
    const location = locateRow(doc, 'mcp-a')
    expect(location).toBeDefined()
    const removedEntry = removeRow(doc, location!)
    expect(removedEntry).toBe(false)
    const rows = listRows(openPatchDocument(serializePatch(doc)), HOME, 'home')
    expect(rows.map(row => row.id)).toEqual(['mcp-b'])
  })

  it('removes the whole insert entry when it becomes empty', () => {
    const doc = openPatchDocument(SAMPLE_PATCH)
    const location = locateRow(doc, 'mcp-b')
    expect(location).toBeDefined()
    const removedEntry = removeRow(doc, location!)
    expect(removedEntry).toBe(true)
    const text = serializePatch(doc)
    expect(text).not.toContain('mcp-b')
    expect(listRows(openPatchDocument(text), HOME, 'home').map(row => row.id)).toEqual(['mcp-a'])
  })
})

describe('parseDraftConfig', () => {
  it('builds a stdio config with parsed args and env', () => {
    const config = parseDraftConfig(draft({ envJson: '{"K": "v"}' }))
    expect(config).toEqual({
      transport: 'stdio', serverName: 'new', command: 'python',
      args: ['srv.py', '--port 9000'], env: { K: 'v' }, cwd: '',
    })
  })

  it('builds a streamable-http config with headers', () => {
    const config = parseDraftConfig(draft({ transport: 'streamable-http', url: 'http://x/mcp', headersJson: '{"A": "1"}' }))
    expect(config).toEqual({ transport: 'streamable-http', serverName: 'new', url: 'http://x/mcp', headers: { A: '1' } })
  })

  it('rejects a bad serverName', () => {
    expect(() => parseDraftConfig(draft({ serverName: 'bad name!' }))).toThrow(/serverName 必须匹配/)
  })

  it('rejects a missing command on stdio and a missing url on http', () => {
    expect(() => parseDraftConfig(draft({ command: '  ' }))).toThrow(/必须填写 command/)
    expect(() => parseDraftConfig(draft({ transport: 'streamable-http', url: '' }))).toThrow(/必须填写 url/)
  })

  it('rejects invalid env JSON and non-string values', () => {
    expect(() => parseDraftConfig(draft({ envJson: '{bad' }))).toThrow(/env 不是合法 JSON/)
    expect(() => parseDraftConfig(draft({ envJson: '{"K": 5}' }))).toThrow(/值必须是字符串/)
  })
})

describe('mergeEditedConfig', () => {
  const stored = {
    transport: 'stdio', serverName: 'a', command: 'python', args: ['a.py'],
    env: {}, cwd: '', toolCallTimeoutMs: 30_000, reconnect: { enabled: true },
  }

  it('preserves unknown advanced keys and drops the other transport side', () => {
    const next = mergeEditedConfig(stored, draft({ serverName: 'a', command: 'python3' }))
    expect(next).toMatchObject({
      serverName: 'a', command: 'python3', toolCallTimeoutMs: 30_000, reconnect: { enabled: true },
    })
    expect(next['url']).toBeUndefined()
    expect(next['headers']).toBeUndefined()
  })

  it('switching transport drops the stdio fields', () => {
    const next = mergeEditedConfig(stored, draft({
      transport: 'streamable-http', serverName: 'a', url: 'http://y/mcp',
    }))
    expect(next).toMatchObject({
      transport: 'streamable-http', serverName: 'a', url: 'http://y/mcp',
      toolCallTimeoutMs: 30_000,
    })
    expect(next['command']).toBeUndefined()
    expect(next['args']).toBeUndefined()
    expect(next['env']).toBeUndefined()
    expect(next['cwd']).toBeUndefined()
  })
})
