import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { createDesktopFileService } from './service.js'

export function desktopFiles(...options: Parameters<typeof createDesktopFileService>) {
  const { execute, changeProjectDirectory, agentDownloadTarget, agentCommitDownload, agentSaveAttachment, agentWorkspaceInstructions, agentWorkspaceRoot, personalRoot, content, agentOverview, agentProjectFileOverview, agentProjectFilePath, agentResolveFile, resolveAgentFolderPath, agentReadSendFile, resolveWorkspaceReference, resolvePresentation, globalFileSearch, resolveHostPresentation, hostPresentationContent, agentWorkspaceList, isWorkspaceBoundToProject, resolveFileForDrag } = createDesktopFileService(...options)
  return { changeProjectDirectory, handlers: { [DESKTOP_CHANNELS.files]: execute }, agentDownloadTarget, agentCommitDownload, agentSaveAttachment, agentWorkspaceInstructions, agentWorkspaceRoot, personalRoot, content, agentOverview, agentProjectFileOverview, agentProjectFilePath, agentResolveFile, resolveAgentFolderPath, agentReadSendFile, resolveWorkspaceReference, resolvePresentation, globalFileSearch, resolveHostPresentation, hostPresentationContent, agentWorkspaceList, isWorkspaceBoundToProject, resolveFileForDrag }
}
