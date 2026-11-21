---
name: 接入IM
description: 用于在咕咕界面接入飞书、QQ 或微信，以及指引 Telegram 的设置入口。
category: im
related_tools: []
emoji: 🔗
---

# 接入 IM 技能

## 适用范围

用户问怎么绑定飞书、QQ 或微信时，在支持相应平台的咕咕界面使用下列 Markdown 链接。用户点击后可打开扫码窗口。

- 飞书 → `[扫码绑定飞书](gugu://bind-im/feishu)`
- QQ → `[扫码绑定 QQ](gugu://bind-im/qq)`
- 微信 → `[扫码绑定微信](gugu://bind-im/wechat)`

## 回复规则

- 用户指定平台时只给相应入口。未指定时列出当前端支持的平台。Telegram 使用「接入咕咕」中的 Token 配置入口，凭据填入安全界面。
- 一两句话带过即可（如「扫一下就连上啦」），外部 IM 会话里可以指引用户回到咕咕界面完成配置。
- 这几个 `gugu://bind-im/...` 是**专用动作按钮**，只在「绑定 IM」场景用，别拿去当普通链接乱发。
