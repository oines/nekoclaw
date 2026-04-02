# nekoclaw 🐾

nekoclaw 是一个多 agent 聊天运行时。它把自主 AI agent 带进 Telegram、QQ 这样的真实聊天平台——不是那种"你问它答"的机器人，而是能认人、记事、有现场感、跨平台串联经历的 agent。

构建于 `@mariozechner/pi-coding-agent` 之上，每个 agent 运行在独立的 Docker 容器里，拥有自己的人格、记忆和技能。

---

## 核心特性

**多 Agent 运行时。** 一个后台 daemon 管理多个独立 agent，互不干扰。

**平台接入。** 原生支持 Telegram（grammy）和 QQ（NapCat/OneBot）。一个 agent 可以同时接入多个渠道，跨平台认人和记忆。

**人物记忆。** agent 不只是回答问题。它记得跟谁聊过、在哪些群、经历过什么事。下次聊起来不用从头解释。记忆是自由文本 Markdown，由 LLM 维护，不是死板的数据库字段。详见下方[记忆系统](#-记忆系统)。

**安全隔离。** 每个 agent 运行在独立 Docker 容器中，文件系统隔离，资源可控。

**丰富人格。** 通过 `SOUL.md` 定义 agent 的声音和性格，`MEMORY.md` 存放通用长期记忆。

**模型无关。** 支持 OpenAI、Anthropic、Google Gemini、Groq、xAI、OpenRouter、Mistral、Minimax、Kimi 等，也支持任何 OpenAI 兼容端点（vLLM、Ollama 等）。

**智能路由。** 群聊 @、显式回复、私聊 DM，可配置的触发模式。群里没人叫它的消息也会被默默旁观记录。

**高级聊天工具。** agent 可以编辑/删除自己的消息、显示正在输入、在群聊中主动选择不回复、主动给其他人或群发消息。

---

## 架构

```
  [ 用户 ] <──> [ 平台 ] <──> [ nekoclaw daemon ]
                                      │
      ┌───────────────────────────────┼───────────────────────────────┐
      │                               │                               │
[ Agent A (Docker) ]           [ Agent B (Docker) ]           [ Agent C (Docker) ]
  ├── SOUL.md                    ├── SOUL.md                    ├── SOUL.md
  ├── MEMORY.md                  ├── MEMORY.md                  ├── MEMORY.md
  ├── .nekoclaw-persona/         ├── .nekoclaw-persona/         ├── .nekoclaw-persona/
  │   ├── index.md               │   └── ...                    │   └── ...
  │   ├── memory/                │
  │   │   ├── people/*.md        │
  │   │   └── scenes/*.md        │
  │   └── observations/*.log     │
  ├── skills/                    ├── skills/
  └── chats/                     └── chats/
```

---

## 🧠 记忆系统

这是 nekoclaw 和普通聊天机器人最大的区别。

### 设计哲学

核心原则：**LLM 是理解层，代码是管道层。**

代码只管文件读写和流程编排。所有"理解"层面的事——认人、关联经历、判断什么值得记住——全交给模型。

记忆内容是 Markdown 自由文本，没有预设 schema。agent 能记住的不只是"名字"和"项目"这种硬事实，也包括"这个人压力大""每到 deadline 就焦虑""和我讨论数据库选型后来证明选错了"这类情绪、处境和共同经历。

### 记忆分层

agent 的上下文分五层，从"永远在"到"偶尔在"：

| 层 | 内容 | 生命周期 |
|---|---|---|
| 规则层 | SOUL.md — agent 的人格和行为约束 | 永远在 system prompt 里 |
| 索引层 | index.md — "我认识谁、在哪些群、每人一句话概要" | 永远在 prompt 里 |
| 记忆正文层 | people/*.md, scenes/*.md — 某个人或某个群的详细记忆 | 按需注入，模型选了才读 |
| 场景层 | observations/*.log — 当前群的近期旁观记录 | 当前消息相关时注入 |
| 会话层 | 当前 session 的对话历史 | 优先级最高 |

**索引常驻，正文按需。** index.md 永远在 prompt 里，很短（几十行）。agent 随时知道"我记了什么人、什么事"。需要细节时，由模型判断要读哪些记忆正文文件。

### 采集与整理分离

**采集阶段**：群里的消息不管有没有 @ bot 都会被记一行到 observations 日志里。不调 LLM，不做任何理解，零成本。

**整理阶段（formation）**：bot 回复发出后异步触发。LLM 从对话和旁观日志中提取值得记住的内容，和已有记忆对比，重写记忆文件和索引。不阻塞正常回复。按场景批量触发，控制成本。

### Dream：全局记忆整理

formation 是局部的——群 A 有新内容就整理群 A。Dream 是全局的——daemon 定期触发，审视所有记忆文件：

- **跨场景关联**：小王在群 A 聊创业、群 B 聊招人，dream 把两件事关联到小王的档案里
- **索引重整**：从全局审视 index.md，清理重复、过时、不一致的内容
- **全局老化**：长期不活跃的人物记忆被压缩，活跃人物不受影响
- **补漏**：发现在多个群被反复提到但还没建档的人物

Dream 和 formation 共享同一个串行队列，不会并发写文件。

### 认人与纠偏

通过自然语言认人，不需要命令。用户在 QQ 上说"我是 TG 上的小王"，formation 把这条信息写进记忆文件。下次这个 QQ 号来消息，模型从记忆里自然知道这是小王。

纠偏也是自然语言："你搞错了我不是小王"——写进记忆文件，模型下次读到就知道。同一个人大号小号也能认——只要说过"这是我小号"，agent 就记住了。

### 旁观 vs 参与

群里的讨论如果 bot 没被触发回复，它知道自己只是在旁边听到的，回忆时不会说"我们讨论了..."。

### 记忆文件示例

```markdown
小王，最早在 TG 上认识的（tg:111），后来他自己说 QQ 号是 qq:222。

在做一个 GPU 租赁平台的创业项目，经常找我聊技术问题。

毕业论文一直在写，但导师总是临时改方向，让他压力很大。
每到 deadline 他就焦虑想摸鱼，是他自己说的。

我们在技术吹水群里一起讨论过数据库选型，当时选了 X，
后来他在群里说选错了要换。那次讨论是我参与的，
但他后来抱怨选错了的时候我只是旁观到的。

他同事李四后来也来找过我（tg:333），是小王介绍的。
tg:333 不是小王，是李四。
```

---

## 🔧 Agent 工具

**感知工具**（只读）：
- `list_contacts` / `list_groups` — 我认识谁、我在哪些群
- `get_group_members` / `get_contact_detail` — 群成员、某人详情
- `session_status` — 当前会话状态

**行动工具**：
- `message` — 在当前对话内回复、编辑、删除消息
- `send_message` — 主动给其他人/群发消息（跨渠道）
- `no_reply` — 显式选择不回复（仅群聊未被 @ 时出现）

另外还有 4 个底层编码工具（read / bash / edit / write）用于技能执行。

---

## 🚀 快速开始

### 前置条件

- Node.js >= 20.6.0
- Docker（已安装并运行）
- Git

### 一键安装

macOS 或 Linux（x64 / arm64）：

```bash
./install.sh
```

交互式安装会引导你：检查依赖 → 安装构建 → 创建 agent → 启动 daemon。

用参数跳过交互：

```bash
./install.sh --name cat-agent --source builtin --provider anthropic --model claude-sonnet-4-20250514 --api-key <key> --token <telegram-bot-token>
```

---

## 🧩 核心概念

### Agent

独立的 AI 实体，工作空间在 `~/.nekoclaw/workspaces/<slug>/`：

- `SOUL.md` — 人格、语气、行为约束
- `MEMORY.md` — agent 自身的通用长期记忆
- `.nekoclaw-persona/` — 人物记忆系统
- `skills/` — 可扩展的技能模块
- `chats/` — session 数据和消息历史

### Channel（渠道）

- **Telegram** — Bot Token，支持私聊和群聊
- **NapCat** — NapCat/OneBot11 WebSocket，接入 QQ

同类型渠道最多一个，但可以同时接 Telegram + QQ。

### Daemon

后台运行，管理：连接保持、消息路由、任务队列、Docker 容器、消息发送、formation 和 dream 调度。

---

## 🛠️ CLI

### Daemon

```bash
nekoclaw start / stop / restart / status
```

### Agent 管理

```bash
nekoclaw agent create <name>
nekoclaw agent list
nekoclaw agent enable / disable <agent>
nekoclaw agent remove <agent>
nekoclaw doctor [agent]
```

### 配置

```bash
nekoclaw model set / list / current <agent>
nekoclaw channel add / remove / list / token <agent>
nekoclaw admin add / remove / list <agent>
nekoclaw session list / remove <agent>
```

### 配对

```bash
nekoclaw pair list
nekoclaw pair accept --code <code>
```

---

## 开发

```bash
git clone https://github.com/oines/nekoclaw.git
cd nekoclaw
npm install
npm run build
npm test
```

---

## 许可

MIT License. 详见 [LICENSE](LICENSE)。
