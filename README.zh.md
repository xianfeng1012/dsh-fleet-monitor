# dsh-fleet-monitor · 机群监控

给 DSH Web GUI 加一块**多机 SSH 机群监控**面板：用你已经配置好的 SSH 凭据，把 `dsh-ssh` 与 `~/.ssh/config` 里的所有主机一次性拉进一个控制台，看在线状态、CPU、内存、磁盘、网络、进程，点开看历史曲线，也能在面板里直接添加/编辑/删除主机。

**不需要在被监控的机器上装任何 agent。** 采集器是一段 POSIX `sh`，通过已有的 SSH 连接跑一次就回来；插件只读你本机已有的凭据文件，不联网、不发遥测。

---

## 它和别的监控插件不一样在哪

| | 常见做法 | 本插件 |
|---|---|---|
| 被监控端 | 装 agent / 装 exporter | **零安装**，sshd 就是 agent |
| 主机清单 | 插件自己再维护一份 | 直接复用 `dsh-ssh.json` 与 `~/.ssh/config` |
| 凭据 | 面板里再存一遍 | 复用已有的，面板新增的主机存进本地 SQLite |
| 单机 / 多机 | 多数是"本机资源" | **多机机群**，N 台并发采集 |
| 数据 | 内存里转一圈就没了 | SQLite 落历史，默认留 24 小时 |

---

## 功能

**总览**
- 统计卡：全部 / 在线 / 告警 / 离线 / 本面板添加，点一下就按该类筛选
- 搜索、分组过滤、排序（别名 / CPU / 内存 / 磁盘 / 延迟 / 状态）
- 表格与卡片两种视图；离线行左侧标红边
- 页脚显示最后一次采集时间、一轮耗时、存储后端（sqlite / json）、问题数

**主机**
- `+ 添加服务器`：别名、地址、端口、用户、认证方式（密钥 / 口令 / ssh-agent）、私钥路径、口令、分组、标签、备注
- 保存前可以先点「测试连接」，直接告诉你 `连接成功 · 12 ms · Ubuntu 24.04`
- 编辑时口令类字段一律留空表示沿用已保存值，接口从不回传明文
- 删除走二次确认条，不用浏览器 `confirm`
- 已经导入的主机（来自 `dsh-ssh` / `~/.ssh/config`）在折叠区里只读列出，不会和面板里新增的混在一起

**明细**
- 十项身份与运行时信息：系统、内核、架构、核心数、CPU 型号、延迟、运行时长、swap、TCP/UDP 连接数、进程数
- 三张曲线：CPU %、内存 %、网络 KB/s（最近 1 小时，30 秒粒度）
- 失败原因原样展示（`Connection lost before handshake` 之类），不吞错误

**实时**
- `EventSource` 长连接推快照，断线自动重连，重连退避期用 30 秒轮询兜底，面板不会冻住

**给 agent 用的工具**
- `fleet_snapshot` — 取当前机群状态，可按 `alerting` / `offline` / `online` 过滤
- `fleet_history` — 取某台主机最近 N 分钟的历史
- `fleet_refresh` — 立刻重新采集一轮，只回计数

---

## 安装

### 方式一：手工装到现有 profile（当前推荐）

DSH 的插件是 **profile 里的一个 bundle**，所以要动三个地方。

1. 把本仓库放到任意目录，例如 `E:\plugins\dsh-fleet-monitor`。

2. 在 profile 的 `node_modules` 里建链接，让 Node 能 `import 'dsh-fleet-monitor'`：

   Windows（不需要管理员，Junction 就够）：
   ```powershell
   New-Item -ItemType Junction `
     -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-fleet-monitor" `
     -Target "E:\plugins\dsh-fleet-monitor"
   ```
   macOS / Linux：
   ```bash
   ln -s /path/to/dsh-fleet-monitor ~/.dsh/profiles/desktop/node_modules/dsh-fleet-monitor
   ```

   插件自己依赖的 `@deepseek-ai/schemastery` 与 `ssh2` 也要能从插件的真实路径解析到。如果插件不在 profile 的 `node_modules` 下面，同样给这两个包各建一条链接（或在自己的目录里 `pnpm install`）。

3. 在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 数组末尾加一行：

   ```json
   "dsh-fleet-monitor"
   ```

4. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加：

   ```yaml
   - insert:
       - id: fleet-monitor
         name: dsh-fleet-monitor
   ```

   > 本体节点必须从这一层 insert。写进插件自带的 `cordis.patch.yml` 会让同一个 id 入队两次，loader 会拒绝第二次（"already queued"）。插件自带的 patch 只用来收紧已存在的条目。

5. 完全退出 DSH 再打开。侧边栏出现「机群监控」。

### 方式二：npm

```bash
pnpm add dsh-fleet-monitor
```

装完仍要执行上面第 3、4 步（bundles 与 insert），然后重启。`npm publish` 之后这里会补上一条命令式的说明。

---

## 配置

设置页里每个字段都是 `volatile()`，改完立即生效，不用重启。

| 字段 | 默认 | 说明 |
|---|---|---|
| `intervalMs` | `30000` | 采集间隔，5 秒 ~ 1 小时 |
| `concurrency` | `6` | 同时拨号的 SSH 连接数，1 ~ 32 |
| `connectTimeoutMs` | `15000` | 连接 + 密钥交换 + 认证超时 |
| `execTimeoutMs` | `12000` | 单次采集脚本超时 |
| `dshHome` | 空 = `$DSH_HOME` 或 `~/.dsh` | 到哪读 `dsh-ssh.json` |
| `sshDir` | 空 = `~/.ssh` | 到哪读 `config` 与私钥 |
| `agentSocket` | 空 = 自动 | `SSH_AUTH_SOCK` 覆盖 |
| `includeTag` | 空 | 只采集带这个标签的主机 |
| `excludeAliases` | `[]` | 完全跳过的别名（显示为"已跳过"，不静默消失） |
| `cpuAlertPct` / `memAlertPct` / `diskAlertPct` | `85` / `90` / `90` | 告警阈值 |
| `keep` | `2880` | 每台保留多少个采样点（30 秒 × 24 小时） |
| `announceToAgent` | `true` | 往系统提示里插一段，告诉 agent 这三个工具存在 |

---

## 安全

- **只监听 loopback**。所有路由都过一道 fence：非 `127.0.0.1` / `::1` 的来源、带 `X-Forwarded-For` 或 `CF-Connecting-IP` 的请求（说明前面有代理）、`sec-fetch-site: cross-site`、跨源 `Origin` 一律 403。
- **口令不出本机**。`GET /hosts` 把口令换成 `hasPassword: true`，明文永远不跨线。
- **凭据不进口袋**。私钥、`dsh-ssh.json`、导出的 csv 全在 `.gitignore` 里；仓库里一条真实主机记录都没有。
- **不装 agent、不外联**。没有遥测，没有回连，没有云端账号。

---

## 兼容性

| DSH | 状态 |
|---|---|
| `0.2.2-rc.1` | 已实测：37 台主机、并发 6、一轮 31.9 秒；`node:sqlite` 后端 |

宿主 API 还在 rc 阶段，所以插件按 **capability 探测**适配：`inject` 里 `webServer` 是必需，`tools` 与 `systemPrompt` 缺失时少注册两个 surface，其余照常工作。

需要注意的宿主契约（踩过的坑，写在这里省下一个人两小时）：

1. `export const inject` 必须是**字符串数组**，不是 `{required, optional}` —— 写成对象会被读成"没有任何服务"，`ctx.webServer` 永远是 `undefined`，路由一条都挂不上，前端只会看到 401。
2. `apply` 必须是**同步**函数。宿主不 await 它的返回值，`async` 里抛出的错会被吞成 unhandled rejection。
3. `volatile()` 字段解析出来是 **`{ get(): T }` 引用**，不是值。直接读 `config.x` 拿到的是对象，所有 clamp 都会退化成默认值，设置页改了等于没改。
4. 同一个 `path` 只能注册一条路由，CRUD 要在 handler 内部按 `method` 分发。

---

## 开发

零构建：`lib/*.js` 就是产物，改完直接生效（重启 DSH 加载 host 半）。

```bash
node --test "test/**/*.test.mjs"   # 46 条，零外部依赖
```

覆盖：采集脚本解析与差分（含计数器回绕）、两个存储后端同一行形状、`~/.ssh/config` 解析、每条路由的 loopback fence 与 CRUD 校验、mount/卸载/waiters 重放、浏览器半的 bundle 契约。

---

## 许可证

MIT。
