import { DESKTOP_CHANNELS, type DesktopSearchResult } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import { systemHandlers } from './system.js'
import { projectsHandlers } from './projects.js'
import { clientsHandlers } from './clients.js'
import { calendarHandlers } from './calendar.js'
import { canvasHandlers } from './canvas.js'
import { notesHandlers } from './notes.js'
import { operationsHandlers } from './operations.js'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

export function workspaceHandlers(host: IpcHost, diagnostics: () => Promise<unknown>,
  searchFiles?: (queries: readonly string[]) => Promise<Pick<DesktopSearchResult, 'groups' | 'partial'>>,
  resolveFileReference?: (id: string) => Promise<string | null>,
): IpcHandlers {
  return {
    ...(searchFiles ? { [DESKTOP_CHANNELS.search]: async (value: unknown) => {
      if (!Array.isArray(value) || value.length > 8 || value.some(term => typeof term !== 'string' || [...term].length > 64))
        throw new DesktopError('invalid_request', '搜索关键词无效')
      const queries = value.map((term: string) => term.trim()).filter(Boolean)
      const [business, files] = await Promise.all([
        host.request<DesktopSearchResult>('desktop.search', { queries }), searchFiles(queries),
      ])
      return { ...business, partial: files.partial, total: business.total + files.groups.reduce((sum, group) => sum + group.items.length, 0),
        groups: [...business.groups, ...files.groups] }
    } } : {}),
    ...systemHandlers(host),
    ...projectsHandlers(host),
    ...clientsHandlers(host),
    ...calendarHandlers(host),
    ...canvasHandlers(host, resolveFileReference),
    ...notesHandlers(host),
    ...operationsHandlers(host, diagnostics),
  }
}
