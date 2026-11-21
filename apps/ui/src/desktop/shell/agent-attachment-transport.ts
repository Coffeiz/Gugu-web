import type { DesktopAgentAttachment, DesktopBridge, DesktopReply } from '@gugu/core/desktop'
import { DesktopBridgeError } from '@desktop/bridge/bridge'
import { previewAttachmentPath } from '../../../../desktop/src/shared/agent-attachment-preview'

type DesktopWindow = Window & { guguDesktop?: DesktopBridge }

async function requestNativeAttachment<T>(action: (bridge: DesktopBridge) => Promise<DesktopReply<T>>) {
  const native = (window as DesktopWindow).guguDesktop
  if (!native) throw new DesktopBridgeError('preview_unavailable', '本机预览附件服务未就绪')
  const reply = await action(native)
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message, reply.error.operationId)
  return reply.result
}

function usePreviewAttachments() {
  return !(window as DesktopWindow).guguDesktop && import.meta.env.DEV
    && new URLSearchParams(location.search).get('desktopPreview') === '1'
}

async function requestPreviewAttachment<T>(body: BodyInit, headers: Record<string, string>): Promise<T> {
  const response = await fetch(previewAttachmentPath, { method: 'POST', body, headers })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new DesktopBridgeError('preview_unavailable', '本机预览附件服务未就绪')
  const reply = await response.json() as DesktopReply<T>
  if (reply.ok === false) throw new DesktopBridgeError(reply.error.code, reply.error.message)
  return reply.result
}

export function hasDesktopAgentAttachmentBridge() {
  return typeof (window as DesktopWindow).guguDesktop?.agentAttachment === 'function' || usePreviewAttachments()
}

export async function uploadDesktopAgentAttachment(file: File, voice = false) {
  const result = usePreviewAttachments()
    ? await requestPreviewAttachment<DesktopAgentAttachment>(file, {
      'Content-Type': 'application/octet-stream',
      'x-gugu-attachment-name': encodeURIComponent(file.name),
      'x-gugu-attachment-type': encodeURIComponent(file.type),
      'x-gugu-attachment-voice': voice ? '1' : '0',
    })
    : await file.arrayBuffer().then(buffer => requestNativeAttachment(bridge => {
      if (!bridge.agentAttachment) throw new DesktopBridgeError('desktop_update_required', '请重新启动桌面应用后再添加附件')
      return bridge.agentAttachment({ action: 'upload', name: file.name, mime: file.type || null, voice,
        data: new Uint8Array(buffer) })
    }))
  if (!result || !('attach_id' in result)) throw new DesktopBridgeError('storage_error', '附件保存失败，请重试')
  return result
}

export function deleteDesktopDraftAttachment(attachId: string) {
  if (usePreviewAttachments()) return requestPreviewAttachment<null>(
    JSON.stringify({ action: 'deleteDraft', attachId }), { 'Content-Type': 'application/json' },
  )
  return requestNativeAttachment(bridge => {
    if (!bridge.agentAttachment) throw new DesktopBridgeError('desktop_update_required', '请重新启动桌面应用后再管理附件')
    return bridge.agentAttachment({ action: 'deleteDraft', attachId })
  })
}

export async function downloadDesktopAgentAttachment(attachId: string) {
  if (usePreviewAttachments()) {
    const { data, name, mime } = await requestPreviewAttachment<{ data: string; name: string; mime: string }>(
      JSON.stringify({ action: 'download', attachId }), { 'Content-Type': 'application/json' },
    )
    const bytes = Uint8Array.from(atob(data), value => value.charCodeAt(0))
    return { blob: new Blob([bytes.buffer], { type: mime }), name }
  }
  const result = await requestNativeAttachment(bridge => {
    if (!bridge.agentAttachment) throw new DesktopBridgeError('desktop_update_required', '请重新启动桌面应用后再下载附件')
    return bridge.agentAttachment({ action: 'download', attachId })
  })
  const data: unknown = result && 'data' in result ? result.data : undefined
  if (!result || !('data' in result) || !ArrayBuffer.isView(data)
    || Object.prototype.toString.call(data) !== '[object Uint8Array]'
    || typeof result.name !== 'string' || typeof result.mime !== 'string')
    throw new DesktopBridgeError('not_found', '附件不存在或已过期')
  const source = data as Uint8Array
  const bytes = new Uint8Array(source.byteLength)
  bytes.set(source)
  return { blob: new Blob([bytes.buffer], { type: result.mime }), name: result.name }
}
