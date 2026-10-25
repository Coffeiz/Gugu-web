# MiniMax 上下文超限与 grep 内嵌图片数据

## 根因

失败请求的上下文中，文件 `grep` 结果包含 minified SVG 的内嵌 `data:image/...;base64`。`grep` 原先按整行返回文本，导致单次结果超过 1.4 MB，并将图片编码内容作为普通文本送入模型；MiniMax 返回 `context window exceeds limit`。该次失败没有调用图片读取工具，问题不在图片附件或 Base64 图片块的 provider 编码。

## 修复

- `grep` 搜索前将 Base64 data URI 替换为短标记，使编码载荷不参与匹配或进入上下文，同时保留载荷以外的正常文本命中。
- 超长行按命中位置截短到 700 字符；整批序列化结果限制为 128 KiB，并通过 `truncation_reasons` 说明省略原因。
- 上下文溢出分类新增 MiniMax 文案 `context window exceeds limit`，由现有的一次压缩与受控重试流程处理。

## 验证

在 devserver 串行运行后端定向测试：

```text
PYTHONPATH=. .venv/bin/pytest -q tests/agent/knowledge/test_grep_tool.py tests/agent/context/test_context_overflow_classification.py
22 passed
```

复现用例构造单行 SVG，含 12 段、合计 1,367,104 个 Base64 字符，并在载荷内外放置相同搜索词。验证结果：载荷内容不产生命中、不进入返回结果；载荷外命中保留；长行和返回字节数均受限。另验证 MiniMax 原始超限文案会被分类为上下文溢出。

本次使用合成数据验证工具输出和错误分类，没有重新调用真实 MiniMax 接口；避免依赖上游服务和产生额外请求费用。
