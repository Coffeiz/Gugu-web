import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import type { DesktopAgentUsage, DesktopAgentPreference, DesktopAgentPreferenceKind, DesktopAgentPreferencePatch, DesktopAppearancePreferences } from '@gugu/core/desktop'

export interface CapabilityCredentialInput {
  capability: 'deep_research' | 'similar_image_search'
  provider: string
  value?: string
}
export interface LocalCapabilityAccess {
  smtpSettings(): Promise<{ host: string; port: number; user: string; fromAddr: string; useSsl: boolean; enabled: boolean; configured: boolean } | null>
  saveSmtp(input: Record<string, unknown>): Promise<unknown>
  testSmtp(input: Record<string, unknown>): Promise<{ ok: boolean; message: string }>
  list(): Promise<import('@gugu/core/byok/contracts').ByokSummary[]>
  save(input: CapabilityCredentialInput, id: number | null): Promise<{ id: number }>
  remove(id: number): Promise<void>
  test(input: CapabilityCredentialInput, id: number | null): Promise<{ ok: boolean; message?: string }>
}

export interface LocalPreferencesAccess {
  preflightBusinessArchive?(): Promise<{ id: string; added: number; skipped: number } | null>
  applyBusinessArchive?(id: string): Promise<{ added: number; skipped: number }>
  exportBusinessArchive?(): Promise<null>
  dataInventory?(): Promise<Record<string, number>>
  capabilities?(): LocalCapabilityAccess
  appearance(): Promise<DesktopAppearancePreferences>
  updateAppearance(patch: Partial<DesktopAppearancePreferences>): Promise<DesktopAppearancePreferences>
  agentUsage(): Promise<DesktopAgentUsage | null>
  agentPreference(kind: DesktopAgentPreferenceKind, patch?: DesktopAgentPreferencePatch): Promise<DesktopAgentPreference>
  clearAgentMemory(): Promise<null>
  clearAgentAttachments(): Promise<{ deleted: number }>
  isMemoryBusy(error: unknown): boolean
}

export const localPreferencesAccessKey: InjectionKey<LocalPreferencesAccess> = Symbol('localPreferencesAccess')

export function useLocalPreferencesAccess() {
  return hasInjectionContext() ? inject(localPreferencesAccessKey, null) : null
}
