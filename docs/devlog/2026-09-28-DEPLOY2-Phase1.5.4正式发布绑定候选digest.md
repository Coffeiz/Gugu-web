# PRD-DEPLOY-2 Phase 1.5.4：正式发布绑定候选 digest

## 问题

tag 发布 job 原先没有依赖 `assemble-candidate`，app 发布步骤仍从 `:ci-<run_id>` 复制基础镜像。该基础镜像尚未追加 sandbox bundle，因而正式版本可能绕过候选验证并发布不含内置 runtime 的 app。

## 修复

- tag 发布显式等待 `assemble-candidate`，并读取该 job 输出的候选 app digest。
- GHCR 与 Docker Hub 的 app 版本 tag 都从同一不可变候选 digest 复制；backend、frontend、sandbox 仍从本轮 CI 镜像复制。
- 后续 digest 解析、Cosign 签名、稳定版 `latest` 和 updater manifest 继续基于正式版本 tag，因此 app manifest 使用的 Docker Hub digest 来自同一候选。
- `publish` 仍仅允许 `refs/tags/v*`。workflow_dispatch 只构建/验证候选，不发布正式 tag 或 Release；普通 main 构建不增加 app 临时推送。

## 验证

- release workflow Node 回归：22 项通过，覆盖候选依赖、GHCR/Docker Hub app 来源、manifest digest、stable latest、main 构建和手动候选发布门。
- workflow YAML 解析与 `git diff --check` 通过。
- 按仓库约定未触发 GitHub CI；真实候选全链路运行记录在 DEPLOY2-007c-ci。
