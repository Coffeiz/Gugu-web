import type { LocalPreferencesAccess } from '@/services/localPreferencesAccess'
import { callDesktopBridge, desktopData, DesktopBridgeError } from '../bridge/bridge'

import { createDesktopCapabilityAccess } from './capabilityAccess'
import { requestDesktopAgentModel } from './agent-model-transport'

export const desktopPreferencesAccess: LocalPreferencesAccess = {
  applyBusinessArchive: id => callDesktopBridge(bridge => bridge.applyBusinessArchive(id)),
  preflightBusinessArchive: () => callDesktopBridge(bridge => bridge.preflightBusinessArchive()),
  exportBusinessArchive: () => callDesktopBridge(bridge => bridge.exportBusinessArchive()),
  dataInventory: () => callDesktopBridge(bridge => bridge.dataInventory()),
  capabilities: createDesktopCapabilityAccess,
  appearance: desktopData.appearance,
  updateAppearance: desktopData.updateAppearance,
  async agentUsage() {
    const { items } = await requestDesktopAgentModel({ action: 'list' })
    return items.length ? desktopData.agentUsage() : null
  },
  agentPreference: desktopData.agentPreference,
  clearAgentMemory: desktopData.clearAgentMemory,
  clearAgentAttachments: desktopData.clearAgentAttachments,
  isMemoryBusy: error => error instanceof DesktopBridgeError && error.code === 'busy',
}
