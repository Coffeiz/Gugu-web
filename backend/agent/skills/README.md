# Skill 注册格式

每个 Skill 是 `backend/agent/skills/` 下的一个 Markdown 文件，通过 frontmatter 自动扫描，
不需要在 Python 注册表里手写文件名：

```markdown
---
name: 资料搜索
description_short: 用户需要联网查找、核对或比较资料时使用。
category: search
related_tools: web_search, image_search
source: builtin
---

这里写只在 `use_skill` 显式加载后注入的完整操作说明。
```

`description_short` 为 1-100 个 Unicode 字符；`description_long` 保存较完整的触发说明；正文不是首轮目录，
不要把完整工具 Schema 复制进正文。旧 `description`/`when` 只作为迁移兼容字段，新文件禁止使用。
