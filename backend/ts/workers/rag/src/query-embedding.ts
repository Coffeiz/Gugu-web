import * as http from "node:http";
import * as https from "node:https";
import { createHash } from "node:crypto";
import { isIP, type LookupFunction } from "node:net";
import { TtlCache } from "./ttl-cache.ts";

export type QueryEmbeddingSettings = {
  provider: string;
  base_url: string;
  pinned_ip: string;
  model: string;
  dimensions: number;
  api_key: string;
  multimodal?: boolean;
};

export type QueryEmbeddingOutcome =
  | "success"
  | "invalid_config"
  | "http_error"
  | "invalid_response"
  | "response_too_large"
  | "timeout"
  | "network_error";

export type QueryEmbeddingResult = {
  vector: number[];
  outcome: QueryEmbeddingOutcome;
  http_status?: number;
};

const REQUEST_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/* query 向量短 TTL 缓存：revision 自愈重试会重复嵌入同一 query；
 * 相同 model+text 短窗口内直接复用，省一次外部 API 往返。 */
const QUERY_VECTOR_CACHE_TTL_MS = 5 * 60_000;
const queryVectorCache = new TtlCache<number[]>({ ttlMs: QUERY_VECTOR_CACHE_TTL_MS, maxEntries: 64 });

function cacheKeyFor(settings: QueryEmbeddingSettings, text: string): string {
  return createHash("sha256").update(`${settings.provider}\n${settings.model}\n${settings.dimensions}\n${text}`).digest("hex");
}

function cachedQueryVector(settings: QueryEmbeddingSettings, text: string): number[] | null {
  return queryVectorCache.get(cacheKeyFor(settings, text)) ?? null;
}

function rememberQueryVector(settings: QueryEmbeddingSettings, text: string, vector: number[]): void {
  if (!vector.length) return;
  queryVectorCache.set(cacheKeyFor(settings, text), vector);
}

function isBailian(provider: string, baseUrl: string): boolean {
  const name = provider.trim().toLowerCase();
  return ["bailian", "dashscope", "aliyun"].includes(name)
    || baseUrl.toLowerCase().includes("aliyuncs.com");
}

function makeRequest(settings: QueryEmbeddingSettings, text: string): {
  url: URL; payload: Record<string, unknown>; vectorPath: "openai" | "bailian";
} | null {
  try {
    const baseUrl = new URL(settings.base_url.trim());
    if (!["http:", "https:"].includes(baseUrl.protocol)
      || !baseUrl.hostname || baseUrl.username || baseUrl.password
      || baseUrl.search || baseUrl.hash || !settings.model.trim()
      || !isIP(settings.pinned_ip)) return null;

    const bailian = isBailian(settings.provider, baseUrl.toString());
    if (settings.multimodal && bailian) {
      let root = baseUrl.toString().replace(/\/+$/, "");
      const marker = "/compatible-mode/v1";
      if (root.includes(marker)) root = root.split(marker, 1)[0];
      const url = new URL(`${root}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`);
      return {
        url,
        payload: {
          model: settings.model,
          input: { contents: [{ text }] },
          parameters: {
            output_type: "dense",
            ...(settings.dimensions > 0 ? { dimension: settings.dimensions } : {}),
            enable_fusion: false,
          },
        },
        vectorPath: "bailian",
      };
    }

    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/embeddings`;
    const payload: Record<string, unknown> = { model: settings.model, input: text };
    if (settings.dimensions > 0) payload.dimensions = settings.dimensions;
    if (bailian) payload.encoding_format = "float";
    return { url: baseUrl, payload, vectorPath: "openai" };
  } catch {
    return null;
  }
}

function extractVector(body: unknown, vectorPath: "openai" | "bailian"): number[] | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  let raw: unknown;
  if (vectorPath === "bailian") {
    const output = root.output as { embeddings?: Array<{ embedding?: unknown }> } | undefined;
    raw = output?.embeddings?.[0]?.embedding;
  } else {
    const data = root.data as Array<{ embedding?: unknown }> | undefined;
    raw = data?.[0]?.embedding;
  }
  if (!Array.isArray(raw) || raw.length === 0
    || !raw.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return raw as number[];
}

/**
 * 在 RAG worker 内执行一次临时 query embedding。
 * 凭据只存在于调用栈与当前请求内存；错误结果不携带 URL、key 或 provider 响应正文。
 */
export async function embedQuery(
  settings: QueryEmbeddingSettings,
  text: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<QueryEmbeddingResult> {
  const normalizedText = text.trim();
  if (!normalizedText) return { vector: [], outcome: "invalid_config" };
  const cached = cachedQueryVector(settings, normalizedText);
  if (cached) return { vector: cached, outcome: "success" };
  const request = makeRequest(settings, normalizedText);
  if (!request) return { vector: [], outcome: "invalid_config" };

  const headers: http.OutgoingHttpHeaders = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (settings.api_key) {
    if (/[\r\n]/.test(settings.api_key) || /[^\x20-\x7e]/.test(settings.api_key)) {
      return { vector: [], outcome: "invalid_config" };
    }
    headers.authorization = `Bearer ${settings.api_key}`;
  }

  const transport = request.url.protocol === "https:" ? https : http;
  const family = isIP(settings.pinned_ip);
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address: settings.pinned_ip, family }]);
    } else {
      callback(null, settings.pinned_ip, family);
    }
  };
  return await new Promise<QueryEmbeddingResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: QueryEmbeddingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.outcome === "success") rememberQueryVector(settings, normalizedText, result.vector);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      outgoing.destroy(new Error("embedding request timeout"));
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    const outgoing = transport.request(request.url, {
      method: "POST",
      headers,
      lookup: pinnedLookup,
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if (status !== 200) {
        response.resume();
        response.once("end", () => finish({ vector: [], outcome: "http_error", http_status: status }));
        response.once("error", () => finish({ vector: [], outcome: "http_error", http_status: status }));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          outgoing.destroy(new Error("embedding response too large"));
          finish({ vector: [], outcome: "response_too_large", http_status: status });
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const vector = extractVector(body, request.vectorPath);
          finish(vector
            ? { vector, outcome: "success", http_status: status }
            : { vector: [], outcome: "invalid_response", http_status: status });
        } catch {
          finish({ vector: [], outcome: "invalid_response", http_status: status });
        }
      });
      response.once("error", () => finish({ vector: [], outcome: "network_error", http_status: status }));
    });
    outgoing.once("error", () => finish({
      vector: [], outcome: timedOut ? "timeout" : "network_error",
    }));
    outgoing.end(JSON.stringify(request.payload));
  });
}
