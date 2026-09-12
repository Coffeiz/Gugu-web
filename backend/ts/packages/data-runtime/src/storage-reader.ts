import { realpath, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import OSS from "ali-oss";
import type { StorageReader } from "./contracts.ts";

type OssClient = {
  get(key: string, file?: undefined, options?: { timeout?: number }): Promise<{
    content?: Buffer;
    res?: { status?: number };
  }>;
};

const MAX_TEXT_CHARS = 50_000_000;

function validatedKey(ownerId: string, key: string): string[] {
  if (!ownerId || ownerId.includes("/") || ownerId.includes("\\") || ownerId.includes("\0")
    || !key.startsWith(`${ownerId}/`) || key.includes("\\") || key.includes("\0")) {
    throw new Error("Data Runtime 拒绝越权存储 key");
  }
  const parts = key.split("/");
  if (parts[0] !== ownerId || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Data Runtime 拒绝非法存储 key");
  }
  return parts;
}

function missingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; code?: unknown };
  return Number(value.status) === 404 || value.code === "NoSuchKey" || value.code === "NoSuchBucket";
}

/** 生产 worker 的只读 local/OSS 适配器；调用方仍须给每个 key 绑定 owner。 */
export function createStorageReaderFromEnv(env: NodeJS.ProcessEnv = process.env): StorageReader {
  const backend = String(env.GUGU_STORAGE_BACKEND || "local").trim();
  const root = String(env.GUGU_STORAGE_ROOT || "").trim();
  let oss: OssClient | undefined;

  const getOss = (): OssClient => {
    if (oss) return oss;
    const accessKeyId = String(env.GUGU_OSS_ACCESS_KEY_ID || "");
    const accessKeySecret = String(env.GUGU_OSS_ACCESS_KEY_SECRET || "");
    const bucket = String(env.GUGU_OSS_BUCKET || "");
    const rawEndpoint = String(env.GUGU_OSS_ENDPOINT || "").trim();
    if (!accessKeyId || !accessKeySecret || !bucket || !rawEndpoint) {
      throw new Error("Data Runtime OSS 只读通道配置不完整");
    }
    const endpoint = /^https?:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`;
    const region = rawEndpoint.replace(/^https?:\/\//i, "").split(".")[0] || "oss-cn-hangzhou";
    const client = new OSS({
      accessKeyId, accessKeySecret, bucket, endpoint, region,
      secure: endpoint.startsWith("https://"), enableProxy: false, timeout: 8_000,
      retryMax: 1,
    }) as unknown as OssClient;
    oss = client;
    return client;
  };

  return {
    async readText({ ownerId, key, maxChars }) {
      const parts = validatedKey(ownerId, key);
      const limit = Math.max(1, Math.min(MAX_TEXT_CHARS, Math.trunc(Number(maxChars) || 0)));
      const maxBytes = limit * 4;
      if (backend === "oss") {
        const prefix = String(env.GUGU_OSS_PREFIX || "");
        try {
          const result = await getOss().get(prefix + parts.join("/"), undefined, { timeout: 8_000 });
          const content = result.content;
          if (!content) return null;
          if (content.byteLength > maxBytes) throw new Error("Data Runtime 拒绝读取超限 OSS 对象");
          return new TextDecoder().decode(content).slice(0, limit);
        } catch (error) {
          if (missingObject(error)) return null;
          throw error;
        }
      }
      if (backend !== "local" || !root) throw new Error("Data Runtime 本地存储只读通道未配置");

      const rootPath = resolve(root);
      const ownerPath = resolve(rootPath, ownerId);
      const targetPath = resolve(rootPath, ...parts);
      if (relative(rootPath, targetPath).startsWith(`..${sep}`)
        || relative(rootPath, targetPath) === "..") {
        throw new Error("Data Runtime 拒绝越界本地存储 key");
      }
      try {
        const [realRoot, realOwner, realTarget] = await Promise.all([
          realpath(rootPath), realpath(ownerPath), realpath(targetPath),
        ]);
        if (realOwner !== resolve(realRoot, ownerId)
          || (realTarget !== realOwner && !realTarget.startsWith(`${realOwner}${sep}`))) {
          throw new Error("Data Runtime 拒绝跨 owner 符号链接");
        }
        const info = await stat(realTarget);
        if (!info.isFile()) return null;
        if (info.size > maxBytes) throw new Error("Data Runtime 拒绝读取超限本地文件");
        return (await readFile(realTarget, "utf8")).slice(0, limit);
      } catch (error) {
        if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
