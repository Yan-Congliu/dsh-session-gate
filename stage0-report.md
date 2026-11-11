# 阶段0 可行性验证报告

- 日期：2026-11-10
- 环境：DSH 0.2.2-rc.1 桌面版，profile `desktop`，DeepSeek API 会话（未用本地 4b 开发）
- 结论：**可行**。「按会话隐藏工具、从源头省上下文」这条路跑通了。原计划的机制（监听 `system-prompt/assemble` 瀑布）被官方文档明确列为反模式，已换成 `tools.restrict()`；其余方案不变。

## 1 做了什么

临时插件 `@local/dsh-gate-probe`（目录 `dsh-session-gate\stage0-probe\`，验证完已删除）：

1. 监听 Host 事件 `agent/created`（新建、恢复、clear、compact 都会触发）；
2. 对新会话的 `agent.ctx` 调用 `tools.restrict({ deny: ['web_search'] })`；
3. 记录调用前后该会话的**可见工具数**与**工具 schema 字节数**到 `probe.log`；
4. 用一个子代理做 A/B：装插件时问它有没有 `web_search`，删插件后再问一次。

## 2 证据

`dsh-session-gate\probe.log`（原文，删掉时间戳外层）：

```json
{"event":"agent/created","agentId":"ea3b7da9-…","source":"startup","deny":["web_search"],
 "restricted":true,
 "before":{"visible":151,"known":151,"restrictable":151,"schemas":151,"schemaBytes":139616,"deniedPresent":["web_search"]},
 "after":{"visible":150,"known":151,"restrictable":151,"schemas":150,"schemaBytes":139292,"deniedPresent":[]},
 "savedSchemaBytes":324}
```

子代理自述（同一提示词，插件装/删各问一次）：

| 状态 | 回答 |
|---|---|
| 插件生效时 | `web_search: 无`（工具清单里也确实没有它） |
| 插件移除后 | `web_search: 有` |

→ 按会话隐藏生效、执行/查找/展示三处一致（框架保证），且移除插件后干净恢复。

## 3 关键数字

| 量 | 数值 |
|---|---|
| 单个会话可见工具 | 151 个 |
| 工具 schema 总字节 | 139,616 B |
| 换算 token（按旧实测 34.6K/152 工具 = 4.04 B/token） | ≈ 34.9K token |
| `web_search` 单个 schema | 324 B ≈ 81 token |
| **平均每个工具** | **≈ 925 B ≈ 229 token** |

推论：如果把工具砍到 ~30 个，可省 ≈ 121 × 925 B ≈ 112 KB ≈ **27–28K token**。
按之前实测的首轮 46.8K / 65.5K（71.5%）算，能降到 ≈ 19K（29%）——正好满足「本地模式首轮 < 15K–20K」的目标区间上限。

## 4 机制说明（对原方案的修正）

- 原方案：监听 `system-prompt/assemble` 瀑布，直接删 schema 和提示词段。
- 实际要求：`cordis-plugin-development` 的 practices 明确写「**不要监听 `system-prompt/assemble` 增删工具或文本**」；官方推荐的减工具方式就是 `ctx.tools.restrict()`，拒调用用 `ctx.tools.guard()`。
- `restrict` 的优点：按 agent 作用域生效（天然每会话独立）；schema、查找、执行三处自动对齐；返回 disposer，可随时撤销；只在当前会话生效，不影响别的会话。
- `restrict` 的限制：
  1. 只能裁**全局注册**的工具，会话内注册（scope-local）的工具裁不到；
  2. 只裁工具，**裁不了别的插件注册的提示词段**（系统提示 ~5.1K、技能注入 ~697 字节所需 token）——这部分只能靠 `local` 预设少挂插件来解决；
  3. 每个 agent 要单独 restrict 一次（`agent/created` 已覆盖新建与恢复）。

## 5 副作用

- 安装 bundle 时 pnpm 解析锁文件，把 `billion-context` 从 0.1.212 顺带升到 0.1.213（计划外）。功能正常，但若后续压缩行为异常，先怀疑这次升级。
- 插件已移除：`Config.listConfigs(name='@local/dsh-gate-probe')` 返回 `entries: []`，profile 恢复原状。
- 验证用的 `probe.log` 保留在 `dsh-session-gate\` 下作证据；probe 源码留在 `stage0-probe\` 供阶段1复用。

## 6 对阶段1的影响

- MVP 核心链路成立：`agent/created` → 读组配置 → 逐组 `restrict`；人锁定只需在调用 restrict 前过滤掉 🔒 组。
- 需要新增：组配置表（含「占用上下文 / 不占用」标记）、人锁定层、`gate_status` / `gate_switch` 工具、策略持久化（不能依赖 agent 内存，靠每次 created 重建）。
- 面板的 token 估算可以直接用本次方法：`JSON.stringify(tools.schemas(agent)).length`，按 4 B/token 换算。

## 7 建议

- 阶段1 先做「组配置 + restrict + 人锁定 + 两个工具」，不做 UI，用一次真实本地 4b 会话验收。
- 组表初稿：`sw_*`（23）、`office_*`（8）、`task_board_*`（9）、`ego_*`（~54，最大块）、`dsh_*` / 其它；每组标 token 估算与「占/不占上下文」。
