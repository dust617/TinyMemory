# TinyMemory v0.15.0

TinyMemory 是一个面向 AI 编码代理的轻量、跨会话、默认去敏的记忆守卫。它以 pi-coding-agent 扩展形式运行，并提供有界存储、渐进式召回、秘密过滤、校验和任务归档工具。

## 设计目标

- **跨 session 连续**：会话中断、模型切换或 compaction 后仍可恢复项目状态。
- **严格作用域**：项目事实默认隔离；全局偏好和跨项目关联使用独立、显式的数据层。
- **容量有界**：活动层设硬上限，超限时失败关闭，不创建无限增长的“自动记忆”。
- **默认去敏**：保存、召回、注入和校验均扫描秘密模式；命中时拒绝写入或停止输出。
- **可审计**：事实带 `Source`、`Verified`、`TTL`、`Replaces` 元数据，候选进入 INBOX 后再人工确认。

## v0.15 新增

- **L2/L3 项目画像**：`memory-profile` 管理稳定拓扑、关键路径和约定；Brief 优先注入画像，再按需下钻事实。
- **三层作用域**：项目 STATUS/FACTS 严格隔离；用户确认的协作偏好可全局使用；项目关联只保存带 TTL 的最小摘要。
- **混合召回**：`memory-recall` 支持 FTS5、标签和关键词融合排序，并用 `maxChars` 控制输出预算。
- **聚焦输出**：带 query/tags 的 recall 不重复 STATUS，过期提醒只针对本次命中事实；召回保持只读，不刷新 Verified/TTL。
- **多会话安全**：异步状态按 `sessionId + projectKey` 双键隔离，并在工具与事件入口复核 cwd。
- **注入降噪**：无标签 Brief 不再注入任意最新事实；handoff 不重复 STATUS/FACTS；同一 session 自动去重。
- **委托兼容**：全局扩展与项目级扩展可按明确来源安全委托，避免重复注册或错误关闭。

## 工具

| 工具 | 作用 |
|---|---|
| `memory-status` | 更新当前项目的短期状态与最多 6 个下一步 |
| `memory-profile` | 更新稳定项目画像 |
| `memory-recall` | 按 tags/query 召回项目事实 |
| `memory-save` | 保存已验证事实、决策、约束或失败模式 |
| `memory-review` | 查看低噪声候选观察 |
| `memory-distill` | 从近期会话提取候选，写入 INBOX 而非直接成为事实 |
| `memory-preference-*` | 管理经用户确认的全局协作偏好 |
| `memory-link-*` | 管理经用户确认的最小跨项目关联摘要 |

## 数据层

### 项目层

| 文件 | 作用 | 默认硬限制 |
|---|---|---:|
| `.pi/memory/STATUS.md` | 当前状态与下一步 | 2 KiB / 32 行 |
| `.pi/memory/PROJECT.md` | 稳定项目画像 | 4 KiB / 48 行 |
| `.pi/memory/FACTS.md` | 稳定事实、决策、约束、失败模式 | 64 KiB / 800 行 |
| `.pi/memory/INBOX.jsonl` | 审计观察和蒸馏候选 | 100 条 |
| `.pi/memory/DISTILL_STATE.json` | 增量蒸馏位置 | 约 1 KiB |

### 全局层

- **偏好**仅允许语言、输出风格、工作流和审批习惯，且必须由用户确认。
- **项目关联**仅保存不超过 360 字、带 TTL 的最小摘要；不会复制另一项目的 STATUS 或 FACTS。
- 未配置项目级存储时，全局扩展会按规范化项目根路径哈希隔离数据。

## 安装

要求 Node.js 22.5+，运行时依赖由 pi-coding-agent 宿主提供。

### 全局扩展

```bash
mkdir -p ~/.pi/agent/extensions/memory-guard
cp index.ts contract.ts ~/.pi/agent/extensions/memory-guard/
```

### 项目级扩展

```bash
mkdir -p .pi/extensions/memory-guard
cp index.ts contract.ts .pi/extensions/memory-guard/
```

修改扩展后执行 `/reload` 或开启新 session。

## 校验与测试

```bash
npm install --include=dev
npm test
npm run memory:check
npm run memory:archive -- <slug>
```

- `npm test` 覆盖注入、召回、作用域隔离、保存拒绝、并发写入、蒸馏、FTS、委托和契约同步。
- `memory:check` 校验容量、TTL、Fact ID/Replaces、秘密模式、临时文件和归档上限。
- `memory:archive` 执行“校验 → 原子归档 → SHA-256 manifest → 重置当前任务文件”。

## 隐私与发布边界

不要提交以下运行数据：

- `.pi/memory/`
- `archive/`
- `session-exports/`
- session/chat transcript（例如 `*.jsonl`）
- `.env*`、Cookie、Token、私钥、认证 URL 或配对码

仓库只应包含通用源码、测试夹具和文档。测试中出现的 `example.com`、固定 UUID 或假 Token 仅用于验证秘密过滤器，不代表真实凭据。

## 秘密过滤

`contract.ts` 与 `scripts/memory-contract.mjs` 使用同步契约，覆盖私钥、常见 API Token、VLESS URL、凭据 UUID、六位配对码、Authorization/Bearer/Cookie 头、凭据赋值和 URL 内嵌凭据。测试包含契约同步闸门，避免扩展侧与 CLI 侧规则漂移。

## 许可证

MIT
