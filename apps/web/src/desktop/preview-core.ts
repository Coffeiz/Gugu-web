import type { DesktopBridge } from '@gugu/core/desktop'

export const projectBoardMethods = [
  'projectBoard', 'projectDetails', 'createBoardProject',
  'updateBoardProject', 'deleteBoardProject', 'restoreBoardProject',
] as const satisfies readonly (keyof DesktopBridge)[]

export const desktopPreviewRoutes = [
  {
    endpoint: '/__desktop-preview/calendar',
    methods: ['calendar', 'createCalendarEvent', 'updateCalendarEvent', 'deleteCalendarEvent', 'undoPreview', 'undoApply', 'undoRedo', 'receipt'],
  },
  {
    endpoint: '/__desktop-preview/projects',
    methods: ['projects', ...projectBoardMethods],
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
