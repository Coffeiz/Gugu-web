import type {
  RagDocument,
  RagResponse,
  RagSearchScope,
  RagSourceBatch,
} from "../../../packages/contracts/src/rag.ts";
import { RagIndexCacheService } from "./index-cache-service.ts";

export type RagServiceContext = {
  /** 调用方已经完成权限过滤后的稳定 scope 标识。 */
  scopeKey: string;
  /** 上游 snapshot 的 revision；同 revision 不重复构建。 */
  revision: string;
  scope?: RagSearchScope;
};

export type RagServiceSearchOptions = {
  limit?: number;
  sourceTypes?: string[];
  maxChars?: number;
};

export type RagServiceEngine = {
  buildAndIndex(revision: string, batch: RagSourceBatch): Promise<RagResponse>;
  unifiedSearch(
    revision: string,
    query: string,
    options: { limit?: number; sourceTypes?: string[]; scope?: RagSearchScope; maxChars?: number },
  ): Promise<RagResponse>;
};

export type RagSourceLoader = (context: RagServiceContext) => Promise<RagSourceBatch>;

export type RagServiceResult = {
  results: RagDocument[];
  diagnostics: Record<string, unknown>;
  built: boolean;
  revision: string;
};

/**
 * TS RAG 的业务生命周期边界。
 *
 * FastAPI 入口负责数据库读取、owner/scope 权限过滤和结果包装；本服务负责
 * 将稳定 source batch 交给 TS worker，并按 scope/revision 复用索引。
 */
export class TsRagService {
  private readonly indexCache: RagIndexCacheService;
  private readonly loader: RagSourceLoader;
  private readonly engine: RagServiceEngine;

  constructor(
    loader: RagSourceLoader,
    engine: RagServiceEngine,
    cache: RagIndexCacheService = new RagIndexCacheService(),
  ) {
    this.loader = loader;
    this.engine = engine;
    this.indexCache = cache;
  }

  async search(
    context: RagServiceContext,
    query: string,
    options: RagServiceSearchOptions = {},
  ): Promise<RagServiceResult> {
    if (!context.scopeKey) throw new Error("RAG service 缺少 scopeKey");
    if (!context.revision) throw new Error("RAG service 缺少 revision");

    const lookup = this.indexCache.lookup(context.scopeKey, context.revision);
    let built = false;
    if (!lookup.hit) {
      const batch = await this.loader(context);
      const response = await this.engine.buildAndIndex(context.revision, batch);
      ensureOk(response, "TS RAG 构建索引失败");
      this.indexCache.commit(context.scopeKey, context.revision);
      built = true;
    }

    const response = await this.engine.unifiedSearch(context.revision, query, {
      limit: options.limit,
      sourceTypes: options.sourceTypes,
      scope: context.scope,
      maxChars: options.maxChars,
    });
    ensureOk(response, "TS RAG 召回失败");
    const resultResponse = response as Extract<RagResponse, { status: "ok"; results: RagDocument[] }>;
    return {
      results: resultResponse.results ?? [],
      diagnostics: {
        ...(resultResponse.diagnostics ?? {}),
        revision: context.revision,
        scope_key: context.scopeKey,
        index_built: built,
        index_cache_reason: lookup.reason,
      },
      built,
      revision: context.revision,
    };
  }

  invalidate(scopeKey?: string): void {
    this.indexCache.invalidate(scopeKey);
  }

  size(): number {
    return this.indexCache.size();
  }

  cacheStats(): ReturnType<RagIndexCacheService["stats"]> {
    return this.indexCache.stats();
  }
}

function ensureOk(response: RagResponse, message: string): asserts response is Extract<RagResponse, { status: "ok" }> {
  if (response.status !== "ok") throw new Error(`${message}: ${response.message}`);
}
