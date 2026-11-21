import { byokApi } from '@/services/api'
import type { ChatModelCatalog } from '@/components/common/gugu-chat/chatPresentationAccess'

export function createWebChatModelCatalog(userId: () => number | string | null | undefined): ChatModelCatalog {
  return {
    supportsServerDefault: true,
    selectionKey: () => {
      const id = userId()
      return id == null ? null : `gugu:chat-model:${id}`
    },
    async list() {
      const result = await byokApi.list()
      const items = (result.enabled ? result.items : [])
        .filter(item => item.capability === 'llm' && item.has_value === true && Number.isSafeInteger(item.id) && item.id > 0)
      const defaultItem = items.find(item => item.enabled === true)
      return {
        defaultId: defaultItem ? String(defaultItem.id) : undefined,
        items: items.map(item => ({ id: String(item.id), model: item.model || item.provider })),
      }
    },
  }
}
