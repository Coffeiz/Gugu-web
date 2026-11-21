import { DesktopError } from '../core-host.js'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { IpcHost, IpcHandlers } from '../ipc/types.js'

export function canvasHandlers(host: IpcHost, resolveFileReference?: (id: string) => Promise<string | null>): IpcHandlers {
  return {
    [DESKTOP_CHANNELS.canvases]: () => host.request('mind.canvases.list'),
    [DESKTOP_CHANNELS.createCanvas]: (title: unknown) => host.request('mind.canvases.create', { title }),
    [DESKTOP_CHANNELS.updateCanvas]: (id: unknown, body: unknown) => host.request('mind.canvases.update', { id, body }),
    [DESKTOP_CHANNELS.deleteCanvas]: (id: unknown) => host.request('mind.canvases.delete', { id }),
    [DESKTOP_CHANNELS.canvasItems]: (canvasId: unknown) => host.request('mind.canvases.items.list', { canvasId }),
    [DESKTOP_CHANNELS.canvasRelations]: (canvasId: unknown) => host.request('mind.canvases.relations.list', { canvasId }),
    [DESKTOP_CHANNELS.addCanvasItem]: async (canvasId: unknown, body: unknown) => {
      if (body && typeof body === 'object') {
        if ('desktopFile' in body) throw new DesktopError('invalid_request', '文件引用无效')
        if ('fileRefId' in body) {
          const { fileRefId, ...placement } = body
          if (typeof fileRefId !== 'string' || !resolveFileReference)
            throw new DesktopError('unsupported', '请在桌面应用中添加本机文件卡')
          const label = await resolveFileReference(fileRefId)
          if (!label) throw new DesktopError('not_found', '文件已移动或无法访问')
          return host.request('mind.canvases.items.add', { canvasId, body: { ...placement, desktopFile: { id: fileRefId, label } } })
        }
      }
      return host.request('mind.canvases.items.add', { canvasId, body })
    },
    [DESKTOP_CHANNELS.bringCanvasItemToFront]: (canvasId: unknown, id: unknown, body: unknown) => host.request('mind.canvases.items.bring-to-front', { canvasId, id, body }),
    [DESKTOP_CHANNELS.createCanvasRelation]: (body: unknown) => host.request('mind.canvases.relations.create', { body }),
    [DESKTOP_CHANNELS.deleteCanvasRelation]: (canvasId: unknown, id: unknown) => host.request('mind.canvases.relations.delete', { canvasId, id }),
    [DESKTOP_CHANNELS.createRefNode]: (refType: unknown, refId: unknown) => host.request('mind.ref.create', { body: { refType, refId } }),
    [DESKTOP_CHANNELS.canvasNoteLocation]: (nodeId: unknown) => host.request('mind.canvas-note.location', { nodeId }),
    [DESKTOP_CHANNELS.createCanvasNote]: (canvasId: unknown, body: unknown) => host.request('mind.canvases.notes.create', { canvasId, body }),
    [DESKTOP_CHANNELS.updateCanvasNote]: (id: unknown, fields: unknown) => host.request('mind.canvases.notes.update', { id, fields }),
    [DESKTOP_CHANNELS.updateCanvasItem]: (canvasId: unknown, id: unknown, body: unknown) => host.request('mind.canvases.items.update', { canvasId, id, body }),
    [DESKTOP_CHANNELS.deleteCanvasItem]: (canvasId: unknown, id: unknown) => host.request('mind.canvases.items.delete', { canvasId, id }),
  }
}
