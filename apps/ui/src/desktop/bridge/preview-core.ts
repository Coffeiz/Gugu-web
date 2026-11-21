import type { DesktopBridge } from '@gugu/core/desktop'

export const projectBoardMethods = [
  'projectBoard', 'projectDetails', 'createBoardProject',
  'updateBoardProject', 'deleteBoardProject', 'restoreBoardProject',
] as const satisfies readonly (keyof DesktopBridge)[]

export const workspacePreviewRoutes = [
  {
    endpoint: '/__desktop-preview/calendar',
    methods: ['calendar', 'createCalendarEvent', 'updateCalendarEvent', 'deleteCalendarEvent', 'undoPreview', 'undoApply', 'undoRedo', 'receipt'],
  },
  { endpoint: '/__desktop-preview/schedules', methods: ['scheduleTask'] },
  {
    endpoint: '/__desktop-preview/projects',
    methods: ['projects', ...projectBoardMethods, 'purgeBoardProject'],
  },
  {
    endpoint: '/__desktop-preview/mind',
    methods: [
      'notes', 'createNote', 'updateNote', 'deleteNote',
      'canvases', 'createCanvas', 'updateCanvas', 'deleteCanvas',
      'canvasItems', 'addCanvasItem', 'updateCanvasItem', 'deleteCanvasItem', 'bringCanvasItemToFront',
      'canvasRelations', 'createCanvasRelation', 'deleteCanvasRelation',
      'createCanvasNote', 'updateCanvasNote', 'canvasNoteLocation', 'createRefNode',
    ],
  },
] as const satisfies readonly { endpoint: string; methods: readonly (keyof DesktopBridge)[] }[]

export const filesPreviewRoute = { endpoint: '/__desktop-preview/files', methods: ['files', 'search', 'openDroppedFileReference'] } as const

export const resourcesPreviewRoute = { endpoint: '/__desktop-preview/resources', methods: ['resources'] } as const

export const desktopPreviewRoutes = [
  { endpoint: '/__desktop-preview/logs', methods: ['readLogs'] },
  { endpoint: '/__desktop-preview/preferences', methods: ['appearance', 'updateAppearance', 'clearAgentMemory', 'clearAgentAttachments'] },
  filesPreviewRoute,
  { endpoint: '/__desktop-preview/im', methods: ['telegramGateway', 'wechatPairing', 'feishuPairing', 'qqPairing'] },
  resourcesPreviewRoute,
  ...workspacePreviewRoutes,
] as const satisfies readonly { endpoint: string; methods: readonly (keyof DesktopBridge)[] }[]
