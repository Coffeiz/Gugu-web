import type { LocalPreferencesAccess } from '@/services/localPreferencesAccess'
import { desktopData, DesktopBridgeError } from '../bridge/bridge'

export const desktopPreferencesAccess: LocalPreferencesAccess = {
  appearance: desktopData.appearance,
  updateAppearance: desktopData.updateAppearance,
  clearAgentMemory: desktopData.clearAgentMemory,
  clearAgentAttachments: desktopData.clearAgentAttachments,
  isMemoryBusy: error => error instanceof DesktopBridgeError && error.code === 'busy',
}
