# dsh-fleet-monitor · 机群监控

<p align="center">
  <a href="https://github.com/xianfeng1012/dsh-fleet-monitor/blob/main/README.md">English</a>
  &nbsp;·&nbsp;
  <b>简体中文</b>
  &nbsp;·&nbsp;
  <a href="https://github.com/xianfeng1012/dsh-fleet-monitor">源码</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/dsh-fleet-monitor">npm</a>
</p>

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

**分区**
- 面板里六个分区，用 hash 路由（`#/overview` 等），刷新后回到原来那一页：总览 / 服务器 / 服务监控 / 告警 / 定时任务 / 设置
- 总览把机群摊成一张纸：在线率、内存与磁盘合计、正在告警的主机、离线的主机
- 设置把运行时事实原样列出来（采集间隔、存储后端、保留点数），改值仍然去 DSH 的插件设置

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
- 「展示信息」单独存一张表：显示名、分组、标签、备注、到期日、价格、带宽。别名不可改 —— 它是历史数据的连接键，改一次那台机器的全部曲线就断了

**明细**
- 十项身份与运行时信息：系统、内核、架构、核心数、CPU 型号、延迟、运行时长、swap、TCP/UDP 连接数、进程数
- 硬件区块（慢探针，默认 5 分钟一轮）：温度、GPU、监听端口、分区用量、网卡累计流量
- 三张曲线：CPU %、内存 %、网络 KB/s（最近 1 小时，30 秒粒度）
- 失败原因原样展示（`Connection lost before handshake` 之类），不吞错误

**服务监控**
- HTTP / TCP / ICMP 三种探针，各自独立计时器，间隔 10 秒起
- HTTP 支持期望状态码（`200`、`2xx`、`200,204`、`/^2\d\d$/`）与响应体关键字；https 目标顺带读证书剩余天数，6 小时查一次
- 面板上每行 30 格，短历史左侧补空 —— 否则十分钟前才加的探针看起来像全天在线
- 探针从 DSH 宿主发起，所以可以监控没有 SSH 的路由器，SSH 凭据过期也不影响结论

**告警**
- 规则：指标（19 个）、方向（高于 / 低于）、阈值、持续秒数、冷却秒数、作用范围（全部 / 仅指定 / 排除指定）
- 持续秒数会换算成轮数（`180s ÷ 30s = 6 轮`），连续命中满那么多轮才触发；离线至少 2 轮，一次漏采是网络抖动，两次才是机器真的挂了
- 读不到值时状态**冻结**：一次 SSH 超时不会把正在告警的规则判成已恢复，否则下一轮又会亮起来，通知就成了震荡
- 冷却只压住「再次进入告警」，恢复通知永远立即发出
- 事件记在本机数据库里，重启后仍知道自己正在告警哪几台，不会重复开一条
- 一次评估超过 5 条通知会并成一条摘要，避免 30 台机器同时挂掉时刷屏

**通知**
- 通用 HTTP 模板，不是渠道枚举：URL、方法、请求体格式（json / form）、请求头、请求体
- 占位符 `#SERVER.NAME#` `#RULE.NAME#` `#VALUE#` `#MESSAGE#` 等 15 个；写错的占位符原样保留，打错的字应该出现在消息里，而不是悄悄变成空串
- 预置 Bark / Telegram / 飞书 / 企微 四个模板，凭据留成 `{token}` 让你自己填
- 可以先「发送测试」，成功 200、失败 502 并把上游原话带回来

**定时任务**
- 五字段 cron（`* / a-b / a/n / 逗号列表` 全套），保存时校验语法，并且拒绝**永远不会到来**的日期（`0 0 30 2 *`）——一条看起来启用、永不触发的记录，和坏掉的调度器在面板上长得一模一样
- 到点通过 SSH 在目标主机上跑一条命令，按 `覆盖范围`（全部 / 仅指定 / 排除指定）选机器，默认并发 4
- 每台主机各自记退出码与错误，输出保留每台尾部 1 KB、整体上限 8 KB；放不下的主机在末尾列出名字，而不是被静默丢掉
- 一条任务在跑时点「立即执行」会拿到 409，面板显示"忙"而不是"完成"
- 每个任务保留最近 500 次运行记录，删除任务连带删除历史
- 错过的运行不补跑：晚于 1 小时的调度直接跳过，不会在开机时补跑一堆

**终端**
- 主机详情里点「终端」，在面板内开一个交互式 shell，复用监控自己那条 SSH 长连接（不另开一路认证）
- 走本插件自己的 WebSocket 服务端（自写 RFC 6455 子集），不用 `ws`：仓库从 realpath 解析依赖，`ws` 在插件目录下不可见，硬引会让整条插件条目在宿主里回滚
- 升级请求**自己**做 loopback 校验——DSH 宿主的 upgrade 注册表不做任何来源检查，浏览器别的标签页可以发起跨站 WebSocket 握手
- WebSocket 的地址**不能**从 `location.origin` 拼：Electron 桌面端用 `dsh-app://` 自定义协议装载界面，那个 scheme 说不了 `ws://`、也没有端口。前端先问 `/status` 要 `port`（HTTP 请求本身仍走真实 loopback 端口），再连 `ws://127.0.0.1:<port>/…`。浏览器里的 web 端仍直接用 `location.origin`，不多一次往返
- 断线只是「脱钩」不是杀掉：5 分钟内重新进入会接回同一个会话；点「结束会话」才真的发 `close`
- 不实现完整 VT100。输出做了 ANSI 剥离与 `\r`/`\b` 光标处理，`ls`、`df`、`systemctl status` 这类输出可读；`top`/`vim`/`htop` 这类全屏程序请用 dsh-ssh 的终端，面板里也这么写着

**文件管理**
- 主机详情里点「文件」，SFTP 浏览、上传、下载、重命名、新建目录、删除，同样复用那条 SSH 长连接
- 路径归一化后必须落在 `fsRoots` 里（默认 `['/']`）。真正的边界是 SSH 账号权限，这个配置只是把范围收窄，比如改成 `['/home', '/var/log']`
- 下载先看大小再开流，超过 `maxDownloadBytes`（默认 256 MB）直接 413，不会先把内存吃满再报错
- 上传是原始 body + NDJSON 进度帧（不是 multipart），前端边读边显示百分比——几百 MB 的文件有动静，而不是一个可能是卡死的转圈
- 删除目录要显式带 `recursive`，否则回「目录非空」；根目录永远拒删；递归有 32 层深度上限，防止符号链接成环
- SFTP 通道空闲两分钟自动释放，不会一直占着远端 sshd 的一个槽

**实时**
- `EventSource` 长连接推快照，断线自动重连，重连退避期用 30 秒轮询兜底，面板不会冻住

**给 agent 用的工具**
- `fleet_snapshot` — 取当前机群状态，可按 `alerting` / `offline` / `online` 过滤
- `fleet_history` — 取某台主机最近 N 分钟的历史
- `fleet_refresh` — 立刻重新采集一轮，只回计数
- `fleet_host` — 取单台主机全景：最新样本 + 硬件（温度 / GPU / 监听端口 / 分区 / 网卡）+ 面板里写的展示信息
- `fleet_services` — 取服务探针与其最近 30 次结果，可按 `up` / `down` / `unknown` 过滤
- `fleet_alerts` — 取告警规则与已开的事件，可按 `firing` / `resolved` 过滤
- `fleet_tasks` — 取定时任务的下次运行时间与上一次结果，可选带某个任务的最近运行记录

工具不是固定的七个：`fleet_services` 与 `fleet_alerts` 只在宿主真的提供了探针引擎和告警引擎时才注册。一个永远回「不可用」的工具比不存在的工具更糟——读它的模型分不清这两种情况。

工具只读。要执行命令用面板里的「定时任务」，要开 shell 用「终端」——那里有人的确认环节。

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
| `slowIntervalMs` | `300000` | 硬件采集间隔（温度 / GPU / 端口 / 分区），60 秒 ~ 24 小时 |
| `slowTimeoutMs` | `20000` | 硬件采集超时，2 ~ 120 秒 |
| `fsRoots` | `["/"]` | 文件管理可达的绝对路径前缀；SSH 账号权限才是真边界，这里只是收窄 |
| `maxDownloadBytes` | `268435456` | 单个下载的大小上限（256 MB） |
| `maxUploadBytes` | `536870912` | 单个上传的大小上限（512 MB） |
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

- **只监听 loopback**。所有路由都过一道 fence：非 `127.0.0.1` / `::1` 的来源、带 `X-Forwarded-For` 或 `CF-Connecting-IP` 的请求（说明前面有代理）、`sec-fetch-site: cross-site`、来自非 loopback 主机的 `Origin` 一律 403。
  `Origin` 按**信任级**判而不是按字符串：`localhost:59101` 与 `127.0.0.1:59101` 是同一台机器同一个端口，`null` 与 `file://` 等价于"没有 Origin"（本地文件本来就不经浏览器就能读 loopback）。之所以不能做字面比较——WebSocket 的握手**总是**带 `Origin`，而同源 `fetch` 通常不带；字面比较会把提供面板的那个 GUI 自己的终端挡在门外。别的本地端口仍然拒绝：那是另一个应用。
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
5. 每个 tool 必须声明 `output: { schema, render }`。**缺一个就会抛错，而 cordis 会把该 entry 的全部 effect 一起回滚** —— 先注册的路由也一起消失，症状和"路由没写"一模一样。这条最容易误判：单测全绿，真实宿主里每个 API 都 401。
6. 宿主对**不存在的 `/api/*` 返回 401 而不是 404**。所以「401」不代表鉴权问题，只代表路由没注册；想看真正的加载错误，把插件装进 `--profile web` 用 CLI 启动，stderr 里会有 `entry did not activate`。

---

## 开发

零构建：`lib/*.js` 就是产物，改完直接生效（重启 DSH 加载 host 半）。

```bash
node --test "test/**/*.test.mjs"   # 51 条，零外部依赖
```

覆盖：采集脚本解析与差分（含计数器回绕、按挂载点而非设备名过滤磁盘）、两个存储后端同一行形状、`~/.ssh/config` 解析、每条路由的 loopback fence 与 CRUD 校验、tool 的 `output` 契约与缺列样本传 null 不传 NaN、mount/卸载/waiters 重放、浏览器半的 bundle 契约。

---

## 许可证

MIT。
