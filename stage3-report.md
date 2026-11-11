# 阶段3：联调、重启恢复、文档补图

日期：2026-11-10 22:20 左右 ｜ 插件版本 0.2.0 ｜ 环境 DSH 0.2.2-rc.1 desktop profile

## 一、和 billion-context 联调（通过）

### 分工
- **闸门（本插件）管「前缀」**：按会话裁掉工具栏 schema 与执行入口。省的是**每轮都要重发的工具说明书**。
- **billion-context 管「历史」**：压缩已经发生过的消息与工具结果，折叠成摘要块。
- 两者没有共享状态、没有先后依赖：闸门改的是请求最前面的工具清单，billion-context 改的是中间/后面的对话内容。

### 证据（同一会话同时开着两个插件）
- 本会话（`session-b8a28ac2`）`gate_status`：visible 143,821 B ≈ 35,955 token；此前实测过关 office/web 精确省 565 / 8,833 B，开关正常。
- 同会话 `acp_status`：18 个压缩块，原始 469.1K token → 摘要 13.0K token；当前请求里工具 42.4K（48%）、正文 33.3K（38%）、摘要 13.0K（15%）。
- 也就是说：**压缩把历史从 469K 压到 13K 的同时，闸门照常能开关工具**，互不干扰。

### 组合使用的注意
- 改工具集会让 **prompt 缓存作废**（前缀变了）；billion-context 的压缩改写的是历史，两者都会让下一次请求变贵，所以别在同一轮里既切工具又猛压缩。
- 切工具建议在「阶段边界」（比如从聊天切到跑课设）做；压缩交给 billion-context 自己的阈值策略。
- 顺序上不用刻意排：先切工具再让压缩触发，或反过来都行。

## 二、重启恢复

### 已做的验证：跨进程（模块重载）模拟
`tests/recovery.mjs`：
1. 准备临时状态目录，`sessions.json` 里给 `session-r` 存 `{ego:false, web:false}`，`locks.json` 里给 `office` 存 `"on"`；`session-clean` 不存任何覆盖。
2. 第一次加载 `host/index.js?boot=1`，注册工具后**丢弃整个模块实例**（等价于 Host 重启）。
3. 重新加载 `host/index.js?boot=2`，只靠磁盘上的三个 JSON 恢复；派发 `agent/created {source:'resume'}`。
4. 断言：
   - `session-r` 恢复后 ego / web 工具不可见（存量覆盖重新生效）
   - office 因为人工锁 `"on"` 可见
   - `restrict` 收到的 deny 名单从磁盘重建正确
   - `session-clean` 不受 `session-r` 的覆盖影响
   - 状态文件在重载后仍然可读

结果：**11 项断言全过**（`node tests/recovery.mjs`）。

### 真机重启的最后一步（被动验证）
下次 DSH 启动后，`dsh-session-gate\gate.log` 会出现形如：

```
agent/created session=session-... source=resume visible=...B saved=...B denied=N
```

看到 `source=resume`（或 `startup`）且 `saved` 非 0，就说明真实重启也恢复了。这一步不需要主动杀进程，等下次正常开机即可。

## 三、文档补图

- `docs/panel-2026-11-10.png` —— 面板实拍（15 组、配方、锁、开关、底部提示）
- `docs/local-mode-4b-2026-11-10.jpg` —— 本地模式 + 4b 的实际会话（工具说明 ≈2.7K token，首轮 13.5K/32K ≈ 42%）
- README 已插入这两张图并按相对路径引用。

## 四、遗留与边界

- **只裁工具 schema**：系统提示段（人设、记忆注入等 ~5.1K）裁不了；要更省只能用 `local` 预设少挂插件。
- **只裁全局注册的工具**：scope-local 注册的工具不在 `restrictableNames` 里。
- 切换即作废 prompt 缓存：面板和 `gate_switch` 都返回 `note` 提醒。
- 重启后第一次 `gate_status` 的 `savedBytes` 可能暂时是 0（尺寸缓存还没测到被藏的工具），下一次刷新就正常。
- 休眠（未运行）的会话不能在面板里操作；agent 不在线时 API 返回 `{ok:false, offline:true, error:'这个会话当前不在运行…'}`。

## 五、文件

- 恢复测试：`tests/recovery.mjs`
- 阶段报告：`stage0-report.md` / `stage1-report.md` / `stage2-report.md` / `stage3-report.md`
- 截图：`docs/panel-2026-11-10.png`、`docs/local-mode-4b-2026-11-10.jpg`
- 台账：`..\PROGRESS.md`
