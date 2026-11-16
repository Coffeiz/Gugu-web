import { ref } from 'vue'
import { desktopData } from '@/desktop/bridge'
import type { ClientRow } from '@/desktop/bridge'
import { confirmDialog } from '@/composables/core/useConfirmDialog'

type Perform = (action: () => Promise<void>) => Promise<void>

export function useDesktopContacts(perform: Perform, refresh: () => Promise<void>) {
  const clients = ref<ClientRow[]>([])
  const clientName = ref('')
  const editingClient = ref<ClientRow | null>(null)
  const editedClientName = ref('')

  async function setRows(rows: ClientRow[]) {
    clients.value = rows
  }

  function create() {
    return perform(async () => {
      await desktopData.createClient(clientName.value)
      clientName.value = ''
      await refresh()
    })
  }

  function rename() {
    return perform(async () => {
      const client = editingClient.value
      if (!client) return
      await desktopData.renameClient(client.id, editedClientName.value)
      editingClient.value = null
      await refresh()
    })
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

  return { clients, clientName, editingClient, editedClientName, setRows, create, rename, remove }
}
