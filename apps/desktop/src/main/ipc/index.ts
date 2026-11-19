import { systemHandlers } from './system.js'
import { projectsHandlers } from './projects.js'
import { clientsHandlers } from './clients.js'
import { calendarHandlers } from './calendar.js'
import { canvasHandlers } from './canvas.js'
import { notesHandlers } from './notes.js'
import { operationsHandlers } from './operations.js'
import type { IpcHost, IpcHandlers } from './types.js'

export function desktopHandlers(host: IpcHost, diagnostics: () => Promise<unknown>): IpcHandlers {
  return {
    ...systemHandlers(host),
    ...projectsHandlers(host),
    ...clientsHandlers(host),
    ...calendarHandlers(host),
    ...canvasHandlers(host),
    ...notesHandlers(host),
    ...operationsHandlers(host, diagnostics),
  }
}
