/**
 * dsh-mcp-setting plugin, browser half: registers the MCP 服务器 page into
 * the settings panel's `settings.section` navigation. The page reads and
 * mutates the mcp-client rows of the harness's cordis patch files through the
 * Host's `/dsh-mcp-setting/api` routes (plain fetch, same origin); the
 * controller's snapshot store is shared through the inject `hooks`
 * compartment, which the renderer binds to `useMcpServers`.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings SlotMap merge (the settings.section seat).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { McpServerDraft } from '../types.ts'
import { McpSettingsController, type McpSettingsState } from './controller.ts'
import { McpSettingsSection } from './McpSettingsSection.tsx'
import { en, zh, type McpSettingsKey } from './locales.ts'

export type { McpSettingsState } from './controller.ts'
export type { McpSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The MCP settings page copy. */
    mcpsetting: McpSettingsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'mcpsetting'

/** Injected business face of the settings section seat. */
export interface McpSettingsInjected {
  /** Reserved observable compartment; binds to `useMcpServers` on the component. */
  hooks: { mcpServers: SnapshotStore<McpSettingsState> }
  /**
   * Re-read the server list from the Host.
   * @returns settlement after the read.
   */
  reload: () => Promise<void>
  /**
   * Add one new server to the home patch.
   * @param id - new loader row id.
   * @param draft - validated form values.
   * @returns null on success; the Host's failure text otherwise.
   */
  add: (id: string, draft: McpServerDraft) => Promise<string | null>
  /**
   * Update one server in place (id is immutable).
   * @param id - loader row id of the server to update.
   * @param draft - validated form values.
   * @returns null on success; the Host's failure text otherwise.
   */
  update: (id: string, draft: McpServerDraft) => Promise<string | null>
  /**
   * Remove one server from whichever patch file it lives in.
   * @param id - loader row id of the server to remove.
   * @returns null on success; the Host's failure text otherwise.
   */
  remove: (id: string) => Promise<string | null>
}

/** Required services: the settings seat's slot registry and the locale runtime. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the MCP server settings page over the Host API
 * routes.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-setting: dictionaries')

  const controller = new McpSettingsController()

  // The page shows a reload button, but the initial read also runs eagerly so
  // opening Settings never waits for a fetch round-trip.
  ctx.effect(() => {
    void controller.load()
    return () => undefined
  }, 'dsh-mcp-setting: initial load')

  // Registration-time text (the nav label thunk) rides the locale runtime, so
  // the shell re-resolves it whenever the locale revision moves.
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-mcp-setting',
    order: 22,
    label: () => t('nav.label'),
    locale: NS,
    inject: (): McpSettingsInjected => ({
      hooks: { mcpServers: controller.store },
      reload: () => controller.load(),
      add: (id, draft) => controller.add(id, draft),
      update: (id, draft) => controller.update(id, draft),
      remove: (id) => controller.remove(id),
    }),
  }, McpSettingsSection))
}
