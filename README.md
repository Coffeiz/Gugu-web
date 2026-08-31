<div align="center">

# 咕咕

### Agent UI，必须先有 UI。

咕咕的想法：把散落的看板、日历、笔记、文件和画布放到一起，让用户和 Agent 在同一个地方做事。

[![status](https://img.shields.io/badge/status-active-success?style=flat)](https://gugugu.site)
[![stage](https://img.shields.io/badge/stage-private%20beta-8A7A63?style=flat)](#项目状态)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat)](LICENSE)
[![Vue](https://img.shields.io/badge/frontend-Vue%203-42b883?style=flat)](frontend/)
[![Python](https://img.shields.io/badge/backend-Python%203.12-3776ab?style=flat)](backend/)

[中文](README.md) ｜ [English](README_EN.md) ｜ [在线预览](https://gugugu.site)

</div>

## 能做什么

| 领域 | 能力 |
| --- | --- |
| Agent | 多轮对话、工具调用、联网搜索、定时任务和流式响应 |
| 工作空间 | 管理项目、阶段、任务、日历、提醒、文件、笔记、终端和无限画布 |
| 信息获取 | 联网搜索、站内全文搜索、Knowledge / RAG、文件内容检索和相似图搜索 |
| 长期上下文 | 记忆用户习惯、近期状态、知识和行为模式，支持跨对话延续上下文 |
| 沙盒执行 | 在隔离环境中运行 Shell 命令，提供工作目录、执行状态和资源边界 |
| 多用户与租户 | 多用户账户、账户级数据隔离和独立配置；团队协作与多租户能力持续完善 |
| 权限与安全 | 用户身份、资源归属、会话权限、管理员后台和危险操作确认门 |
| 即时通讯 | 接入 QQ、微信、飞书等渠道，支持私聊、群聊、消息归一化、上下文会话和通知推送 |
| 管理后台 | 管理用户、模型、BYOK、搜索、邮件通知、文件存储、日志和系统服务 |
| 开发观测 | 使用 LoopScope 查看 Agent Loop、Token、Cache、Tool Call 和性能诊断 |
| 部署运维 | Docker Compose 部署、统一入口、健康检查、日志、数据卷和备份支持 |

## 为什么做咕咕？

本人原本是一名插画师，以前经常遇到一种情况：和客户约好的稿子忘了记录，后来忙着忙着也就忘了，平时也有一些文件管理上的苦恼。

后来有段时间尝试了下 QwenPaw，发现 Agent 在记录项目、整理文档和想法上效率很高。但找了一圈，没有发现一个顺手的 UI：Agent 记录的大量文档，最后还是需要自己去本地找，或者让 Agent 发回来再自己整理。

Gugu 一开始只有项目管理功能，但后来慢慢加上了交互 Runtime、文件系统、看板、画布、Shell 和沙盒。现在它已经比最初大了很多，相信这些功能也不只是我一个人用得到。

> 如果最后还是一个聊天框，为什么要叫 Agent UI？

欢迎试用，也欢迎前往 [gugugu.site](https://gugugu.site) 在线体验，或者按照下方的说明在本地部署。不过服务器能力有限，在线体验时可能会没那么流畅。最后，也欢迎提 Issue 和 PR。

## 功能预览

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="frontend/public/onboarding/kanban-drag-1.gif" width="100%" alt="看板跨列拖拽示例">
      <h3>看板</h3>
      <p>项目、阶段、任务和截止日期组成真实的项目工作流。</p>
    </td>
    <td width="50%" valign="top">
      <img src="frontend/public/onboarding/file-drag-1.gif" width="100%" alt="文件库拖拽示例">
      <h3>文件库</h3>
      <p>文件、项目和个人资料在同一套工作空间中持续沉淀。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="frontend/public/onboarding/canvas-drag-1.gif" width="100%" alt="画布自由落点拖拽示例">
      <h3>画布</h3>
      <p>把便签、项目、文件和日历活动放到自由画布中，建立可视化关系。</p>
    </td>
    <td width="50%" valign="top">
      <img src="frontend/public/onboarding/IM-messages-1.gif" width="100%" alt="咕咕聊天示例">
      <h3>咕咕聊天</h3>
      <p>通过自然语言搜索、整理和修改工作空间中的真实数据。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/loopscope.png" width="100%" alt="LoopScope Agent 可观测示例">
      <h3>LoopScope</h3>
      <p>观察 Agent Loop、Token、Cache、Tool Call 和运行性能。</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/admin_page.png" width="100%" alt="Admin 管理后台示例">
      <h3>Admin</h3>
      <p>管理模型、用户、配置、日志、反馈和系统运行状态。</p>
    </td>
  </tr>
</table>

## Gugu 是什么

咕咕不是给聊天框增加几个工具，而是让 Agent 工作在真实的个人工作环境中。

### Workspace

项目、日历、文件、笔记和画布组成一个持续使用的个人工作空间。信息不再分散在互不关联的页面和对话里，而是可以围绕项目和时间自然沉淀。

### Agent

Agent 可以通过工具读取和修改这些工作状态：查找项目、创建任务、安排日历、搜索文件、整理笔记，或在授权后执行更复杂的操作。

### Memory

随着长期使用，咕咕会形成关于用户、习惯、知识和近期状态的上下文，让后续对话不必每次从零开始。

```text
                  Gugu Agent
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    Workspace       Memory         Tools
       │                              │
 ┌─────┼─────┐                 Search / Shell
 项目  日历  文件 ...              IM / Actions
```

## 核心能力

### AI Agent

- 多轮 Agent Loop
- Tool Calling
- Web Search
- Shell Sandbox
- Scheduled Tasks

### 工作空间

- 项目与任务
- 日历与提醒
- 文件库
- 笔记与无限画布

### 长期上下文

- Memory
- Knowledge / RAG
- 用户与行为模式

### 外部连接

- QQ
- 微信
- 飞书
- 其他 IM 渠道

### 开发与观测

- LoopScope
- Interaction Runtime
- 管理后台与审计日志

## 技术亮点

### Agent Runtime

统一处理 Agent 上下文、模型 Round、工具选择、工具执行和受控续轮。相关设计见 [Agent 文档](docs/agent/00-INDEX.md) 和 [Agent Loop](docs/agent/03-AGENT-LOOP.md)。

### Memory

负责长期用户上下文、近期状态、知识召回和反思结果。相关设计见 [Memory 与 Reflection](docs/agent/07-MEMORY-AND-REFLECTION.md) 和 [RAG 与 Knowledge](docs/agent/06-RAG-AND-KNOWLEDGE.md)。

### LoopScope

用于观察 Agent Runtime 的运行链路、Token、缓存、工具调用和性能问题。相关说明见 [LoopScope 文档](docs/agent/11-LOOPSCOPE.md)。

### Interaction Runtime

独立的 npm Runtime，负责复杂拖拽、跨容器交互、画布落点和视觉生命周期。Gugu-web 通过 `gugu-interaction-runtime` npm package 使用它，相关仓库见 [Gugu Interaction Runtime](https://github.com/Coffeiz/Gugu-interaction-runtime)。

## 快速开始

### 前置要求

- Docker 20+ 和 Docker Compose v2
- 可访问的模型 Provider 或 BYOK 配置
- 首次启动需要 PostgreSQL、Redis 和网络访问

### Docker Compose

```bash
git clone https://github.com/Coffeiz/Gugu-web.git
cd Gugu-web
cp .env.example backend/.env
# 编辑 backend/.env，填写 SECRET_KEY 和模型配置
docker compose up -d
```

启动后访问：

- Gugu：<http://localhost:9595>
- Admin：<http://localhost:9595/admin/>
- Backend API：<http://localhost:8000/docs>
- LoopScope Collector：<http://localhost:4320>

首次运行会初始化数据库并执行迁移。Admin 账号由 `backend/.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 控制，生产环境必须修改默认值。

需要 Shell 沙盒时，再显式启用：

```bash
docker compose --profile sandbox up -d
```

## 配置

README 只保留配置索引，完整变量和运行规则将在 `docs/configuration.md` 中整理。

| 配置用途 | 说明 |
| --- | --- |
| Database | 主数据存储，默认使用 PostgreSQL |
| Redis | 消息、会话和 Runtime 状态 |
| LLM / BYOK | 模型 Provider 和个人 API Key |
| Search | Web Search 与站内搜索后端 |
| Mail | 用户反馈和系统邮件通知 |
| IM | QQ、微信、飞书连接 |
| LoopScope | Agent 链路和性能观测 |
| Sandbox | Shell 执行环境和网络出口 |

## 部署

生产环境使用构建物 Docker Compose 和 Nginx，通过 `9595` 提供统一入口：

```bash
docker compose -f docker-compose.prod.yml up -d
```

生产部署的数据库、Redis、文件、记忆、配置卷、迁移、备份、日志和健康检查见 [生产部署文档](docs/ops/DEPLOY.md)。

部署摘要：

- 生产镜像使用前后端构建产物，不挂载源码
- 前端 Runtime 从 npm 安装，不依赖同级 `gugu-interaction-runtime` 仓库
- PostgreSQL、Redis 和用户数据使用持久化卷
- 镜像标签应使用 Git SHA 或版本号，不依赖 `latest`
- 升级前应备份数据库和用户数据

## 项目结构

```text
gugu/
├─ frontend/      Web 工作空间与 Admin 前端
├─ backend/       API、Agent、Memory、Tools 与数据服务
├─ loopscope/     Agent 可观测系统
├─ docker/        部署与运行环境
└─ docs/          产品、架构、运维与开发文档
```

后端仍处于持续演进中，具体模块边界以 [Backend 文档](docs/backend/OVERVIEW.md) 和 [Agent 架构文档](docs/agent/02-ARCHITECTURE.md) 为准。

## 架构

```text
Web / Desktop / IM
        │
        ▼
      Gugu
        │
 ┌──────┼──────────┐
 │      │          │
Agent  Workspace  Memory
 │                  │
Tools              RAG
 │
LLM Providers
 │
LoopScope
```

当前事实型文档：

- [Agent Architecture](docs/agent/02-ARCHITECTURE.md)
- [Agent Loop](docs/agent/03-AGENT-LOOP.md)
- [Memory 与 Reflection](docs/agent/07-MEMORY-AND-REFLECTION.md)
- [RAG 与 Knowledge](docs/agent/06-RAG-AND-KNOWLEDGE.md)
- [LoopScope](docs/agent/11-LOOPSCOPE.md)
- [Backend Overview](docs/backend/OVERVIEW.md)
- [Interaction Runtime](https://github.com/Coffeiz/Gugu-interaction-runtime)

## 开发

### 环境准备

```bash
corepack enable
corepack pnpm install
```

### 启动前端

```bash
corepack pnpm --filter gugu-web dev
```

### 启动后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
make dev-web
```

### 常用检查

```bash
corepack pnpm --dir frontend typecheck
corepack pnpm --dir frontend test:run
corepack pnpm --dir frontend build
cd backend && PYTHONPATH=. .venv/bin/pytest
```

前端复杂拖拽和画布交互依赖已发布的 `gugu-interaction-runtime` npm package。Runtime 本身是独立仓库，不在 Gugu-web workspace 中直接编译。

## 项目状态

Gugu 当前仍处于快速迭代阶段，适合个人部署、体验和参与开发。

| 状态 | 含义 |
| --- | --- |
| ✅ Stable | 已有持续使用和回归验证的能力 |
| 🚧 In Development | 主要流程可用，仍在快速调整 |
| 🧪 Experimental | 设计或实现仍可能发生较大变化 |

### Roadmap

- 持续提升 Agent 工具调用准确性和可观测性
- 完善 Memory 与 Knowledge 的长期使用体验
- 扩展文件、画布和项目之间的协同操作
- 完善 QQ、微信、飞书等外部连接
- 补充安装、部署和备份文档

## 贡献

这是一个 Vibe Coding 项目。大量实现由 AI 辅助完成，但架构、产品方向、代码审查和验收由人工负责。

欢迎通过 Issue 报告问题、提出建议，也欢迎通过 Pull Request 贡献改进。

提交前建议完成：

```bash
corepack pnpm --dir frontend typecheck
corepack pnpm --dir frontend test:run
corepack pnpm --dir frontend build
cd backend && PYTHONPATH=. .venv/bin/pytest
```

Bug 修复应尽量补充对应的 regression test；报告问题时请提供复现步骤、运行环境、相关日志和脱敏后的截图，不要提交密钥、Token 或用户隐私数据。

## License & Contact

本项目使用 [Apache License 2.0](LICENSE)。

问题反馈和合作联系请优先使用 GitHub [Issues](https://github.com/Coffeiz/Gugu-web/issues)。
