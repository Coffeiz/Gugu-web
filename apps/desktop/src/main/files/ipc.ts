import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { createDesktopFileService } from './service.js'

export function desktopFiles(...options: Parameters<typeof createDesktopFileService>) {
  const { execute, agentDownloadTarget, agentCommitDownload, agentSaveAttachment, personalRoot, content, agentOverview, agentProjectFileOverview, agentResolveFile, agentReadSendFile, resolveWorkspaceReference, resolvePresentation, globalFileSearch, resolveHostPresentation, hostPresentationContent, resolveFileForDrag } = createDesktopFileService(...options)
  return { handlers: { [DESKTOP_CHANNELS.files]: execute }, agentDownloadTarget, agentCommitDownload, agentSaveAttachment, personalRoot, content, agentOverview, agentProjectFileOverview, agentResolveFile, agentReadSendFile, resolveWorkspaceReference, resolvePresentation, globalFileSearch, resolveHostPresentation, hostPresentationContent, resolveFileForDrag }
}
