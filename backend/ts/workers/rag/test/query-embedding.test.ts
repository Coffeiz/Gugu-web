import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { strict as assert } from "node:assert";
import test from "node:test";
import { embedQuery, type QueryEmbeddingSettings } from "../src/query-embedding.ts";

async function withServer(
  t: import("node:test").TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

const settings = (baseUrl: string): QueryEmbeddingSettings => ({
  provider: "test-provider", base_url: baseUrl, pinned_ip: "127.0.0.1", model: "test-embedding",
  dimensions: 2, api_key: "test-only-secret", multimodal: false,
});

test("query embedding 走 OpenAI 兼容接口，且只返回向量和聚合 outcome", async (t) => {
  let received: { url: string; authorization: string | undefined; body: string } | null = null;
  const { baseUrl } = await withServer(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        url: request.url || "",
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: [0.25, -0.75] }] }));
    });
  });

  const result = await embedQuery(
    settings(baseUrl.replace("127.0.0.1", "embedding.example")), "  查询词  ", 1000,
  );
  assert.deepEqual(result, { vector: [0.25, -0.75], outcome: "success", http_status: 200 });
  assert.deepEqual(received, {
    url: "/v1/embeddings",
    authorization: "Bearer test-only-secret",
    body: JSON.stringify({ model: "test-embedding", input: "查询词", dimensions: 2 }),
  });
  assert.equal(JSON.stringify(result).includes("test-only-secret"), false);
});

test("百炼多模态文本 query 保持专用 endpoint 与请求格式", async (t) => {
  let received: { url: string; body: string } | null = null;
  const { baseUrl } = await withServer(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = { url: request.url || "", body: Buffer.concat(chunks).toString("utf8") };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { embeddings: [{ embedding: [1, 0] }] } }));
    });
  });

  const result = await embedQuery({
    ...settings(baseUrl.replace("127.0.0.1", "dashscope.example")
      .replace("/v1", "/compatible-mode/v1")),
    provider: "dashscope", multimodal: true,
  }, "图片描述", 1000);
  assert.equal(result.outcome, "success");
  assert.deepEqual(received, {
    url: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
    body: JSON.stringify({
      model: "test-embedding",
      input: { contents: [{ text: "图片描述" }] },
      parameters: { output_type: "dense", dimension: 2, enable_fusion: false },
    }),
  });
});

test("provider 重定向不跟随；超时与非法 endpoint 退化为无向量", async (t) => {
  let redirected = 0;
  const redirect = await withServer(t, (request, response) => {
    if (request.url === "/redirected") redirected += 1;
    response.writeHead(request.url === "/v1/embeddings" ? 302 : 200, {
      location: "/redirected", "content-type": "application/json",
    });
    response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
  });
  const rejected = await embedQuery(
    settings(redirect.baseUrl.replace("127.0.0.1", "redirect.example")), "query", 1000,
  );
  assert.deepEqual(rejected, { vector: [], outcome: "http_error", http_status: 302 });
  assert.equal(redirected, 0);

  const slow = await withServer(t, () => {});
  const timedOut = await embedQuery(
    settings(slow.baseUrl.replace("127.0.0.1", "slow.example")), "query", 15,
  );
  assert.deepEqual(timedOut, { vector: [], outcome: "timeout" });

  const invalid = await embedQuery(settings("file:///private/data"), "query", 1000);
  assert.deepEqual(invalid, { vector: [], outcome: "invalid_config" });
});

test("provider 响应体超过上限时中止读取并安全退化", async (t) => {
  const { baseUrl } = await withServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ embedding: [1, 0] }], padding: "x".repeat(2 * 1024 * 1024) }));
  });

  const result = await embedQuery(settings(baseUrl), "query", 1000);

  assert.deepEqual(result, { vector: [], outcome: "response_too_large", http_status: 200 });
});
