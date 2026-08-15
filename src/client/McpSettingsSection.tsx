import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings SlotMap merge (the settings.section seat).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { McpServerDraft, McpServerView, McpTransport } from '../types.ts'
import type { McpSettingsInjected } from './index.ts'
import css from './McpSettingsSection.module.css'

/** Full settings.section component props: runtime share + injected share + the locale seat. */
export type McpSettingsSectionProps =
  PropsRuntime<'settings.section'> & InjectFace<McpSettingsInjected> & PropsLocale<'mcpsetting'>

/** Blank form values for a new server. */
function blankDraft(): McpServerDraft {
  return {
    serverName: '', transport: 'stdio', command: '', args: '', cwd: '', envJson: '', url: '', headersJson: '',
  }
}

/** Pretty-print a stored JSON object field for the advanced inputs. */
function stringifyObject(value: unknown): string {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? JSON.stringify(value, null, 2)
    : ''
}

/** Prefill the form from a stored row config, tolerating missing fields. */
function draftFromServer(server: McpServerView): McpServerDraft {
  const config = server.config
  const transport: McpTransport = config['transport'] === 'stdio' ? 'stdio' : 'streamable-http'
  const text = (key: string): string => (typeof config[key] === 'string' ? String(config[key]) : '')
  const lines = (key: string): string => Array.isArray(config[key])
    ? config[key].filter(entry => typeof entry === 'string').join('\n')
    : ''
  return {
    serverName: text('serverName'),
    transport,
    command: text('command'),
    args: lines('args'),
    cwd: text('cwd'),
    envJson: stringifyObject(config['env']),
    url: text('url'),
    headersJson: stringifyObject(config['headers']),
  }
}

/** Read one string field of a stored config, tolerating missing fields. */
function configText(config: Record<string, unknown>, key: string): string {
  return typeof config[key] === 'string' ? config[key] : ''
}

/** Endpoint summary line of one server, for the list. */
function endpointSummary(server: McpServerView): string {
  const config = server.config
  if (config['transport'] === 'stdio') {
    const command = configText(config, 'command')
    const args = Array.isArray(config['args']) ? config['args'].filter(entry => typeof entry === 'string') : []
    return [command, ...args].join(' ')
  }
  return configText(config, 'url')
}

/** One user-facing outcome line after a mutation. */
interface Message {
  readonly kind: 'ok' | 'error'
  readonly text: string
}

/**
 * The MCP server settings page: lists every mcp-client row across the home
 * and profile patch files, and adds/edits/deletes rows through the Host's
 * `/dsh-mcp-setting/api` routes. Mutations write the patch file and reload the
 * list; the page explains that changes take effect after a restart.
 */
export function McpSettingsSection({ useMcpServers, reload, add, update, remove, t }: McpSettingsSectionProps) {
  const snapshot = useMcpServers(state => state)
  const [form, setForm] = useState<McpServerDraft>(blankDraft)
  const [newId, setNewId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const setField = (key: keyof McpServerDraft, value: string): void => {
    setForm(current => ({ ...current, [key]: value }))
  }

  const startEdit = (server: McpServerView): void => {
    setEditingId(server.id)
    setForm(draftFromServer(server))
    setMessage(null)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setForm(blankDraft())
    setMessage(null)
  }

  const finish = (failure: string | null, okText: string): void => {
    setBusy(false)
    if (failure === null) {
      setMessage({ kind: 'ok', text: okText })
      if (editingId === null) {
        setNewId('')
        setForm(blankDraft())
      } else {
        cancelEdit()
      }
    } else {
      setMessage({ kind: 'error', text: `${t('msg.failed')}${failure}` })
    }
  }

  const runMutation = (operation: Promise<string | null>, okText: string): void => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    void operation.then(
      failure => { finish(failure, okText) },
      (error: unknown) => {
        setBusy(false)
        setMessage({ kind: 'error', text: `${t('msg.failed')}${error instanceof Error ? error.message : String(error)}` })
      },
    )
  }

  const onSubmit = (): void => {
    if (busy) return
    if (editingId !== null) {
      runMutation(update(editingId, form), t('msg.updated'))
    } else {
      const id = newId.trim()
      if (id.length === 0) {
        setMessage({ kind: 'error', text: t('msg.failed') + t('form.id.label') })
        return
      }
      runMutation(add(id, form), t('msg.added'))
    }
  }

  const onDelete = (server: McpServerView): void => {
    if (confirmingId === server.id) {
      setConfirmingId(null)
      runMutation(remove(server.id), t('msg.removed'))
    } else {
      setConfirmingId(server.id)
    }
  }

  const onReload = (): void => {
    if (busy) return
    void reload().catch(() => undefined)
  }

  let statusLine: string | null = null
  if (snapshot.status === 'loading') statusLine = t('status.loading')
  else if (snapshot.status === 'error') statusLine = `${t('status.error')} ${snapshot.error ?? ''}`

  const editing = editingId !== null
  const submitLabel = busy
    ? (editing ? t('form.save.busy') : t('form.add.busy'))
    : (editing ? t('form.save.label') : t('form.add.label'))

  return (
    <section className={css.section}>
      <div className={css.headerRow}>
        <h3 className={css.title}>{t('title')}</h3>
        <button type="button" className={css.linkButton} onClick={onReload} disabled={busy}>{t('reload.label')}</button>
      </div>
      <p className={css.desc}>{t('desc')}</p>
      <p className={css.fileLine}>
        <span className={css.fileLabel}>{t('file.label')}</span>
        <code className={css.filePath}>{snapshot.homeFile ?? '—'}</code>
        <span className={css.restartNote}>{t('applies.restart')}</span>
      </p>

      {statusLine !== null ? <p className={css.messageError}>{statusLine}</p> : null}

      <form className={css.form} onSubmit={event => { event.preventDefault(); onSubmit() }}>
        <h4 className={css.formTitle}>{editing ? `${t('form.edit.title')} ${editingId}` : t('form.add.title')}</h4>

        {!editing
          ? (
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('form.id.label')}</span>
              <input
                className={css.input}
                value={newId}
                onChange={event => { setNewId(event.target.value) }}
                placeholder={t('form.id.placeholder')}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <span className={css.fieldHint}>{t('form.id.hint')}</span>
            </label>
          )
          : null}

        <div className={css.fieldRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('form.serverName.label')}</span>
            <input
              className={css.input}
              value={form.serverName}
              onChange={event => { setField('serverName', event.target.value) }}
              placeholder={t('form.serverName.placeholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('form.transport.label')}</span>
            <select
              className={css.input}
              value={form.transport}
              onChange={event => { setField('transport', event.target.value as McpTransport) }}
              disabled={busy}
            >
              <option value="stdio">{t('transport.stdio')}</option>
              <option value="streamable-http">{t('transport.http')}</option>
            </select>
          </label>
        </div>

        {form.transport === 'stdio'
          ? (
            <>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('form.command.label')}</span>
                <input
                  className={css.input}
                  value={form.command}
                  onChange={event => { setField('command', event.target.value) }}
                  placeholder={t('form.command.placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('form.args.label')}</span>
                <textarea
                  className={css.textarea}
                  value={form.args}
                  onChange={event => { setField('args', event.target.value) }}
                  placeholder={t('form.args.placeholder')}
                  rows={3}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <div className={css.fieldRow}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('form.cwd.label')}</span>
                  <input
                    className={css.input}
                    value={form.cwd}
                    onChange={event => { setField('cwd', event.target.value) }}
                    placeholder={t('form.cwd.placeholder')}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('form.env.label')}</span>
                  <textarea
                    className={css.textarea}
                    value={form.envJson}
                    onChange={event => { setField('envJson', event.target.value) }}
                    placeholder={t('form.env.placeholder')}
                    rows={2}
                    spellCheck={false}
                    disabled={busy}
                  />
                </label>
              </div>
            </>
          )
          : (
            <>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('form.url.label')}</span>
                <input
                  className={css.input}
                  value={form.url}
                  onChange={event => { setField('url', event.target.value) }}
                  placeholder={t('form.url.placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('form.headers.label')}</span>
                <textarea
                  className={css.textarea}
                  value={form.headersJson}
                  onChange={event => { setField('headersJson', event.target.value) }}
                  placeholder={t('form.headers.placeholder')}
                  rows={2}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
            </>
          )
        }

        <div className={css.actions}>
          <button type="submit" className={css.primaryButton} disabled={busy}>{submitLabel}</button>
          {editing
            ? <button type="button" className={css.ghostButton} onClick={cancelEdit} disabled={busy}>{t('form.cancel.label')}</button>
            : null}
        </div>
      </form>

      <h4 className={css.listTitle}>{t('list.title')}</h4>
      {snapshot.servers.length === 0
        ? <p className={css.empty}>{t('list.empty')}</p>
        : (
          <ul className={css.list}>
            {snapshot.servers.map(server => (
              <li key={server.id} className={css.row}>
                <div className={css.rowMain}>
                  <span className={css.rowName}>{configText(server.config, 'serverName') || server.id}</span>
                  <code className={css.rowId}>{server.id}</code>
                  <span className={server.scope === 'home' ? css.badgeHome : css.badgeProfile}>
                    {server.scope === 'home' ? t('row.scope.home') : `${t('row.scope.profile')}: ${server.scope.slice('profile:'.length)}`}
                  </span>
                  <span className={css.rowTransport}>{configText(server.config, 'transport')}</span>
                </div>
                <div className={css.rowSummary}>
                  <code className={css.rowCommand}>{endpointSummary(server)}</code>
                </div>
                <div className={css.rowActions}>
                  <button type="button" className={css.linkButton} onClick={() => { startEdit(server) }} disabled={busy}>{t('row.edit')}</button>
                  {confirmingId === server.id
                    ? (
                      <>
                        <button type="button" className={css.dangerButton} onClick={() => { onDelete(server) }} disabled={busy}>{t('row.confirmDelete')}</button>
                        <button type="button" className={css.ghostButton} onClick={() => { setConfirmingId(null) }} disabled={busy}>{t('row.cancelDelete')}</button>
                      </>
                    )
                    : (
                      <button type="button" className={css.dangerLink} onClick={() => { onDelete(server) }} disabled={busy}>{t('row.delete')}</button>
                    )}
                </div>
              </li>
            ))}
          </ul>
        )
      }

      {message !== null
        ? <p className={message.kind === 'ok' ? css.messageOk : css.messageError}>{message.text}</p>
        : null}
    </section>
  )
}
