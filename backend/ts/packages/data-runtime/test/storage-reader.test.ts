import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStorageReaderFromEnv } from "../src/storage-reader.ts";

test("local StorageReader 只读当前 owner 目录并拒绝路径穿越", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-rag-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "owner-a", ".agent"), { recursive: true });
  await mkdir(join(root, "owner-b"), { recursive: true });
  await writeFile(join(root, "owner-a", ".agent", "memory.md"), "私有记忆", "utf8");
  await writeFile(join(root, "owner-b", "secret.md"), "其他 owner", "utf8");
  const reader = createStorageReaderFromEnv({
    GUGU_STORAGE_BACKEND: "local", GUGU_STORAGE_ROOT: root,
  } as NodeJS.ProcessEnv);

  assert.equal(await reader.readText({
    ownerId: "owner-a", key: "owner-a/.agent/memory.md", maxChars: 100,
  }), "私有记忆");
  assert.equal(await reader.readText({
    ownerId: "owner-a", key: "owner-a/missing.md", maxChars: 100,
  }), null);
  await assert.rejects(() => reader.readText({
    ownerId: "owner-a", key: "owner-a/../owner-b/secret.md", maxChars: 100,
  }), /非法存储 key/u);
  await assert.rejects(() => reader.readText({
    ownerId: "owner-a", key: "owner-b/secret.md", maxChars: 100,
  }), /越权存储 key/u);
});

test("local StorageReader 拒绝跨 owner 符号链接", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gugu-rag-storage-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "owner-a"), { recursive: true });
  await mkdir(join(root, "owner-b"), { recursive: true });
  await writeFile(join(root, "owner-b", "secret.md"), "不应读取", "utf8");
  await symlink(join(root, "owner-b", "secret.md"), join(root, "owner-a", "link.md"));
  const reader = createStorageReaderFromEnv({
    GUGU_STORAGE_BACKEND: "local", GUGU_STORAGE_ROOT: root,
  } as NodeJS.ProcessEnv);
  await assert.rejects(() => reader.readText({
    ownerId: "owner-a", key: "owner-a/link.md", maxChars: 100,
  }), /跨 owner 符号链接/u);
});

test("OSS StorageReader 在未使用前不初始化凭据，并按 owner 前缀拒绝越权 key", async () => {
  const reader = createStorageReaderFromEnv({ GUGU_STORAGE_BACKEND: "oss" } as NodeJS.ProcessEnv);
  await assert.rejects(() => reader.readText({
    ownerId: "owner-a", key: "owner-b/.agent/memory.md", maxChars: 100,
  }), /越权存储 key/u);
  await assert.rejects(() => reader.readText({
    ownerId: "owner-a", key: "owner-a/.agent/memory.md", maxChars: 100,
  }), /OSS 只读通道配置不完整/u);
});
