# PRD-ARCH-1：Gugu 后端架构与职责分层

## 1. 文档状态

- 状态：当前架构基线
- 决策：**暂停并取消“将 Gugu 后端整体迁移到 TypeScript/Next.js”的目标**。
- 当前后端 owner：Python 3.12 + FastAPI + Agent Worker。
- TypeScript 当前用途：前端 Vue/Vite、独立 RAG/BM25 高性能模块和必要的构建脚本；不作为 Web API、Agent runner、IM 或 scheduler 的替代后端。
- 数据基础设施：PostgreSQL + Redis；数据库 schema 迁移继续由 Alembic 负责。
- `PRD-ARCH-4-TypeScript后端目录职责重组` 的有效职责内容已并入本文；后续只维护本文。

## 2. 当前目标

当前阶段的目标是稳定和收口 Python 后端职责，而不是继续扩大语言迁移范围：

1. 保持 Web、Admin、Agent、IM、定时任务和终端由 Python 统一承载。
2. 保持 Agent 的 context、memory、skills、prompts、sandbox 等职责边界清晰。
3. 保持 Web、QQ、飞书、微信和定时任务共用同一套 Agent、工具和事件协议。
4. 允许 TypeScript 作为 RAG/BM25 等独立高性能模块，通过明确协议被 Python 调用。
5. 清理错误的迁移文档、未使用的 TS API 入口和与当前架构冲突的过渡实现，不移动稳定的 Python 目录。

## 3. 当前运行架构

```text
Vue + Vite
    │ HTTP / SSE / WebSocket
    ▼
Python FastAPI
    ├── Web/Admin API、认证、用户设置和 CRUD
    ├── Live 业务事件 SSE
    ├── Agent gateway / Web chat gateway
    └── 任务创建、状态查询和流式结果转发

Python Worker
    ├── Agent runner、round、tool dispatch
    ├── context / snapshot / history / compaction
    ├── skills / prompts / memory / RAG 编排
    ├── QQ、飞书、微信消息循环
    ├── scheduler 和长任务
    ├── LoopScope trace、usage 和 cache 记录
    └── Shell / sandbox / terminal 调用

TypeScript 独立模块
    └── RAG tokenizer / BM25 / score / filter / index worker

PostgreSQL + Redis
    ├── PostgreSQL：业务数据、消息、工具事件、任务和审计状态
    └── Redis：队列、取消信号、事件广播、锁、缓存和 Worker 协调
```

## 4. 规范目录结构

以下是当前有效目录。Python 目录不再迁移到 `backend/py`，也不为 TypeScript 创建 Python 镜像目录。

```text
backend/
├── app/                              # FastAPI API 与业务服务
│   ├── api/v1/                       # Web/Admin/资源 API 路由
│   ├── core/                         # 配置、Redis、事件、权限、基础设施
│   ├── db/                           # SQLAlchemy session 与数据库依赖
│   ├── models/                       # SQLAlchemy ORM model
│   ├── schemas/                      # api/Pydantic schema
│   ├── search/                       # Global Search 等 API 搜索能力
│   └── services/                     # CRUD、存储、日历等领域服务
├── agent/                            # Agent 业务域与 Worker 逻辑
│   ├── capabilities/                # 能力声明、工具/Skill 可用性
│   ├── commands/                     # /stop、/compact、/goal 等命令
│   ├── context/                      # snapshot、history、baseline、预算、压缩
│   │   └── assembly/                 # canonical context 分层组装
│   ├── events/                       # Agent 内部事件与领域事件
│   ├── gateway/                      # Web/IM Agent 入口编排
│   ├── interactions/                 # ask_user、确认、目标等交互状态
│   ├── knowledge/                    # 知识来源与文档加载协议
│   ├── llm/                          # 生成流、usage 和 provider 调用边界
│   ├── memory/                       # profile、pattern、daily、长期记忆
│   ├── profiles/                     # Agent profile 与行为配置
│   ├── prompts/                      # system、policy、Skill、压缩提示词
│   │   ├── behaviors/                # 行为配置提示词
│   │   └── im/                       # IM 兼容格式提示词
│   ├── providers/                    # OpenAI/Anthropic/DeepSeek 等 adapter
│   ├── rag/                          # Python 侧 RAG 编排、权限和结果回填
│   │   └── adapters/                 # RAG 来源 adapter
│   ├── runtime/                      # run/round、取消、恢复、LoopScope
│   │   └── loopscope_trace/          # trace hook 与跨进程恢复
│   ├── sandbox/                      # Shell 沙盒策略与执行边界
│   ├── security/                     # 脱敏、权限和安全校验
│   ├── selection/                    # 模型、工具、Skill 和能力选择
│   ├── skills/                       # Skill 注册、加载、匹配和工具注入
│   ├── terminal/                     # 终端服务与终端事件
│   ├── tools/                        # 工具定义、执行、确认和结果归一化
│   ├── im/                           # QQ/飞书/微信平台循环与 adapter
│   │   ├── parsers/                  # 平台消息解析
│   │   └── emoji/                    # 平台表情资源
│   └── runner.py                     # Worker/Agent 运行入口
├── ts/                               # 独立 TypeScript 辅助模块，不是替代后端
│   ├── packages/contracts/           # RAG/协议共享类型
│   ├── workers/rag/                  # RAG tokenizer/BM25/index worker
│   └── scripts/                      # 构建和协议检查脚本
├── bin/                              # 固定运行时制品
├── alembic/                          # PostgreSQL 唯一 schema migration
├── tests/                            # Python 后端回归测试
├── worker.py                         # Worker 启动入口
├── Makefile
└── config.override.json              # 用户运行配置，不由测试和构建覆盖
```

### 4.1 目录职责规则

- `app/api/v1` 只负责 HTTP 输入输出、认证依赖、参数校验和 use case 调度；数据库业务细节放在 `app/services` 或明确领域模块。
- `agent/context` 只负责上下文快照、历史归一化、预算和压缩，不直接执行工具或决定用户权限。
- `agent/memory` 负责记忆领域读写；RAG 索引、BM25 和召回执行由 `agent/rag` 与 TS RAG worker 负责。
- `agent/prompts` 负责静态 policy、行为提示词和压缩提示词；工具权限由代码和注册表决定，不由提示词决定。
- `agent/skills` 负责 Skill manifest、匹配和工具 schema 注入；工具实际执行由 `agent/tools` 负责。
- `agent/sandbox` 是 Shell/文件系统/网络安全边界；Agent 只能经由工具接口访问，不得从 context 或 memory 直接访问容器、宿主路径或 PTY。
- `agent/runtime` 负责 run/round 生命周期、取消、恢复、长任务和 trace；`gateway` 不持有独立的执行状态。
- `agent/im` 只处理平台消息归一化、入队、发送和平台 adapter，不复制 Agent runner。
- `ts/` 只作为明确协议的独立辅助模块。不得新建 TypeScript API、TS Agent runner、TS IM worker 或 TS scheduler 来形成第二套后端。
- `bin/` 只放可执行构建物；`var/`、索引、临时文件和用户数据不得进入 Git。

## 5. 数据与协议边界

### 5.1 数据库

- PostgreSQL 由 SQLAlchemy 2.x 访问，Alembic 是 schema migration 的唯一负责人。
- 用户、session、message、tool event、interaction、任务、终端和 RAG 元数据使用现有数据库模型。
- 任何迁移或字段变更都必须先备份并补 migration，不能由 TS worker 或测试脚本隐式建表。

### 5.2 Redis

- Redis 用于 IM/Agent 队列、取消信号、run 状态、SSE fanout、短锁、缓存和 Worker 协调。
- 事件发布使用 canonical event envelope；业务事务成功提交后再发布。
- Redis pub/sub 不是可靠历史队列；需要补偿的领域必须有 revision、sequence 或重新读取数据库的路径。

### 5.3 Agent 与 Provider

- Web、IM、定时任务共享 Agent runner、canonical history、snapshot、工具注册和交互协议。
- Provider wire format 只在 `agent/providers` 边界转换；上下文和工具历史使用 canonical 结构。
- 权限、scope、危险命令和 destructive confirm 必须由代码校验；提示词只能描述使用方式和 policy。

## 6. TypeScript 辅助模块边界

TypeScript 目前只保留对性能有价值且协议清晰的独立模块：

- RAG tokenizer、BM25、评分过滤和索引 worker；
- 必要的构建脚本和协议测试；
- 不承担公开 API、认证、用户设置、Agent loop、工具权限、IM 常驻连接或定时任务。

Python 调用 TS 模块必须使用 stdin/stdout 或明确的本地协议，输入输出使用结构化 JSON，失败必须显式返回错误，不得把异常转换为空召回或空结果。

## 7. 实施状态

原“TypeScript 后端迁移”实施计划停止，不再继续执行以下事项：

- TypeScript API 接管 FastAPI CRUD；
- TypeScript Agent runner、tool dispatch、IM 和 scheduler；
- `backend/py` 重排和 Python 旧入口删除；
- Next.js、NestJS 或 Nuxt 作为后端替代方案。

当前继续维护：

- [x] Python/FastAPI 作为唯一后端 API owner；
- [x] Python Agent 细分目录：context、memory、prompts、skills、sandbox、tools、runtime、IM；
- [x] TypeScript RAG/BM25 独立模块和固定制品边界；
- [x] PostgreSQL/Alembic 与 Redis 的单一职责边界；
- [ ] 清理未使用的 TS api/迁移脚本和与当前架构冲突的文档；
- [ ] 为关键领域补充跨 Web/IM/Agent 的一致性测试。

## 8. 运行配置与安全约束

- `backend/config.override.json`、`.env`、数据库和用户文件属于运行数据，测试、构建、同步和部署不得覆盖。
- 日志不得写入聊天正文、附件内容、真实用户名、Token、API Key 或签名 URL；诊断使用脱敏 fingerprint。
- destructive 工具必须经过代码确认门；不能通过提示词、正则或 UI 状态替代后端权限检查。
- devserver 和生产环境只消费已构建制品；运行时目录使用明确权限并排除出 Git。
