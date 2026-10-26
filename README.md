# dsh-native-retract · DSH 对话内撤回

在 DSH 用户消息气泡下方的原生操作行增加「撤回」，放在「复制」旁边。撤回与原始用户消息处于同一 Session，不创建分支；原事件日志保留，surface replace 将目标消息及后续内容从模型上下文中移出，原文回填输入框。

## 参考实现与 DSH 适配

交互参考 [OpenChamber 的 `revertToMessage`](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/sync/session-actions.ts)：先识别目标用户消息、停止活动、记录撤回边界并恢复输入。OpenChamber 使用自己的 `session.revert` marker、Revert Dock 和 commit/clear 两阶段流程；DSH 当前的 Session API 没有这些接口。本插件遵循 DSH 已发布的事件约束，以现有 `user/message` `surfaceOp: replace` 写入 durable checkpoint，不添加私有 Session 事件，也不删除日志。

用户正文、附件、图片和引用由 DSH 原生 `conversation.chat.user.content` Factory 渲染；插件只接管 `user` / `steering` 两个 keyed Slot 的操作行。Conversation assembler 适配器根据 checkpoint 的 `sourceEventSeqs` 隐藏被替换区间，覆盖实时 append、完整窗口重放和旧页 prepend。适配器已对 DSH 0.2.1-rc.2 当前安装包和官方 0.2.1-rc.3 npm 包做 dry-run 锚点检查；未识别的新 fork 会在写文件前停止。

## 安装与 v1 迁移

本仓库是当前 profile 可链接的插件目录。已链接此目录的用户在同步更新后重启 DSH Desktop 即可。

首次从 v1 迁移，先完全退出 DSH，并检查将修改的唯一产物：

```bash
node scripts/migrate-legacy.cjs --dry-run
node scripts/migrate-legacy.cjs
```

迁移脚本只逆向移除已识别的旧撤回注入，保留其他本地代码并先备份完整文件。然后运行新版 Conversation adapter：

```bash
node scripts/patch-native.cjs --dry-run
node scripts/patch-native.cjs
```

完成后启动 DSH。Windows 上在 PowerShell 执行同一命令，通常需要先退出 Desktop；仅当写入受系统目录保护时使用管理员终端。

## 撤回流程

1. 校验目标仍是当前 Session 的 `source.kind === 'user'` append-surface 消息。
2. 调用 DSH 用户取消路径并等待 Agent 到达 idle；取消会清除待发送队列。
3. 在 `runMaintenance()` 内用 replacement checkpoint 替换从目标到当前 surface 末尾的事件，并立即 `flush()`。
4. Client 保存撤回前的草稿版本；撤回期间若用户修改草稿则保留新输入，并尝试把原文复制到剪贴板；否则回填并持久化原文。
5. Conversation 重放时隐藏 checkpoint 的 `sourceEventSeqs` 区间。Trajectory 和 session event log 仍保留原始记录。

## 运行时适配器

DSH 当前没有插件级历史过滤 seam，因此 `scripts/patch-native.cjs` 只为 `dsh-client-ui-conversation/lib/client.js` 注入一个 transcript adapter；不改 Chat 消息组件和 renderer。它在完整窗口重放、旧页 prepend 和新 checkpoint append 三条路径使用同一规则。`sourceEventSeqs` 是原生 replacement 的权威范围，checkpoint 自身保留在 Session 日志，但不产生气泡。

- `--dry-run` 先检查所有锚点，不写文件；
- 备份保留原字节、DSH 版本和 SHA-256；
- 版本变化时不使用过期整份备份回滚；
- `--restore` 仅在版本和 checksum 匹配时还原；
- 新 fork 锚点不匹配时失败退出，不写文件。

```bash
node scripts/patch-native.cjs --dry-run
node scripts/patch-native.cjs
node scripts/patch-native.cjs --restore
```

自定义 DSH package 目录：

```bash
DSH_NODE_MODULES=/path/to/resources/dsh/node_modules/@deepseek-ai node scripts/patch-native.cjs --dry-run
```

## 验证

```bash
node scripts/test.mjs
node --check client.js
node --check index.js
node scripts/patch-native.cjs --dry-run
```

`test.mjs` 用真实 DSH Session 验证日志保留、模型上下文、精确 source-event 范围、原文回填值、取消顺序、重复撤回、非法消息拒绝、native Slot/Factory、hidden Conversation Definition 和命令调用结果。Adapter dry-run 已覆盖本机 rc.2 产物和从官方 rc.3 npm tarball 解包的 Client bundles。

## 已知边界

- 只回填消息文本；文件附件、图片附件与引用 chips 不自动恢复。消息内容显示仍由原生 Factory 完整负责。
- 不回滚工作区文件、shell 副作用和子代理历史。
- 没有 OpenChamber 式 staged Revert Dock / redo；这里只提供 DSH Session 支持的 surface replacement。
- DSH 升级会替换编译产物。先运行 `--dry-run`；新 fork 锚点变化时先更新 adapter。备份版本不匹配时 `--restore` 保留当前文件，不会整份覆盖新版产物。

## License

MIT © 2026 emocow-liuyun
