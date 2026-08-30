import { describe, expect, it } from 'vitest'
import { countServerTools, inferServerStatus, type LoaderEntryProbe } from '../src/status.ts'
import type { McpServerView } from '../src/types.ts'

/** One home-scope row with a stdio config. */
function row(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client', disabled: false,
    status: { state: 'loading', toolCount: 0 },
    config: { transport: 'stdio', serverName: 'a', command: 'python', args: ['a.py'] },
    scope: 'home', file: 'C:/dsh/cordis.patch.yml',
    ...overrides,
  }
}

/** A loader entry with or without a live fiber. */
function entry(fiber: unknown): LoaderEntryProbe {
  return { options: { id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client' }, fiber }
}

const FIBER = { state: 'active' }

const TOOLS = ['mcp__a__read', 'mcp__a__write', 'mcp__other__ping', 'tool_fs']

describe('countServerTools', () => {
  it('counts only tools under the server namespace', () => {
    expect(countServerTools(row().config, TOOLS)).toBe(2)
  })

  it('returns 0 for an empty serverName or no matches', () => {
    expect(countServerTools({ serverName: '' }, TOOLS)).toBe(0)
    expect(countServerTools({ serverName: 'zzz' }, TOOLS)).toBe(0)
  })
})

describe('inferServerStatus', () => {
  it('reports disabled before any loader fact', () => {
    expect(inferServerStatus(row({ disabled: true }), entry(FIBER), TOOLS)).toEqual({ state: 'disabled', toolCount: 0 })
  })

  it('reports loading while the home row has no loader entry yet', () => {
    expect(inferServerStatus(row(), undefined, TOOLS)).toEqual({ state: 'loading', toolCount: 0 })
  })

  it('reports unloaded for a row in a non-active profile', () => {
    const profileRow = row({ scope: 'profile:other', file: 'C:/dsh/profiles/other/cordis.patch.yml' })
    expect(inferServerStatus(profileRow, undefined, TOOLS)).toEqual({ state: 'unloaded', toolCount: 0 })
  })

  it('reports failed when the entry exists but has no fiber', () => {
    expect(inferServerStatus(row(), entry(undefined), TOOLS)).toEqual({ state: 'failed', toolCount: 0 })
  })

  it('reports connected with the tool count for a live fiber with tools', () => {
    expect(inferServerStatus(row(), entry(FIBER), TOOLS)).toEqual({ state: 'connected', toolCount: 2 })
  })

  it('reports disconnected for a live fiber with no tools', () => {
    expect(inferServerStatus(row(), entry(FIBER), ['tool_fs'])).toEqual({ state: 'disconnected', toolCount: 0 })
  })
})
