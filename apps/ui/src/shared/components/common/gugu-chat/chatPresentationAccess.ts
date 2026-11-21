import type { InjectionKey } from 'vue'
import type { ChatCommandOption } from './chatCommands'

export interface ChatModelCatalog {
  selectionKey: string | (() => string | null)
  supportsServerDefault?: boolean
  list: () => Promise<{ defaultId?: string | null; items: Array<{ id: string; model: string }> }>
}

export const chatModelCatalogKey: InjectionKey<ChatModelCatalog> = Symbol('chatModelCatalog')

export const chatToolDetailsKey: InjectionKey<(
  sessionId: number, source: { kind: 'timeline'; messageId: number; index: number }
) => Promise<{ toolInput?: unknown; toolResult?: unknown }>> = Symbol('chatToolDetails')

export const chatCommandCatalogKey: InjectionKey<() => Promise<ChatCommandOption[]>> = Symbol('chatCommandCatalog')

export const chatAttachmentImageKey: InjectionKey<(id: string) => Promise<Blob>> = Symbol('chatAttachmentImage')
