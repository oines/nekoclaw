# 持久化 Agent 运行时架构

一套将 AI agent 部署到真实通信平台的框架，赋予 agent 持久身份、分层记忆和主动存在感。核心理念：**LLM 负责理解和判断，运行时负责编排、持久化和投递。**

---

## 这套架构解决什么问题

传统聊天机器人是无状态的请求-响应系统。这套架构让 agent 能够：

- 跨会话记住人、关系和共同经历
- 在多个平台上以统一身份运作
- 主动行动，而不只是被动响应
- 在群组场景中区分"观察到的"和"参与过的"
- 保持一致的人格，并通过真实互动自然演化

---

## 系统总览

```
通信平台（Telegram、QQ、Discord 等）
        │
        ▼
   Channel Plugin          ← 平台适配层
        │
        ▼
   Message Router          ← 决定是否处理、如何处理
        │
        ▼
   Job Queue               ← 按 agent 串行化任务
        │
        ▼
   Worker                  ← 隔离执行环境
   ├── System Prompt Builder
   ├── Persona Context Loader
   ├── Tool Composition
   └── Session Hygiene
        │
        ▼
   Outbound Dispatch        ← 将响应投递回平台
        │
   （异步，非阻塞）
        ▼
   Persona Maintenance
   ├── Formation            ← 每轮对话后的局部记忆更新
   └── Dream                ← 每 6 小时的全局记忆整合
```

---

## 核心组件

### 1. Daemon（守护进程）

顶层编排器，持有所有服务，运行 2 秒同步循环。

**职责：**
- 启动时初始化并连接所有服务
- 重启后从队列日志恢复待处理任务
- 同步 agent 与 channel 的绑定关系
- 调度人格维护任务（Formation、Dream、积压扫描）
- 处理运行时控制指令（启动/停止/重启 agent）

**同步循环（每 2 秒）：**
1. 处理待执行的控制指令
2. 同步 agent↔channel 绑定
3. 为有观察积压的 agent 排队 Formation 扫描
4. 为记忆语料库已变更的 agent 排队 Dream

### 2. Channel Plugin（平台插件）

将特定平台适配到运行时的内部事件模型。

**插件必须实现的接口：**
- `outbound` — 发送消息、编辑、删除、显示输入状态
- `actions` — 平台特定能力（如获取群成员）
- `threading` — 解析线程/回复上下文
- `pairing` — 将聊天绑定到 agent
- `triggering` — 判断消息是否应激活 agent

**触发模式：**
- `mention` — 仅在 agent 被明确 @ 时触发（群组默认）
- `all` — 聊天中的每条消息都触发

### 3. Message Router（消息路由器）

接收来自 channel plugin 的原始入站事件，决定如何处理。

**处理流程：**
1. 解析会话地址（agent + channel + chat → session key）
2. 水化事件（将附件下载到本地工作区）
3. 将观察记录写入人格日志（始终执行，即使 agent 不回复）
4. 检查斜杠命令 → 单独处理
5. 检查触发规则 → 未触发则跳过
6. 检查配对状态 → 未配对则进入配对流程
7. 将 `RunJob` 加入队列

**关键设计：** 无论 agent 是否回复，观察都会被记录。这意味着 agent 在沉默时也在积累对群组对话的感知。

### 4. Job Queue（任务队列）

按 agent 串行化任务，防止同一 agent 并发执行。

**特性：**
- 每个 agent 独立的 FIFO 队列
- 最大深度：50 个任务（背压控制）
- 追踪哪些 agent 正在处理中
- 队列状态持久化到磁盘，支持崩溃恢复
- 所有队列操作都发出审计事件

**错误类型：**
- `QueueFullError` — 队列已满，消息被拒绝
- `RuntimeBusyError` — agent 正在处理，新任务已入队

### 5. Worker（工作进程）

在隔离环境中执行单个任务。无状态——所有上下文通过 `WorkerPayload` 传入，所有输出通过 `WorkerResult` 返回。

**WorkerPayload：**
```
agent              AgentSpec（slug、模型、配置）
job                RunJob（jobId、sessionKey、入站事件）
currentSession     SessionRecord（消息历史）
capabilities       ChannelCapabilities（平台支持的能力）
runtimeDirectory   RuntimeDirectorySnapshot（已知联系人/群组）
personaContext     PreparedPersonaContext（index.md + 场景观察）
selfIdentity       { platformUserId, handles, isExplicitlyAddressed }
effectiveModel     { provider, modelId, thinkingLevel }
```

**WorkerResult：**
```
outbound           ReplyPayload（默认回复文本/附件）
toolActions        ChannelToolAction[]（工具驱动的显式操作）
stopReason         string
errorMessage       string
```

**Worker 执行步骤：**
1. 加载 `SOUL.md`（人格）和 `MEMORY.md`（持久事实）
2. 构建系统提示词（见下方提示词结构）
3. 注入人格上下文（索引 + 场景观察）
4. 组合工具
5. 整理会话消息（应用 hygiene）
6. 调用模型
7. 收集工具操作
8. 返回结果

### 6. Session Hygiene（会话整洁）

防止长期运行的会话中提示词无限增长。

**Token 预算：**
- `reserveTokens`：20,000 — 始终为模型输出保留
- `keepRecentTokens`：20,000 — 近期消息历史预算

**裁剪策略（仅对工具结果，从不裁剪 assistant 消息）：**
1. 识别最后 3 条 assistant 消息之前的工具结果消息
2. **软裁剪**：若结果 >8,000 字符 → 保留前 1,500 + 后 1,500 字符
3. **硬清除**：若工具结果总量仍 >12,000 字符 → 用占位符替换最旧的结果
4. 最后 3 条 assistant 消息始终受保护

### 7. Outbound Dispatch（出站分发）

将 `WorkerResult` 转换为平台操作。

**ChannelToolAction 类型：**
```
send              发送新消息
reply             回复特定消息
edit              编辑已有消息
delete            删除消息
typing            显示输入状态
send_targeted     主动向其他会话发消息
no_reply          明确抑制默认回复
```

**路径重定向：** Agent 在容器内向 `/workspace/...` 写文件，Dispatch 在发送附件前将路径重定向到宿主机文件系统。

---

## 记忆架构

记忆系统是核心差异化所在。记忆是自由格式的 Markdown——没有固定 schema。Agent 自己决定什么值得记住、如何表达。

### 目录结构

```
{workspace}/
├── SOUL.md                          # 人格、声音、行为约束（纯 Markdown）
├── MEMORY.md                        # 持久事实（纯 Markdown）
└── .nekoclaw-persona/
    ├── index.md                     # 所有人物和场景的全局快照（纯 Markdown，≤2,000 tokens）
    ├── memory/
    │   ├── people/
    │   │   └── {person-name}.md     # 每人一个记忆文件（YAML frontmatter + Markdown 正文）
    │   └── scenes/
    │       └── {scene-ref}.md       # 每个场景记忆文件（YAML frontmatter + Markdown 正文）
    ├── observations/
    │   └── {scene-ref}.log          # 只追加的原始事件日志
    └── control/
        ├── dream.json               # Dream 状态（上次运行时间、语料库签名）
        └── formation-retries/
            └── {scene-ref}.json     # 每个场景的重试状态
```

**记忆文件格式要求：**
- `memory/people/*.md` 和 `memory/scenes/*.md` 必须包含 YAML frontmatter，格式：
  ```markdown
  ---
  title: 文件标题
  description: 简短描述，用于快速判断内容
  ---

  自然语言正文...
  ```
- `index.md`、`SOUL.md`、`MEMORY.md` 为纯 Markdown，无 frontmatter

### 记忆层级（按优先级注入提示词）

| 层级 | 来源 | 始终在提示词中？ | Token 预算 |
|------|------|----------------|-----------|
| 规则 | `SOUL.md` | 是 | — |
| 持久事实 | `MEMORY.md` | 是 | — |
| 记忆索引 | `index.md` | 是 | 2,000 |
| 场景观察 | `observations/{scene}.log` | 是（近期） | 1,200 |
| 会话历史 | `chats/{id}/context.jsonl` | 是 | 近期 20,000 |
| 人物/场景详情 | `memory/people/*.md`、`memory/scenes/*.md` | 按需（工具调用） | — |

**按需召回：** Agent 可在一轮对话中调用 `read(path)` 加载详细记忆文件。索引告诉它有哪些文件、各自包含什么。

### Memory Manifest（记忆清单）

**用途：** 为 Formation 和 Dream 提供记忆文件的结构化概览，避免逐个打开文件。

**数据结构：**
```typescript
interface PersonaMemoryManifestEntry {
  path: string              // 相对路径，如 "memory/people/alice.md"
  kind: "people" | "scene"  // 文件类型
  title: string             // 从 frontmatter 读取
  description: string       // 从 frontmatter 读取
  mtimeMs: number           // 文件修改时间
}
```

**文本格式：**
```
- [people] Alice | memory/people/alice.md (2024-01-15T10:30:00.000Z): 老朋友，摄影爱好者
- [scene] 技术讨论群 | memory/scenes/telegram-group-123.md (2024-01-14T15:20:00.000Z): 主要聊编程
```

**生成方式：**
- 动态扫描 `memory/people/*.md` 和 `memory/scenes/*.md`
- 读取每个文件的 frontmatter（title、description）
- 按 mtimeMs 降序排序（最新的在前）
- 限制最多 200 个文件

**使用场景：**
1. **Formation** — 了解有哪些记忆文件可以读取/编辑，决定要操作哪些
2. **Dream** — 快速了解整个记忆语料库的结构，决定要读取/编辑/删除哪些文件
3. **语料库签名** — 基于 manifest（path + mtimeMs）计算签名，判断是否需要触发 Dream

**与 index.md 的区别：**
- `index.md` 是给 Worker 看的"通讯录"（每次对话都注入）
- Manifest 是给 Formation/Dream 看的"文件列表"（只在维护时注入）
- `index.md` 由 Formation/Dream 手动维护，manifest 由系统自动扫描生成

### 观察日志

场景中发生的一切的原始只追加记录：

```
[2024-01-15T09:23:11Z] telegram:user_123 Alice: 你在吗？
[2024-01-15T09:23:45Z] telegram:user_456 Bob: 她说下周要出差
```

每条入站消息都会被记录，无论 agent 是否回复。这让 agent 对它旁观但未参与的对话也有感知。

### Formation（局部记忆更新）

触发条件（满足其一）：
- 观察积压 ≥ 50 行，或
- 最旧的观察已超过 30 分钟

**注入的上下文：**
- 本轮用户发的消息原文
- agent 实际回复的内容
- 该场景的完整观察日志（`observations/{sceneRef}.log`）
- **Memory files manifest** — 所有 `memory/people/*.md` 和 `memory/scenes/*.md` 的清单（路径、标题、描述、修改时间）
- 现有 `index.md` 和场景记忆文件（通过工具主动读取）

**不会看到：** 完整会话历史、其他场景的观察、`SOUL.md`。Formation 是场景局部的。

**操作的文件：**
- `index.md` — 更新本场景相关的人物/场景条目，保持路径可寻址
- `memory/people/*.md` — 编辑已有人物文件，或创建新文件
- `memory/scenes/{sceneRef}.md` — 编辑本场景记忆文件，或创建（如不存在）

**不能做：** 删除任何文件。

**提交方式：** 调用 `persona_finalize(consumeObservationLines: N)`，从观察日志头部移除已处理的 N 行。

**算法：**
1. 读取场景观察日志
2. 将人格目录克隆到临时目录
3. 启动维护 agent 会话，提供 read/edit/write 工具（无 delete）
4. 注入上下文（包括 manifest）和操作指令
5. Agent 更新 `index.md` 和相关 `memory/people/*.md` / `memory/scenes/*.md`
6. Agent 调用 `persona_finalize(consumeObservationLines: N)` 提交
7. 将临时目录同步回实时人格目录
8. 从观察日志中移除前 N 行
9. 审计日志：`formation_applied`

**重试逻辑：** 每个观察签名最多重试 3 次。3 次失败后丢弃观察，审计为 `formation_discarded`。

**非阻塞：** Formation 在本轮对话完成后异步运行，用户不需要等待。

### Dream（全局记忆整合）

触发条件：记忆语料库已变更（基于文件路径和 mtime 的签名），且距上次完成超过 6 小时。

**注入的上下文（语料库快照）：**
- `index.md` 完整内容
- **Memory files manifest** — 所有 `memory/people/*.md` 和 `memory/scenes/*.md` 的清单（路径、标题、描述、修改时间），按修改时间降序排列
- 所有 `memory/people/*.md` 文件（每个取前 220 token 摘录）
- 所有 `memory/scenes/*.md` 文件（每个取前 220 token 摘录）
- 所有 `observations/*.log` 文件（每个取尾部 180 token 摘录）
- 各类文件的数量统计

**操作的文件：**
- `index.md` — 全局重建，确保所有条目路径可寻址、跨场景一致
- `memory/people/*.md` — 编辑：跨场景合并同一人的认知、压缩过时内容、修正 frontmatter
- `memory/scenes/*.md` — 编辑：压缩低价值内容
- 新建 `memory/people/*.md` — 当某人在多个场景被反复提及但尚无独立文件时创建
- 删除低价值的 `memory/people/*.md` 或 `memory/scenes/*.md` — Dream 独有权限，但必须先更新 `index.md` 保持引用一致

**不会碰：** `observations/`（只读参考）、`control/`、`SOUL.md`、`MEMORY.md`。

**提交方式：** 调用 `persona_finalize(consumeObservationLines: 0)`，不消费任何观察行。

**算法：**
1. 构建语料库快照：扫描生成 manifest + 读取索引 + 所有人物/场景/观察文件的摘录
2. 计算语料库签名（基于 manifest 的 path + mtimeMs）
3. 将人格目录克隆到临时目录
4. 启动维护 agent 会话，提供 read/edit/write/delete 工具
5. 注入语料库快照（包括 manifest）和操作指令
6. Agent 跨场景关联人物、重建 `index.md`、压缩/删除/创建记忆文件
7. Agent 调用 `persona_finalize(consumeObservationLines: 0)` 提交
8. 将临时目录同步回实时人格目录
9. 更新 `dream.json`（完成时间、新语料库签名）
10. 审计日志：`dream_applied`

**与 Formation 的关键区别：** Dream 从不消费观察日志。它读取观察作为证据，但保持原样不动。

---

## 提示词结构

每轮 Worker 执行时注入的系统提示词：

```
[SOUL.md 内容]

[MEMORY.md 内容]

--- 工作区契约 ---
你可以访问 /workspace 下的工作区，结构如下：
- SOUL.md：你的人格和约束
- MEMORY.md：你维护的持久事实
- skills/：可调用的可复用脚本
- chats/：会话历史（只读）
- .nekoclaw-persona/：你的记忆系统

--- 会话上下文 ---
Session key: agent:{slug}:{channel}:{chatKind}:{conversationId}
聊天类型：[dm | group]
外部 ID：{platformChatId}

--- 自我身份 ---
平台用户 ID：{platformUserId}
Handle：{handle1}, {handle2}
是否被明确 @：[是 | 否]

--- 人格上下文 ---
[index.md 内容 — 最多 2,000 tokens]

--- 场景观察 ---
[本场景的近期观察 — 最多 1,200 tokens]

--- 工具使用指引 ---
- 用 `message(send)` 在当前会话回复
- 用 `send_message` 主动联系其他会话
- 用 `no_reply` 表示沉默是正确的选择
- 用 `read` 按需加载详细记忆文件
```

---

## Agent 工具

Agent 在一轮对话中可用的工具：

| 工具 | 用途 |
|------|------|
| `message(action, ...)` | 在当前会话发送/回复/编辑/删除消息，显示输入状态 |
| `send_message(target, ...)` | 主动向任意已知联系人或群组发消息 |
| `no_reply()` | 明确抑制默认回复 |
| `list_contacts(channel?)` | 列出运行时目录中的已知联系人 |
| `list_groups(channel?)` | 列出已知群组 |
| `get_group_members(groupRef)` | 获取特定群组的成员 |
| `get_contact_detail(account)` | 获取特定联系人的详情 |
| `session_status()` | 查看当前会话的能力 |
| `read(path)` | 读取记忆文件（索引、people/*、scenes/*、observations/*） |
| `bash(cmd)` | 在工作区执行 shell 命令 |
| `read_file(path)` | 读取工作区文件 |
| `write_file(path, content)` | 写入工作区文件 |
| `edit_file(path, ...)` | 编辑工作区文件 |

---

## 工作区与存储结构

```
~/.{appname}/
├── {appname}.json                   # 主配置（agents、channels、models）
├── runtime/
│   ├── agents/{agentId}.json        # 每个 agent 的运行时状态
│   ├── queues/{agentId}.jsonl       # 任务队列持久化
│   ├── audit/{agentId}.jsonl        # 审计日志
│   ├── pairs/{pairingId}.json       # 待处理的配对请求
│   ├── control/{requestId}.json     # 运行时控制指令
│   └── process.json                 # 守护进程状态
└── workspaces/
    └── {agent-slug}/
        ├── SOUL.md
        ├── MEMORY.md
        ├── skills/
        ├── .nekoclaw-persona/       # 记忆系统（见上）
        └── chats/
            └── {sessionRecordId}/
                ├── context.jsonl    # 消息历史
                ├── log.jsonl        # 事件日志
                └── attachments/
```

---

## Session Key 格式

会话通过字符串 key 唯一标识：

```
agent:{slug}:{channelType}:{chatKind}:{conversationId}
agent:{slug}:{channelType}:{chatKind}:{conversationId}:thread:{threadId}
```

示例：
```
agent:aria:telegram:dm:123456789
agent:aria:telegram:group:987654321
agent:aria:qq:group:112233445:thread:99
```

Session key 决定加载哪段消息历史，以及向哪个观察日志写入。

---

## 关键设计决策

### 记忆是 LLM 驱动的 Markdown
没有预定义 schema。Agent 自己决定记什么、怎么表达。这让记忆能捕捉情感、上下文、关系动态——而不只是事实。代价是记忆质量依赖模型质量。

### Formation 与 Dream 的分离
- **Formation** 局部且快速：一轮对话后更新单个场景的记忆
- **Dream** 全局且周期性：跨场景关联、重建索引、裁剪过时内容

这模拟了人类记忆的工作方式：经历后立即巩固，加上休息时的周期性深度整合。

### 观察作为证据层
原始观察不会被 Formation 或 Dream 修改——被消费（Formation）或只读（Dream）。这保留了"实际发生了什么"的事实基础，与 agent 对它的解读相分离。

### 无状态 Worker
Worker 通过 `WorkerPayload` 接收所需的一切，通过 `WorkerResult` 返回所做的一切。执行期间无共享状态、无副作用。这让 Worker 易于隔离、测试和替换。

### 沉默是一等公民操作
`no_reply` 是一个显式工具，而不是"没有操作"。Agent 主动决定保持沉默。这在群组场景中很重要——对每条消息都回复是不自然的。

---

## 将这套架构迁移到新场景

### 必须实现
1. **Channel Plugin** — 将你的平台事件模型适配到 `InboundMessageEvent` 和 `ChannelToolAction`
2. **Session Key 策略** — 定义对话如何映射到唯一会话标识符
3. **存储后端** — 参考实现使用文件系统；替换为你偏好的存储
4. **Worker 执行环境** — 参考实现使用 Docker；任何隔离执行上下文均可

### 可选（但高价值）
5. **人格记忆** — Formation + Dream 可以直接接入；只需要一个工作区目录
6. **任务队列** — 按 agent 串行化的逻辑可复用；替换持久化层即可
7. **Session Hygiene** — Token 预算逻辑与模型无关；根据你的上下文窗口调整常量

### 保持不变
- `WorkerPayload` / `WorkerResult` 契约 — 这是编排与执行之间的清晰边界
- 观察日志格式 — 简单的只追加文本，易于生产和消费
- Formation/Dream 触发条件 — 这些是经验调优的值，谨慎修改

---

## 关键常量（参考值）

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_QUEUE_DEPTH` | 50 | 每个 agent 触发背压前的最大任务数 |
| `INDEX_TOKEN_BUDGET` | 2,000 | 提示词中人格索引的 token 上限 |
| `SCENE_OBSERVATION_MAX_LINES` | 80 | 注入的最大观察行数 |
| `SCENE_OBSERVATION_TOKEN_BUDGET` | 1,200 | 观察上下文大小 |
| `FORMATION_MIN_OBSERVATION_LINES` | 50 | 触发条件：行数阈值 |
| `FORMATION_MAX_WAIT_MS` | 30 分钟 | 触发条件：最旧观察的等待时间 |
| `FORMATION_MAX_RETRIES` | 3 | 丢弃观察前的最大重试次数 |
| `DREAM_INTERVAL_MS` | 6 小时 | 两次 Dream 之间的最短间隔 |
| `MAINTENANCE_TIMEOUT_MS` | 120 秒 | Formation/Dream 超时时间 |
| `SESSION_RESERVE_TOKENS` | 20,000 | 始终为模型输出保留的 token |
| `SESSION_KEEP_RECENT_TOKENS` | 20,000 | 近期消息历史预算 |
| `SOFT_TRIM_THRESHOLD_CHARS` | 8,000 | 工具结果软裁剪阈值 |
| `HARD_CLEAR_BUDGET_CHARS` | 12,000 | 工具结果总量硬清除阈值 |
| `MANIFEST_SCAN_MAX_FILES` | 200 | Memory manifest 最多扫描的文件数 |
