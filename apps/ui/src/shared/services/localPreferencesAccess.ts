import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { DesktopAppearancePreferences } from '@gugu/core/desktop'

export interface LocalPreferencesAccess {
  appearance(): Promise<DesktopAppearancePreferences>
  updateAppearance(patch: Partial<DesktopAppearancePreferences>): Promise<DesktopAppearancePreferences>
  clearAgentMemory(): Promise<null>
  clearAgentAttachments(): Promise<{ deleted: number }>
  isMemoryBusy(error: unknown): boolean
}

export const localPreferencesAccessKey: InjectionKey<LocalPreferencesAccess> = Symbol('localPreferencesAccess')

export function useLocalPreferencesAccess() {
  return hasInjectionContext() ? inject(localPreferencesAccessKey, null) : null
}
