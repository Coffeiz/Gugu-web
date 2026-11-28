---
name: 图片分析
description: 用于描述图片、比较视觉细节，或用已有图片核对身份、同款和出处。
category: search
related_tools: view_image, similar_image_search, web_search
source: builtin
emoji: 🖼️
---

# 图片分析

- 图片已进入上下文时，先观察可见内容。用户只要描述、比较或指出问题时，直接根据图像回答。清楚区分看到的细节和推断。
- 目标是工作区图片或公网图片时，按 `view_image` 的 Schema 传当前会话可访问的路径或公网直链。历史图片不可读取时，请用户重新上传。
- 需要用图找相似候选、同款或出处时，当前工具开放则先调用 `similar_image_search`。按当前 Schema 使用该图的 `attach_id` 或 `image_url`。只接受 URL 的会话需要可访问的图片直链。没有合适输入时说明限制。
- 搜图分数用于排序。用图像细节、候选页面和可信来源核对身份或出处。需要文字线索时，再用 `web_search` 查询。证据不足时用「可能相关」。
- 回答时说明结论、关键视觉依据和仍待核实之处。引用候选时用标题或实际来源链接。
