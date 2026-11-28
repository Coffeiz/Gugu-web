import { ref } from 'vue'
import type { DesktopClientFields } from '@gugu/core/desktop'
import { desktopData } from '@desktop/bridge/bridge'
import type { ClientRow } from '@desktop/bridge/bridge'
import { confirmDialog } from '@/composables/core/useConfirmDialog'

type Perform = (action: () => Promise<void>) => Promise<void>

export function useDesktopContacts(perform: Perform, refresh: () => Promise<void>) {
  const clients = ref<ClientRow[]>([])
  function setRows(rows: ClientRow[]) {
    clients.value = rows
  }

  async function save(fields: DesktopClientFields, id?: number) {
    let saved: ClientRow | undefined
    await perform(async () => {
      saved = id === undefined ? await desktopData.createClient(fields) : await desktopData.renameClient(id, fields)
      const result = saved
      clients.value = id === undefined
        ? [result, ...clients.value]
        : clients.value.map(client => client.id === id ? result : client)
      await refresh()
    })
    return saved
  }

  function remove(client: ClientRow) {
    return perform(async () => {
      const confirmed = await confirmDialog({
        title: '删除联系人',
        message: `确定删除联系人“${client.name}”吗？此操作无法撤销。`,
        tone: 'danger',
        confirmText: '删除联系人',
      })
      if (!confirmed) return
      await desktopData.deleteClient(client.id)
      await refresh()
    })
  }

  return { clients, setRows, save, remove }
}
