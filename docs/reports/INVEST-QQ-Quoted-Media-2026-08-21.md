# QQ 引用消息与引用媒体调查报告

## 结论

Gugu 当前的 QQ 引用解析只读取当前事件中的 `message_reference`、`reference`、`quote` 和 `msg_elements`。群聊引用图片通常能成功，是因为群事件直接携带了 `msg_elements.attachments`；私聊引用图片失败时，原始 C2C 图片事件和引用事件都可能只携带引用索引，无法从当前事件恢复图片 URL。

腾讯官方 `qqbot-nodejs` 的 `quoteRef` 中间件采用统一方案：

1. 普通消息到达时，按 `msgIdx` / `messageId` 缓存文本、发送者、时间和附件摘要；
2. 引用消息到达时，优先通过 `refMsgIdx` 查询缓存；
3. 缓存未命中时，回退解析 `msg_elements[0]`；
4. 官方 OpenClaw 实现进一步使用 JSONL 持久化索引，支持重启恢复、TTL、LRU 和 compact。

官方参考：

- [dsh-qqbot 入站处理](https://raw.githubusercontent.com/tencent-connect/dsh-qqbot/main/src/transport/inbound.ts)
- [qqbot-nodejs quoteRef](https://registry.npmjs.org/@tencent-connect/qqbot-nodejs/-/qqbot-nodejs-1.0.4.tgz)
- [OpenClaw 持久化引用索引](https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/src/features/ref-index-store.ts)

## 当前差异

| 场景 | 当前行为 | 问题 |
| --- | --- | --- |
| 群聊引用文字 | 解析 `msg_elements` | 可用，但没有统一历史缓存 |
| 群聊引用图片 | 解析 `msg_elements.attachments` | 通常可用，重启或事件缺字段时会丢 |
| 私聊引用文字 | 解析当前事件 | 可用 |
| 私聊引用图片 | 依赖当前事件附件 | 当前 C2C 原始事件没有附件时无法恢复 |
| 机器人此前发送的消息 | 没有引用索引 | 无法解析引用正文和媒体 |

## 实施范围

- 新增按账号进程隔离的 QQ 引用索引；
- 入站消息统一写入索引，群聊和私聊共用；
- 引用时先查索引，再回退当前事件；
- 保存附件 URL、文件名和类型等元数据，不保存用户正文日志；
- 使用 JSONL 持久化，7 天 TTL，超过阈值后 compact；
- 保留现有表情拆分和消息入队行为不变。

## 当前已落地的数据结构与解析顺序

### 引用索引条目

每个 bot 使用独立的 JSONL 文件，索引 key 为：

```text
{chat_type}:{chat_id 或 sender_id}:{msg_idx}
```

条目保存：

```json
{
  "message_id": "平台消息 ID",
  "sender_id": "发送者 ID",
  "sender_name": "发送者名称",
  "content": "最多 200 个字符的正文摘要",
  "attachments": [
    {
      "url": "附件 URL",
      "filename": "文件名",
      "content_type": "媒体类型"
    }
  ],
  "timestamp": "平台时间戳"
}
```

索引文件只保存结构化引用元数据，不写入可见诊断日志，也不把用户正文写入日志。

### 当前解析顺序

```text
1. 当前事件中的 message_reference / reference / quote
2. 当前事件 msg_elements 中匹配 ref_msg_idx 的元素
3. 引用索引中的历史消息摘要与附件
4. 当前引用元素内部的递归 URL 兜底
```

递归 URL 兜底支持以下字段：

```text
url
file_url
download_url
downloadUrl
href
file
image_url
origin_url
preview_url
```

其中，当前事件的嵌套 URL 会被直接解析；索引目前保存标准顶层 `attachments` 的 URL 和元数据。这样可以兼容群聊完整引用、私聊带 `ref_msg_idx` 的引用，以及不同 QQ 适配器的附件字段命名。

## 平台边界

如果 QQ C2C 原始事件本身没有 `attachments`、`msg_elements` 或可下载 URL，索引只能恢复已经登记过的文字和媒体元数据，不能凭空恢复图片。当前实现已经覆盖：原消息带附件、引用消息只带 `ref_msg_idx` 的标准路径；仍需在真实 C2C 图片事件上确认是 QQ 协议缺字段，还是 Gugu raw gateway 映射丢字段。

## 验证计划

- 群聊：引用文字、引用图片；
- 私聊：引用文字、引用图片；
- 同一消息连续被引用；
- 网关重启后引用索引仍可恢复；
- 过期索引不会继续返回；
- 没有引用的普通消息行为不变。
