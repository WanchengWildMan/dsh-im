# 需求拆解：dsh-im 接入 dsh-claude 插件引入的会话

日期：2026-10-10（北京时间）

## 1. 我理解的需求

在飞书里通过 dsh-im 使用 **dsh-claude 插件引入的 Claude 会话**：能看到它们、切过去、继续对话。

## 2. 现状调研（实测，非推测）

### 2.1 dsh-claude 的会话是什么

- 包：`@norman-else/dsh-claude` 0.1.64（本机 `~/.dsh/profiles/web/node_modules/@norman-else/dsh-claude`）。
- 官方定位（package.json description）：*Run the local Claude Code CLI as a first-class main conversation inside DeepSeek Harness* —— 把本地 Claude Code CLI 当作 DSH 里的一等公民主对话运行。
- README 3.1 节说明：它注册一个 **`Claude` Agent Preset**，会话写进 DSH 的 append-only 会话日志，属于**标准 DSH 会话**，不是外部独立存储。

### 2.2 本机会话存储实测

扫描 `~/.dsh/sessions/`（27 个工作区目录、126 个会话），逐帧解压 `session.v4.jsonl.zstd` 读 `agent-preset/selected` 事件：

- 120 个会话没有该事件（走默认 preset）；
- **4 个会话的 `agent-preset/selected` 为 `{"agentPreset":"claude"}`**，即 dsh-claude 引入的会话：

| 会话 ID | 工作区 | 标题 | 最后活动（北京时间） |
|---|---|---|---|
| session-b32ff31a-e996-4ec3-99d1-748a126a554e | `~` | 飞书文档无损结构化总结 | 2026-10-10 15:54 |
| session-c08745ed-5a4f-4a65-b66e-df2ac2522549 | `~/.dsh` | P4交接与思考溢出吞text排查 | 2026-10-10 14:36 |
| session-0a94795e-696c-410a-aaaf-4fe57e6036c2 | `mlbb-planner-text-check` | 项目需求与部署自闭环梳理 | 2026-10-10 16:06 |
| session-22cc2d78-3766-476b-a122-2b2374062982 | `mlbb-planner-text-check` | 询问当前进展情况如何 | 2026-10-09 22:55 |

### 2.3 dsh-im 怎么列会话

- 菜单的会话下拉与 `/sessionlist`（别名 `/sessions`）都走 `harness.listWorkspaceSessions(workspace)`；
- 该调用在 `plugin-src/host/channels/shared/production.mjs:156` 直接透传 DSH 的会话列表接口（`session.list`，经 Typert gateway）；
- 取回后**没有任何 preset 过滤**：只做三件事 —— 按 `includesArchivedSessions` 过滤归档会话、把当前绑定会话置顶、截前 20 条（`src/channels/feishu/bridge.mjs:3218-3230`）。

## 3. 结论

**会话数据层不需要改造：dsh-claude 的会话与 dsh-im 的会话共用同一个 DSH 会话库，列会话时不区分 agent preset，绑定后走 `session.prompt`，由 DSH 按该会话自己的 preset（claude）路由回 dsh-claude，续聊链路完整。**

**但「列得出来」还依赖工作区匹配成功**，见第 7 节的后续发现与修复：宿主注册的路径写法与机器人保存的写法不一致时，匹配失败会让列表整体为空。

## 4. 唯一的约束

会话按**工作区**列出。要在飞书里看到某个 Claude 会话，机器人当前工作区必须是它所在的那个：`~`、`~/.dsh` 或 `mlbb-planner-text-check`。

另一个现实约束：会话下拉只取前 20 条。工作区里会话很多时，较早的 Claude 会话可能不在首页，需要用 `/sessionlist --limit N` 或翻页。

## 5. 验证步骤（人在飞书里做）

1. 私聊机器人发 `/workspacelist` 拿到工作区清单，或用 `/menu` 的工作区下拉直接切到 `~/.dsh`；
2. 发 `/sessionlist`（或 `/sessions`），看列表里是否出现上表 4 条标题；
3. 从菜单的会话下拉直接选一条绑定，发一条消息确认能续聊。

## 6. 本轮未做

- 未在飞书里实测（需要人在客户端操作，自动化测不了）；
- 未验证绑定后 Claude 会话的续聊在飞书侧的实际表现（同上）；
- 未评估「跨工作区一次性列出全部 Claude 会话」这类增强 —— 现有接口按工作区取数，要做需要新增一个聚合入口。

## 7. 后续发现与修复（2026-10-15）

### 7.1 发现的缺陷

第 3 节的结论只覆盖了数据层，漏掉了**工作区匹配**这一环。`HarnessClient` 里两处把工作区路径当作普通字符串严格比较：

- `workspaceFromList()`（`src/channels/shared/harness-client.mjs`）：`item.path === workspacePath` 匹配不到时直接返回 `null`，调用方随即走成「该工作区没有会话」，表现为**每个工作区都空**；
- `workspaceId()`：同样严格比较，漏配后会走 `workspace.create`，把同一目录重复注册成一个新的工作区分组。

只要宿主注册的路径与机器人保存/传入的写法不同（尾斜杠、符号链接、未规范化），会话就列不出来、也绑不上——Claude 会话与普通会话同样受影响。

### 7.2 修复

两处统一改为「先严格相等，再按规范化后的真实路径比较」，复用既有的 `sameWorkspacePath()`（`src/channels/shared/default-workspace.mjs`：先 `resolve` 比较，再 `realpath` 比较）。`listWorkspaceSessions` 内部的未分组会话判定原本就用的是 `sameWorkspacePath`，本次只是把同一口径补齐到上述两处。

### 7.3 测试

- `test/default-workspace.test.mjs`：符号链接路径与尾斜杠路径都能列出会话；尾斜杠路径能复用既有工作区注册（不再重复创建）。
- 结论仍未在飞书客户端实测，验证步骤同第 5 节。
