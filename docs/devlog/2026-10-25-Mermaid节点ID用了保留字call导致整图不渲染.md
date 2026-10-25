# Mermaid 节点 ID 用了保留字 call 导致整图不渲染

## 现象

IM 里回复的一段 Mermaid 图表没有出图，用户只看到一段源码代码块，没有图片。发送方询问是「语法错了还是后端问题」。

## 根因

图表源码里有一个节点 ID 直接写成 `call`：

```mermaid
    req[生成请求] --> call[调用渠道 API]
    call --> usage[返回 usage<br/>completion_tokens / 费用]
```

Mermaid 12.1.0 的 Flowchart 词法器有一条规则：

```text
rules[13] = /^(?:call[\s]+)/    →  this.begin("callbackname")
```

`call` 后面跟空白字符（空格或换行）会被词法器切进 `callbackname` 状态，产出 `CALLBACKNAME` token。解析器在期望节点 ID 的位置收到这个 token，于是报：

```text
Parse error on line 4:
flowchart TD  call --> b[z]
-------------------^
Expecting 'SEMI', 'NEWLINE', 'SPACE', 'EOF', 'subgraph', 'end', ..., got 'CALLBACKNAME'
```

于是**整张图解析失败**，不是只坏一个节点。

注意这条规则带 `[\s]+`：所以 `call[调用渠道 API]`（方括号紧跟）、`cal`、`callb`、`apiCall` 都不触发；只有 `call` 后面是空格或行尾换行才触发。jison 在输入末尾补一个换行，因此**行尾的裸 `call` 同样中招**。

## 证据链

诊断在后端实际使用的渲染链路上完成，没有改仓库代码：

1. **诊断日志对上时间点**：`logs/gugu-diag.log` 里 `agent.im.mermaid.render | status=diagram_failed index=0 diagram_type=flowchart reason=diagram_parse_or_render_failed`，时间戳与消息发送时刻一致。说明管线正常调用了渲染器，是 Mermaid 自己解析失败。
2. **逐行剔除**：从完整图里逐行删掉再渲染，只有删掉 `call --> usage[...]` 这一行才能通过，其余任意一行删掉都仍然失败——锁定到该行。
3. **最小复现**：`flowchart TD` + `call --> b[z]` 单独就能复现；`cal`、`callb`、`apiCall`、`a --> call[z]` 全部正常。
4. **语法规则定位**：在 `node_modules/mermaid/dist/chunks/mermaid.esm/chunk-T3ODRKFR.mjs` 的编译产物里读到 `rules[13] = /^(?:call[\s]+)/` 与 `case 13: this.begin("callbackname")`，与报错里的 `CALLBACKNAME` 对上。

## 修复

- **图本身**：节点 ID `call` 改为 `callapi`（或任何非保留字）。渲染验证通过，产出 276 KB PNG。
- **Skill 文档**：`backend/agent/skills/mermaid-diagram.md` 的「避免的错误」补一条实测保留字清单，并在「通用输出约定」的节点 ID 规则里加上「避开图型关键字」。

实测在 Mermaid 12.1.0 下不能直接当 Flowchart 裸节点 ID 的词：

```text
call  end  graph  flowchart  click  class  classDef  style  linkStyle  subgraph  href
```

`direction`、`accTitle`、`accDescr`、`default`、`note`、`loop`、`alt`、`rect`、`circle` 等可以正常用作节点 ID。

## 验证

- 后端渲染链路上跑真实 worker（Mermaid 12.1.0，与前后端同一版本）：原图解析失败，改名后渲染成功。
- 前后端版本一致：`frontend/package.json` 与 `backend/ts/workers/mermaid-renderer/package.json` 都是 `mermaid@12.1.0`，因此**浏览器端同样会失败**，不是只在 IM 链路复现。

## 后端行为复核（不是后端的问题）

渲染失败时后端的处理是正确的：

- `render_pngs` 收到 worker 的失败帧（PNG 长度 0），记 `status=partial failed=1`，不产出图片；
- 流式侧把失败的图表源码当普通文本回传，所以用户看到的是代码块而不是图片——这是既定的降级路径，不是吞消息；
- 渲染耗时 3.9 秒，没有触发 20 秒超时，也没有触发 4 图批量上限或 20000 字符上限。

用户侧的可见现象是「没出图」，符合失败降级的预期。

## 经验与约束

- 节点 ID 不是随便什么词都能用。Mermaid 的 Flowchart 词法器对保留字有硬规则，撞上就整图报废，不是局部降级。
- 渲染失败必须能定位到**行号**。当前 worker 把 Mermaid 的原始报错吞成 `reason=diagram_parse_or_render_failed`，诊断日志里拿不到行号和出错 token，只能靠逐行剔除反推——本次定位花了约二十分钟。可以考虑让 worker 额外回传「解析失败行号 + 出错 token 名」（两者都不含源码内容，可安全落诊断日志），把这类问题从「逐行试」变成「一眼看到」。
- 词法器规则要连**边界**一起验证：`call` 后面跟空格才触发、跟 `[` 不触发、位于行尾时因为 jison 补换行也会触发。只测「能不能当 ID」不够，还要测「在什么位置、以什么后继字符会触发」。
