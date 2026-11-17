import { createNodeProviderTransport } from '@gugu/core/providers/node'

/** RAG 的本地访问仍由每次 embedRagQuery 请求的 Provider 标记二次限制。 */
export function createAgentRagEmbeddingTransport(environment: () => Readonly<Record<string, string | undefined>>) {
  return createNodeProviderTransport({
    allowLocal: true,
    connectTimeoutMs: 5_000,
    writeTimeoutMs: 10_000,
    environment,
  })
}
