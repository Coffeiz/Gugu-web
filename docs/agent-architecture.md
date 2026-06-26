# Agent 架构图

> 咕咕 Agent 的两张架构全景：
> - **图一 · 可靠性执行架构**：一轮对话怎么从用户消息走到回复，每个确定性守卫挂在链路哪个点（回答「怎么保证说做了就真做了」）。
> - **图二 · 全系统模块全景**：有哪些模块、各自干啥、怎么连（回答「系统长什么样」）。
>
> 文字详解见 [`agent.md`](agent.md)（模块全景）、[`agent-reliability.md`](agent-reliability.md)（可靠性工程）、[`agent-决策环.md`](agent-决策环.md)（一轮内部步骤）。

---

## 图一 · 可靠性执行架构（一轮对话）

一轮对话不是「调一次大模型」的黑盒，是**带守卫的流水线**：上下文装配 → 模型 → 工具循环 → 验证层 → 出口清洗 → 回复。🛡 标记处是**确定性守卫**（代码兜底，不靠模型自觉）。

```mermaid
flowchart TD
    U["用户消息"] --> WEB["adapters/web.stream<br/>🛡 先订阅 open_subscription 后启动生成<br/>（避免首条 token 丢失=空气泡）"]
    WEB --> GEN["_generate 后台任务<br/>（脱离 HTTP，刷新不中断）"]

    subgraph CTX["① 上下文装配"]
        direction TB
        LOAD["loaders<br/>项目 / 日程 / 文件 / 记忆"]
        BUILD["context/builder<br/>persona + skills + policy + 风格 + 记忆 + 实时数据"]
        ATT["chat_attach<br/>附件解析 / vision 图片块"]
        SAN0["🛡 sanitize_messages<br/>历史 tool_use/result 配对清洗<br/>（防孤儿块 → MiniMax 400）"]
        LOAD --> BUILD
    end
    GEN --> CTX
    CTX --> PICK["llm_select.pick_model<br/>🛡 use_anthropic_for 统一选通道<br/>+ 非标准鉴权头（mimo api-key）"]

    subgraph LOOP["② core 工具循环（while ≤ MAX_ROUNDS=6）"]
        direction TB
        MODEL["模型流式调用<br/>_stream_round（thinking + 瞬时错误退避重试）"]
        Q{"返回里有<br/>tool_use？"}
        DISP["🛡 registry.dispatch<br/>所有工具执行的唯一咽喉<br/>（user_id 归一 / 异常兜底 / [TOOL-DBG]）"]
        TR["tool_result 回填"]
        MODEL --> Q
        Q -->|"是"| DISP --> TR --> MODEL
    end
    PICK --> MODEL

    subgraph VER["③ Verifier 验证层（核心可靠性）"]
        direction TB
        G{"本轮收尾判定"}
        NARR["🛡 narration 兜底<br/>声称读/改却没调工具<br/>→ _NARRATION_NUDGE 强制重入"]
        VFY["🛡 自我核实闭环 MAX_VERIFY=3<br/>did_mutate → 查询工具查证 / 不全补做<br/>verify_queried：只嘴上确认 → 强制真查"]
        EMPTY["🛡 空回复兜底 empty_retry<br/>（mimo 整轮进 reasoning、正文空）"]
        G -->|"假装操作"| NARR
        G -->|"改过数据"| VFY
        G -->|"正文为空"| EMPTY
    end
    Q -->|"否"| G
    NARR --> MODEL
    VFY --> MODEL
    EMPTY --> MODEL

    G -->|"干净通过"| OUT["🛡 出口清洗<br/>StreamSanitizer（MiniMax 标记）<br/>+ strip_disallowed_emoji（白名单外删）<br/>+ outbound（IM：tool_id/术语清洗）"]
    OUT --> PUB["genstream.publish<br/>→ SSE 实时 / 快照续看"]
    OUT --> PERSIST["持久化<br/>content_json（含 tool 回合）<br/>🛡 strip_vision_for_history（图占位）"]
    PUB --> USER["用户看到回复"]
    PERSIST --> DBH[("对话历史")]

    classDef guard fill:#fde8d4,stroke:#e08a3c,color:#7a4410;
    class WEB,SAN0,PICK,DISP,NARR,VFY,EMPTY,OUT,PERSIST guard;
```

**四层抽象**（OpenClaw 同款 Planner→Runtime→Tools→Verifier，Verifier 不通过则回灌重跑）：

```mermaid
flowchart LR
    P["Planner<br/>LLM 决定调哪个工具"] --> R["Runtime<br/>core 工具循环 · MAX_ROUNDS"]
    R --> T["Tools<br/>registry.dispatch 确定性执行"]
    T --> V["Verifier<br/>核实闭环 + narration 兜底 + 出口清洗"]
    V -->|"不通过 → 重入"| R
    V -->|"通过"| OUTR["回复出门"]
```

> **守卫成色**（详见 [agent-reliability.md](agent-reliability.md) §二）：✅硬 = emoji strip / 出口清洗 / confirm 两步 / SSRF / genstream 竞态；🟡半硬 = narration 兜底、自我核实（检测是代码、纠偏靠再喂 prompt）；🔴软 = 「明确请求要执行」目前仅 prompt 约束，是当前最大缺口。

---

## 图二 · 全系统模块全景

入口（Web / IM）→ 大脑（core 工具循环）→ 能力（tools/skills）/ 上下文记忆，底座是模型与存储。

```mermaid
flowchart TB
    subgraph IN["入口 adapters"]
        direction LR
        WEBUI["Web 前端"] --> WEBAD["adapters/web<br/>stream / resume / _generate"]
        IMC["IM：QQ / 飞书"] --> IMGW["IM 网关<br/>秒回反馈 + 入队（毫秒级）"] --> IMRUN["runner<br/>IM 编排（串行：一会话一 Agent）"]
    end

    subgraph BRAIN["大脑"]
        direction TB
        CORE["core.py · LLMRunner<br/>工具循环 / 流式 / 自我核实 / narration 兜底"]
        LLMSEL["llm_select<br/>pick_model（active/pool/router）<br/>use_anthropic_for / 鉴权头"]
        SANI["sanitize<br/>历史配对 / 流式标记 / emoji"]
        CORE --- LLMSEL
        CORE --- SANI
    end
    WEBAD --> CORE
    IMRUN --> CORE
    WEBAD --> GS["genstream<br/>pub/sub 频道 + 快照续看"]

    subgraph CAP["能力层"]
        direction TB
        REG["tools/registry<br/>dispatch 唯一咽喉 · 双格式 schema"]
        TOOLS["tools<br/>项目 / 文件 / 日历 / 客户 / 搜索 / 定时"]
        SKILLS["skills（剧本）<br/>use_skill + http_get（SSRF 拦）"]
        CONF["confirm<br/>不可逆操作两步确认"]
        REG --> TOOLS
        REG --> SKILLS
        TOOLS --- CONF
    end
    CORE --> REG

    subgraph CM["上下文与记忆"]
        direction TB
        BUILDER["context/builder<br/>系统提示词装配"]
        PROMPTS["prompts<br/>persona / skills / policy / default"]
        MEM["memory<br/>反思写入 / 对话压缩"]
        ATTACH["chat_attach<br/>附件 / vision 看图"]
        BUILDER --> PROMPTS
    end
    CORE --> BUILDER
    CORE --> MEM
    CORE --> ATTACH

    LLMSEL --> MODELS[("模型<br/>MiniMax-M3 / mimo / Anthropic…")]
    REG --> PG[("PostgreSQL")]
    MEM --> PG
    GS --> REDIS[("Redis pub/sub")]
    EVT["events<br/>资源变更广播"] --> REDIS
    REG -.->|"增删改触发"| EVT

    classDef store fill:#e6eefb,stroke:#5a7fc0,color:#22406e;
    class MODELS,PG,REDIS store;
```

---

## 读图要点

- **可靠性的本质**（图一）：模型只在「② 工具循环」里**决定调哪个工具**；它**对不对、做没做、说没说谎**，由两侧的确定性守卫（① 装配前清洗 / ③ 验证层 / 出口清洗）兜底。这是 [agent-reliability.md](agent-reliability.md) 的「坑→守卫，别坑→prompt」落到图上的样子。
- **唯一咽喉**（图二）：所有工具执行只过 `registry.dispatch` 一个点——观测、鉴权、异常、`[TOOL-DBG]` 全挂这里，是「先可观测、再优化」的抓手。
- **底座是模型**：图一③的一串 mimo 专属兜底（`empty_retry`、空回复重试）反向说明——弱模型靠工程补，强模型省一半事；可靠性场景默认走强工具模型（见 reliability §五）。

> 本图随架构演进更新；任何「现状 → 演进」的取舍记录见 [agent-reliability.md](agent-reliability.md)「一页纸总结」。
