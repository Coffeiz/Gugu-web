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

/** RAG 查询会在每次 embedding 后关闭其 transport；提供工厂避免共享已关闭实例。 */
export function createAgentRagEmbeddingTransportFactory(environment: () => Readonly<Record<string, string | undefined>>) {
  return () => createAgentRagEmbeddingTransport(environment)
}
