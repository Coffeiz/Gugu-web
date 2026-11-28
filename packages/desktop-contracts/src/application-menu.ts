export const applicationMenuChannels = {
  command: 'gugu:application-menu:command',
  edit: 'gugu:application-menu:edit',
} as const

export type ApplicationMenuCommand =
  | 'settings' | 'new-project' | 'new-note' | 'search'
  | 'projects' | 'calendar' | 'notes' | 'canvases' | 'files'

export const applicationEditKeys = {
  undo: 'z',
  redo: 'z',
  cut: 'x',
  copy: 'c',
  paste: 'v',
  selectAll: 'a',
} as const

export type ApplicationEditAction = keyof typeof applicationEditKeys

export interface ApplicationMenuBridge {
  onCommand(listener: (command: ApplicationMenuCommand) => void): () => void
}
