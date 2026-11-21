import { ref } from 'vue'
import { mcpApi, type McpServerItem } from '@/services/api'

const MAX_PARALLEL_STATUS_LOADS = 3

type McpRuntimeStatus = {
  ok: boolean
  state: string
  tool_count: number
  tool_names?: string[]
  error?: string | null
}

export function useMcpStatusLoader() {
  const checkingIds = ref<Set<string>>(new Set())
  let generation = 0

  function cancel() {
    generation += 1
    checkingIds.value = new Set()
  }

  async function refresh(
    servers: McpServerItem[],
    onResult: (serverId: string, status: McpRuntimeStatus) => void,
  ) {
    const currentGeneration = ++generation
    const pending = servers.filter(server => server.enabled && server.state === 'unloaded')
    checkingIds.value = new Set(pending.map(server => server.id))
    let nextIndex = 0

    async function runNext() {
      while (nextIndex < pending.length) {
        const server = pending[nextIndex++]
        let status: McpRuntimeStatus
        try {
          status = await mcpApi.loadStatus(server.id)
        } catch {
          status = { ok: false, state: 'error', tool_count: 0 }
        }

        if (currentGeneration === generation) {
          onResult(server.id, status)
          const remaining = new Set(checkingIds.value)
          remaining.delete(server.id)
          checkingIds.value = remaining
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_PARALLEL_STATUS_LOADS, pending.length) },
        () => runNext(),
      ),
    )
  }

  return { checkingIds, cancel, refresh }
}
