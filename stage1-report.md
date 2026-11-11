# dsh-session-gate 阶段1 MVP 报告（2026-11-10）

## 一句话

插件 `@local/dsh-session-gate` 已装进 desktop profile 并在真实会话里验证通过：**每个会话可以单独关掉用不上的工具组，关掉后那些工具的"说明书"不再进系统提示，省下对应 token；人和 agent 都能开关，人的锁优先级最高，状态按会话落盘。**

## 装机形态

- 包名 `@local/dsh-session-gate` 0.1.0，Host-only bundle，源码 `dsh-session-gate\host\`
- Loader row id：`session-gate`（`plugin_manager set_plugin` 必须用 `include:session-gate`，用包名会报 `unknown-plugin`）
- 状态目录：`$DSH_HOME/session-gate/`（Windows 上通常是 `C:\Users\<你>\.dsh\session-gate\`；`groups.json` / `sessions.json` / `locks.json`）
- 日志：`dsh-session-gate\gate.log`
- 卸载：`plugin_manager action=remove_bundle target=@local/dsh-session-gate`；临时停用：`set_plugin target=include:session-gate enabled=false`

## 模型看到的两个工具

- `gate_status`：只读，列出 15 个组的名称、用途、当前开关、是否被人锁、工具数、字节数、token 估算。
- `gate_switch`：`{"groups":{"ego":false,"web":true}}` 或 `{"all":true|false}`；按会话生效；被锁的组返回 `refused` + 原因；成功时给 `changed` 和"prompt 缓存作废"提醒。

## 三层权限（高的压低的）

1. 🔒 **人锁** `locks.json`：`{"groups":{"ego":"off"}}` / `"on"`。插件永远不会写这个文件；agent 想改被拒，返回 `locked by the person to "off"`。
2. 👤 **人本会话点过的开关** `sessions.json`：`gate_switch` 写，按 session id 存，重启/恢复会话自动重放。
3. ⚙️ **组默认** `groups.json` 里的 `defaultOn`（当前默认全开；`gate` 组自身不可切）。

## 分组（15 组 + other）

按工具名前缀/精确名匹配，先精确后最长前缀，未匹配归 `other`（只报告不切换）。

| 组 | 工具数 | 字节 | ≈token |
|---|---|---|---|
| ego 浏览器自动化 | 37 | 26,032 | 6,508 |
| solidworks | 23 | 24,593 | 6,148 |
| board 任务看板 | 8 | 17,357 | 4,339 |
| misc 杂项 | 21 | 15,804 | 3,951 |
| context 上下文压缩 | 10 | 9,275 | 2,319 |
| files 文件与命令 | 9 | 8,771 | 2,193 |
| office 办公文档 | 8 | 8,268 | 2,067 |
| channels 外部渠道 | 7 | 7,280 | 1,820 |
| delegate 派活 | 4 | 6,770 | 1,693 |
| team 协作团队 | 9 | 4,799 | 1,200 |
| schedule 定时任务 | 4 | 4,719 | 1,180 |
| history 历史检索 | 5 | 3,976 | 994 |
| memory 长期记忆 | 7 | 2,729 | 682 |
| gate 闸门自身 | 2 | 1,067 | 267 |

同一会话实测：全量 **143,628 B ≈ 35,907 token**；关 ego+office+solidworks+board 可省 ≈ 76 KB ≈ 19K token。

## 实测证据（2026-11-10 21:33，本会话 `session-b8a28ac2-…`）

| 操作 | visibleBytes | savedBytes | 说明 |
|---|---|---|---|
| 全开 | 143,628 | 0 | 151 个工具卡 |
| 关 web | 143,063 | 565 | 精确等于 web 组字节 |
| 关 office（web 仍关） | 134,795 | 8,833 | 565+8,268，精确 |
| 只开 office（web 仍关） | 143,063 | 565 | **回归用例：不再把 web 一起放出来** |
| 锁 web=on 后要求关 web | 143,628 | 0 | `refused: locked by the person to "on"` |
| 锁 ego=off 后要求开 ego | 117,596 | 26,032 | `refused: locked by the person to "off"` |
| `all:true` 复原 | 143,628 | 0 | 限制被撤销 |

跨会话：另开子代理会话 → `savedBytes 0`、web/ego 都 `on`、工具清单里有 `web_search`/`ego_click`，**没被本会话的 web=off 影响**。

## 期间修掉的三个真 bug

1. **JsonSchemaError**：output.schema 里属性级写 `required: true` 不支持 → 删掉，对象级不需要它。
2. **旧方案把"隐藏后可见集"当目录**：关 A 再关 B 时 A 的工具名从可见集消失，重算 deny 会丢掉 A → 第二次"只开 B"把 A 也放出来。
3. **`tools.schemas()` 在 agent 上下文里也是受限视图**（本以为无参调用是全局视图）：restore 时目录缺被藏组，saved 归零。最终改为**尺寸缓存**：首次可见时记下每个工具的 JSON 字节数，用 `view(agent).restrictableNames`（限制前名字集）重建完整目录，隐藏工具沿用缓存尺寸。

## 已知边界

- 只裁**工具说明书**；系统提示里别人注册的段落（约 5.1K）裁不掉 —— 那要靠 `local` 预设少挂插件。
- 只裁全局注册工具；agent 自己作用域里注册的裁不到（exempt，正确行为）。
- 关组后该工具不可调用（`office_help` 实测返回 `unknown tool`），这是有意的硬闸门。
- 切换 = 请求前缀变化 = prompt 缓存失效，所以默认"会话开头定、阶段边界再切"。
- 工具尺寸缓存按进程生命周期；Host 重启后第一次 status 会重新测量（此时若已有隐藏组，被藏组的 saved 会暂时显示 0，再切一次即恢复）。

## 没做的（阶段2+）

- 右侧栏可视化面板（名称 + 一句话功能 + token + 开关 + 配方）
- `local` 本地模式预设（新会话一键最小集，连系统提示段一起瘦）
- 配方（只聊天 / 写文档 / 查资料 / 改代码 / 跑课设）
- agent 自主切换的次数限制与提示（当前靠工具描述里"阶段边界再切"的说明）
