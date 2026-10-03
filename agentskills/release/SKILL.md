---
name: release
description: 发版、PR 编写与合并、版本 tag、CHANGELOG 与生产部署的操作规范。用户要求编写 PR、合并 PR、发版、打 tag、升版本号、CI 全绿、tag 重打或生产部署时阅读。
---

# 发版与 PR 规范

事实源是 `docs/ops/release.md`——本 skill 只提供触发时机和流程骨架，步骤细节以 release.md 为准，两边不要各写一套。

## 何时读这份 skill

- 用户要求创建、撰写或完善 PR 描述；
- 用户要求合并 dev → main 的 PR、催 CI 全绿；
- 用户说发版 / 升版本号 / 打 tag / 重打失败的 tag / 更新 CHANGELOG；
- 用户要求部署到生产（业务机）或检查生产版本。

## 流程骨架（细节见 release.md 对应章节）

撰写或完善 PR 描述时，按 `docs/ops/release.md` §1.1 为标题选择一个主要类型，并在正文勾选本 PR 实际包含的全部类型；创建 PR 时使用 `.github/PULL_REQUEST_TEMPLATE.md`。本 skill 不复制模板字段，规范事实源仍是 release.md。

1. **PR 合并（dev → main）**：GitHub CI 不随 PR 自动触发（省 Actions usage）。合并前必须人工触发两个 workflow（Runtime integration、Docker release）各一次并选 PR 分支，全部全绿后才允许合并（release.md §1）。**未经用户授权不得主动触发 CI**——这是 AGENTS.md 常驻红线。
2. **打 tag 前核对 CI**：等待 main 合并提交对应的 `Runtime integration` 与 `Docker release` 自动 workflow 均完成且成功；以远端精确 SHA 的状态为准，不在 devserver 重复运行同一套测试、镜像构建或 Trivy 扫描。只有 CI 未覆盖且与本次发布风险直接相关的项目，才做有理由的定向补充验证（release.md §2）。
3. **版本号与 CHANGELOG**：升号时同步确认 DevTools 控制台 ASCII 横幅版本号（取自 `frontend/package.json`，release.md §3）；发布说明按固定结构写（release.md §3.1）。
4. **打 tag 与发布**：tag/Release 标题用纯 `vx.y.z`；推 tag 后继续监控自动发布 workflow，全部必需 job 成功后才算发布完成；失败恢复规则见 release.md §4。
5. **生产部署**：生产机为 root@<host> 的 /opt/Gugu-web-main（release.md §5）；回滚时不要 prune 悬空旧镜像。

## 提交与推送约束

提交时机、推送与历史安全遵守 AGENTS.md 的「语言与提交」「Git 提交完整性」两节，本 skill 不重复。
