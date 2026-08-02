# TinyMemory v0.14

轻量、防泄密、跨会话的记忆守卫（memory guard）系统，为 AI 编码代理（pi-coding-agent 扩展生态）提供有界、可审计、可校验的项目记忆。

## 设计目标

- **跨 session 连续**：会话中断/模型切换/compaction 后仍能恢复项目状态。
- **容量有界**：活动层永远小（STATUS/FACTS 有硬上限），超限失败关闭并要求归档，不做"无限自动记忆"。
- **无秘密值**：记忆层只存符号引用与"待轮换"状态；写入/读取/校验三层扫描秘密模式，命中即拒绝或停止输出。
- **可审计**：FACTS 条目带 Source / Verified / TTL / Replaces，校验器检查全部约束。

## v0.14 新增（借鉴 OptMem）

- **增量蒸馏**：`memory-distill` 只提炼自上次以来的新消息（`DISTILL_STATE.json` 记录消息指纹），并附"已记录候选"防止重复结论；无状态/被压缩时回退全量窗口。
- **压缩前自动蒸馏**：`session_before_compact` 自动触发一次蒸馏（失败安全，不阻塞压缩），候选仍由 `memory-review` 审核后才入库。
- **INBOX 超龄自动降级**：蒸馏候选超过 30 天未审核自动丢弃（时间维度 + 容量上限双重修剪）。
- **保存时关联推荐**：`memory-save` 写入后自动扫描 tags 重叠的活动旧事实，提示可用 `replaces` 替代；**不自动覆盖**，替代决定由 agent/用户确认。
- **Brief 时间衰减**：注入时优先展示 ≤14 天验证的事实（pinned 最前、不足补旧），`memory-recall` 保持精确召回不受影响。
- **蒸馏候选跨分钟查重**：同一结论反复提炼会被 INBOX 去重拦截。
- **UNVERIFIED 标记**：过期且未复核的事实可标记 `Status: UNVERIFIED`，校验器降级为 warning 而非阻塞（标记后仍应尽快复核）。
- **子代理硬规则**：子代理不调用主项目记忆工具，写入仅由主会话代理判断后执行。

## 核心组成

| 文件 | 作用 |
|---|---|
| `index.ts` | pi-coding-agent 扩展：自动注入有界 Brief、`memory-recall/save/review/status/distill` 等工具路由、观察事件（tool_failure / config_change / distilled）入 INBOX、压缩前自动蒸馏、保存时关联推荐 |
| `contract.ts` | 扩展侧事实契约：秘密模式、TTL 计算、风险检测（与 CLI 侧同一 schema 事实源） |
| `scripts/memory-contract.mjs` | CLI 侧契约：INBOX 分类白名单、秘密模式、边界常量（扩展与 CLI 必须保持同步，由测试断言） |
| `scripts/check-memory.mjs` | 项目记忆全量校验器（`npm run memory:check`）：字节/行上限、TTL、Fact ID/Replaces、遗留 KEYSTORE、秘密模式、归档总量、UNVERIFIED 豁免 |
| `scripts/archive-memory-task.mjs` | 完成任务归档（`npm run memory:archive -- <slug>`）：校验 → 复制到 `archive/tasks/YYYY-MM-DD-<slug>/` → SHA-256 manifest → 重置 |
| `tests/memory-guard.test.mjs` | 端到端测试（`npm test`）：注入、召回、保存、安全拒绝、并发写入、同步闸门 |

## 三层作用域

1. **项目层**：`.pi/memory/`（STATUS.md / FACTS.md / INBOX.jsonl）——严格按项目根路径隔离。
2. **全局偏好层**：仅限用户明确确认的协作偏好（语言、输出风格、工作流、确认习惯）。
3. **项目关联层**：带 TTL 的最小跨项目摘要，绝不透传其他项目事实或凭据。

## 文件布局与硬限制（使用方项目）

| 文件 | 作用 | 硬限制 |
|---|---|---:|
| `.pi/memory/STATUS.md` | 当前状态与最多 6 个下一步 | 2 KiB / 32 行 |
| `.pi/memory/FACTS.md` | 稳定事实、决策、约束、失败模式 | 64 KiB / 800 行（约 100 条） |
| `.pi/memory/INBOX.jsonl` | 观察候选（需人工 review 后入 FACTS） | audit 保留 40 条 / distilled 保留 60 条，超 30 天未审核自动降级 |
| `.pi/memory/DISTILL_STATE.json` | 蒸馏增量位置（消息指纹） | ~1 KiB，覆写 |

校验失败时禁止继续归档或删除 session；当前事实只允许一个活动版本，冲突先复验再替代。

## 安装与使用

### 作为 pi 扩展

把 `index.ts` + `contract.ts` 放入 `~/.pi/agent/extensions/memory-guard/`（全局）或 `<project>/.pi/extensions/memory-guard/`（项目级）。首次实质请求自动注入 Brief；修改后 `/reload` 或开新 session 生效。

### 校验

```bash
npm install          # 仅测试所需（jiti/typebox 等；运行时由 pi 宿主提供）
npm test             # 扩展侧端到端测试
npm run memory:check # 校验当前项目的记忆文件
npm run memory:archive -- <slug>  # 完成任务归档
```

## 秘密过滤

统一模式源（`contract.ts` 与 `scripts/memory-contract.mjs` 一致）覆盖：私钥、API token（sk-/ghp_/github_pat 等）、VLESS URL、凭据 UUID、六位配对码、authorization/bearer/cookie 头、`key=value` 凭据赋值、URL 内嵌凭据。`npm test` 的同步闸门默认断言两侧一致（可通过 `PI_MEMORY_CONTRACT=scripts/memory-contract.mjs` 显式启用）。

## 许可证

MIT
