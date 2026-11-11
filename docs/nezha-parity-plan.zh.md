# 对标哪吒监控的改造方案

> 依据：`nezhahq/nezha` master（后端，Go）与 `nezhahq/admin-frontend` master（管理前端，React + shadcn/ui + TanStack Table + SWR）本地只读检出，逐文件核对结构与字段。
> 目标项目：`dsh-fleet-monitor` 0.1.0（agentless，SSH 拉取，DSH 插件）。

---

## 一、哪吒实际有什么（按源码实证，不是宣传语）

后端的 `model/` 目录就是它的功能边界，一个文件一个业务域：

| 业务域 | 源码文件 | 形态 |
|---|---|---|
| 服务器 | `model/server.go` `model/host.go` | `Server{Name,UUID,Note,PublicNote,DisplayIndex,HideForGuest,EnableDDNS,GeoIP,LastActive}`；`HostState` 31 个指标字段 |
| 服务器分组 | `model/server_group.go` + `server_group_server.go` | 多对多，带权重 |
| 服务监控 | `model/service.go` `service_history.go` | HTTP GET / ICMP Ping / TCP Ping 三种探针，30 次环形缓冲 |
| 定时任务 | `model/cron.go` | 5 字段 cron，三种覆盖范围（全部/忽略指定/仅指定） |
| 告警规则 | `model/alertrule.go` `model/rule.go` | 21 种指标，`duration` 时间窗 + 70% 失败率判定 |
| 通知 | `model/notification.go` `notification_group.go` | **通用 HTTP 模板**：URL + Method + Header + Body + `#占位符#`，因此能接任何渠道 |
| 在线率 | `model/online_history.go` | 会话 + 日聚合 |
| 流量/转移 | `model/transfer.go` `server_transfer.go` | 端口流量统计与服务器归属转移 |
| DDNS | `model/ddns.go` | 定时更新 DNS 商记录 |
| NAT | `model/nat.go` | 内网端口转发展示 |
| 终端 | `model/terminal_api.go` + `service/rpc` | gRPC 双向流，浏览器 xterm |
| 文件管理 | `model/fm_api.go` | agent 侧 FS API（list/read/write/delete/transfer） |
| API Token | `model/api_token.go` | PAT + server_ids 白名单 + scope |
| 用户/RBAC | `model/user.go` `jwt_session.go` `oauth2*` | 多用户、JWT 绑 IP、OAuth2 绑定 |
| WAF | `model/waf.go` | 面板自身访问控制 |
| MCP | `model/mcp_oauth.go` `mcp_audit.go` | 把监控能力暴露给模型 |
| 站点设置 | `model/config.go` `setting_api.go` | 站点名/语言/自定义代码/主题模板 |
| 前台主题 | `service/singleton/frontend-templates.yaml` | 独立用户前台 |

管理前端路由（`admin-frontend/src/routes/`）与此一一对应：`server` `server-group` `service` `cron` `alert-rule` `notification` `notification-group` `ddns` `nat` `online-user` `api-tokens` `transfer` `waf` `user` `settings` `frontends` `profile` `mcp-oauth-*` `login`。

### 关键机制（照抄源码结论）

**1. Agent 推送，不是拉取。**
Agent 常连接 gRPC（`NezhaService_ReportSystemState`），约 3 秒一帧。`AlertSampleInterval = 3 * time.Second`、`AlertSampleMaxAge = 6 * time.Second`（`model/alertrule.go:13-14`）—— 告警评估按 3 秒采样窗算失败占比，70% 才判触发。

**2. 告警指标全集**（`model/rule.go:63-73` `IsSupportedType`）：
```
cpu  gpu  gpu_max  memory  swap  disk
net_in_speed  net_out_speed  net_all_speed
transfer_in  transfer_out  transfer_all  transfer_in_cycle  transfer_out_cycle  transfer_all_cycle
offline  load1  load5  load15  tcp_conn_count  udp_conn_count  process_count  temperature_max
```
每个 `Rule` 有 `Min/Max/Duration/Cover/Ignore/CycleStart/CycleInterval/CycleUnit`。名称里刻意带下划线（`load1`、`tcp_conn_count`），前端表单直接用它当 select 值。

**3. 服务器指标全集**（`model/host.go:23-45` `HostState`）：
```go
CPU float64; MemUsed, SwapUsed, DiskUsed uint64
NetInTransfer, NetOutTransfer, NetInSpeed, NetOutSpeed uint64
Uptime, TcpConnCount, UdpConnCount, ProcessCount uint64
Load1, Load5, Load15 float64
Temperatures []SensorTemperature   // {Name, Temperature}
GPU []float64; GPUs []GPUStat      // GPUStat{Utilization, MemoryUsed, MemoryTotal}，MemoryTotal==0 表示未知
```
注意 `NetInTransfer` 是**累计字节**，`NetInSpeed` 是**速率** —— 两者都存，前端可切。

**4. 服务监控探针结果形状**（`model/service_api.go` `ServiceResponseItem`）：
```go
Delay *[30]float64; Up *[30]uint64; Down *[30]uint64
CurrentUp, CurrentDown, TotalUp, TotalDown uint64
```
固定 30 格环形缓冲 —— 就是面板上那排小方块（心跳格）。`Service` 字段含 `Type(1 HTTP/2 ICMP/3 TCP)`、`Target`、`Duration`、`Interval`、`Notify`、`MinLatency/MaxLatency/LatencyNotify`、`SkipServers`、`FailTriggerTasks/RecoverTriggerTasks`（失败/恢复时连带触发定时任务）。

**5. 通知就是 HTTP 模板**（`model/notification.go`）：
```go
URL string; RequestMethod uint8; RequestType uint8(JSON|Form)
RequestHeader string; RequestBody string; VerifyTLS *bool
```
`replaceParamsInString` 做 `#SERVER.NAME#` 这类占位符替换，URL 走 `url.QueryEscape`。所以"支持 Telegram/Bark/飞书/钉钉/企业微信/PushPlus/Gotify/Matrix/ntfy"不是代码里的分支，而是文档给了模板。**这一点我们可以原样照抄，成本极低、扩展性最高。**

**6. 时序存储策略**（`pkg/tsdb/config.go`）：`RetentionDays=30`、`DedupInterval=30s`、`WriteBufferFlushInterval=5s`，写入走缓冲批量。

---

## 二、我们的架构差异与等价性

| 维度 | 哪吒 | dsh-fleet-monitor | 影响 |
|---|---|---|---|
| 数据来源 | Agent 常连接推送（3s） | SSH 按轮拉取（默认 30s） | 采样精度低一个数量级；但零部署 |
| 覆盖范围 | 只覆盖装了 agent 的机器 | 覆盖 dsh-ssh / `~/.ssh/config` / 面板手工添加的全部主机 | 我们的优势 |
| 主机身份 | `Server.UUID` | `alias`（`user@host:port` 派生） | alias 可能变；需要 meta 表按 alias 挂 |
| 部署成本 | 每台装 agent + 一个服务端 | 装一个插件 | 我们的优势 |
| 网络方向 | Agent → Dashboard（入站） | Dashboard → 主机（出站 22） | 我们不需要公网入口 |
| 权限模型 | 多用户 + RBAC + PAT | DSH 单用户本地宿主 | 多用户体系不需要 |

**核心判断：哪吒的能力分三类，不能一律照搬。**

- **A 类：纯宿主侧计算** —— 告警规则、通知、服务探针、在线率、流量聚合、分组排序。与我们用什么采集无关，**可以 1:1 移植，且体验能对齐**。
- **B 类：需要远端执行** —— 定时任务、终端、文件管理。我们用 SSH 能等价实现（`pool.exec` / `shell` / `sftp`），差别只在于每次操作要建连。
- **C 类：SaaS 形态需求** —— 多用户、RBAC、前台主题、WAF、MCP、DDNS、NAT。**本地单用户桌面宿主不需要**，做了只会增加攻击面和维护成本。

---

## 三、现状盘点（我们已有什么）

`lib/` 12 文件 4632 行，51 条测试全绿，已在真实宿主验证 37 台主机、28 在线。

| 能力 | 状态 |
|---|---|
| 主机发现（三源合并去重） | ✅ `lib/hosts.js` |
| 快探针（CPU/负载/内存/磁盘/网络/连接数/进程/运行时长） | ✅ `lib/probe.js`（一次性 exec，单调计数器差分） |
| 时序存储（SQLite + JSON 降级） | ✅ `lib/store.js`，`keep=2880`（30s × 24h） |
| 并发池 + 重连 + 超时 | ✅ `lib/pool.js`（并发 6，exec 12s，connect 15s） |
| 面板 CRUD（添加/编辑/删除/测试连接） | ✅ `managed_host` 表 + `/hosts` `/test` |
| 实时推送 | ✅ SSE `/events` + 轮询兜底 |
| 三个 agent 工具 | ✅ `fleet_snapshot/history/refresh` |
| 告警 | ⚠️ 仅静态阈值着色（`cpuAlertPct` 等），无规则、无状态机、无通知 |
| 服务监控 / 任务 / 终端 / 文件 / 分组 / 在线率 / 流量 | ❌ 全无 |

**缺口就是哪吒的 A、B 两类。**

---

## 四、目标形态

### 4.1 信息架构：单入口 + 页内分区

DSH 的 `slots.register({name:'main', key})` 一插件一个主页面，侧边栏一入口。不可能像哪吒那样做 19 个独立路由。方案是**页内分段导航**（左侧竖排 tab 或顶部 tab，随宽度切换），状态存 `location.hash` 便于刷新保持：

```
机群监控
├─ 概览        总览统计 + 告警中的主机 + 服务可用性 + 近期事件
├─ 服务器      列表/卡片 + 分组 + 搜索 + 排序 + 详情抽屉
│   └─ 详情    指标区 + 趋势图 + 磁盘分区 + 网卡 + 温度/GPU + 操作（终端/文件/任务）
├─ 服务        HTTP/TCP/Ping 探针 + 30 格心跳条 + 证书到期
├─ 告警        规则列表 + 事件时间线 + 静默
├─ 任务        定时任务 + 执行历史 + 输出
└─ 设置        采集参数 + 通知渠道 + 通知分组 + 关于
```

### 4.2 数据表增量

现有 `node` / `sample` / `managed_host` 不动，新增：

```sql
-- 主机元数据：按 alias 挂，覆盖所有来源（dsh-ssh 导入的主机也能分组/标到期）
CREATE TABLE host_meta (
  alias TEXT PRIMARY KEY, group_name TEXT, tags TEXT DEFAULT '[]',
  note TEXT, display_index INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
  expire_at INTEGER, price REAL, bandwidth_gb INTEGER,
  updated_at INTEGER NOT NULL);

-- 服务探针
CREATE TABLE service_probe (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  type INTEGER NOT NULL,              -- 1 HTTP / 2 ICMP / 3 TCP
  target TEXT NOT NULL,               -- URL / host / host:port
  interval_sec INTEGER DEFAULT 60, timeout_ms INTEGER DEFAULT 5000,
  expect_status TEXT,                 -- "200" / "2xx" / 正则
  expect_keyword TEXT,                -- 响应体关键字
  notify INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL);
CREATE TABLE probe_result (
  probe_id INTEGER, ts INTEGER, ok INTEGER, latency_ms INTEGER,
  status_code INTEGER, error TEXT, cert_days INTEGER,
  PRIMARY KEY (probe_id, ts));
-- 环形缓冲只保留最近 30 条/探针，另存日聚合

-- 告警
CREATE TABLE alert_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  metric TEXT NOT NULL,               -- 采用哪吒的命名：cpu/mem/disk/load1/tcp_conn_count/offline/...
  op TEXT NOT NULL,                   -- gt / lt
  threshold REAL NOT NULL,
  duration_sec INTEGER DEFAULT 180,   -- 连续越界多久才触发
  scope TEXT DEFAULT '{"mode":"all","aliases":[]}',  -- all | only | exclude
  notify_group_id INTEGER, enabled INTEGER DEFAULT 1, cooldown_sec INTEGER DEFAULT 1800);
CREATE TABLE alert_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_id INTEGER, alias TEXT,
  started_at INTEGER, ended_at INTEGER, peak REAL,
  state TEXT,                         -- pending / firing / resolved
  message TEXT);

-- 通知
CREATE TABLE notify_channel (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  url TEXT NOT NULL, method TEXT DEFAULT 'POST', body_type TEXT DEFAULT 'json',
  headers TEXT DEFAULT '{}', body TEXT, verify_tls INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1);
CREATE TABLE notify_group (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
CREATE TABLE notify_group_channel (group_id INTEGER, channel_id INTEGER, PRIMARY KEY (group_id, channel_id));

-- 定时任务
CREATE TABLE cron_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  schedule TEXT NOT NULL,             -- 5 字段 cron
  command TEXT NOT NULL,
  cover TEXT DEFAULT '{"mode":"all","aliases":[]}',
  timeout_sec INTEGER DEFAULT 60, enabled INTEGER DEFAULT 1,
  notify_group_id INTEGER, last_run_at INTEGER, last_ok INTEGER);
CREATE TABLE cron_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, ts INTEGER,
  total INTEGER, ok_count INTEGER, duration_ms INTEGER, output_tail TEXT);

-- 日聚合：在线率 + 流量（对齐哪吒 online_history / transfer）
CREATE TABLE daily_stat (
  alias TEXT, day TEXT,               -- YYYY-MM-DD（宿主本地时区）
  samples INTEGER, up_samples INTEGER,
  rx_bytes INTEGER, tx_bytes INTEGER, -- 当日增量（累计差，处理回绕）
  PRIMARY KEY (alias, day));
```

### 4.3 采集分两级

一次 exec 里塞满所有指标会让每轮变慢（现在全量 37 台 31.9 秒，其中多数是超时主机拖的）。拆两级：

| 级别 | 周期 | 内容 | 实现 |
|---|---|---|---|
| fast | 30s（可配） | CPU 计数器、内存、磁盘聚合、网络累计、负载、连接数、进程数、运行时长、启动时间 | 现有 `PROBE_SCRIPT`，**基本不动** |
| slow | 300s（可配） | 温度（`/sys/class/thermal/thermal_zone*/temp` + type）、GPU（`nvidia-smi --query-gpu=...` 有则采 / AMD `gpu_busy_percent`）、磁盘分区明细（`df -kPT` 全表）、网卡明细（`/proc/net/dev` 逐 iface）、监听端口数（`ss -tln \| wc -l`） | 新增 `SLOW_PROBE_SCRIPT`，独立并发闸（2）与超时（8s） |

fast 与 slow 都遵守现有单调计数器约定：**只报原始计数器，速率由 store 上一行差分**。

温度/GPU 缺失是常态（虚拟机没有），脚本必须在没有 `nvidia-smi`、没有 thermal zone 时**静默产出空**，不能报错 —— 否则会被当成采集失败（这是我们已经踩过的坑：`probe_ok` 缺失导致 `complete: false`）。

### 4.4 服务监控在宿主侧跑，不走 SSH

哪吒的 HTTP/TCP/Ping 探针是 agent 执行的，所以"延迟"是从 agent 到目标。我们在 DSH 宿主进程直接执行：

- HTTP：`fetch(url, {signal: AbortSignal.timeout(...), redirect:'manual'})`，只取状态码 + 耗时；证书到期用 `node:tls` 单独建一次 TLS 连接读 `getPeerCertificate().valid_to`（仅在 https 且 `type=1` 时，且每 6 小时才重算一次，避免每轮握手）。
- TCP：`net.createConnection({host, port})`，`connect` 事件耗时即延迟。
- ICMP：Windows `ping -n 1 -w <timeout> <host>`，POSIX `ping -c 1 -W <sec> <host>`；解析 `time=` / `time<` 得到毫秒。没有 ping 权限就降级成 TCP 探 443 并标 `degraded`（诚实上报，不假装成功）。

结果写 `probe_result`，每次只保留最近 30 条 + 日聚合。前端画 30 格：成功绿、失败红、延迟超过 `MaxLatency` 黄。

### 4.5 告警引擎：把 3 秒窗口换成 N 轮窗口

哪吒用 `duration × 3s` 采样窗 + 70% 失败率。我们是 30s 一轮，直接用轮数更直观：

```
让 N = max(1, round(duration_sec * 1000 / intervalMs))
对每条规则每个主机维护 (consecutiveBreach, lastEvalAt)
越界 → consecutiveBreach++；正常 → consecutiveBreach = 0
consecutiveBreach >= N 且 state != firing → 触发（firing）
连续 N 轮正常 → resolved
```

状态机三段（pending/firing/resolved）避免抖动：刚触发时 status=`pending`，满 N 轮才进 `firing` 并通知；恢复同理。冷却：同 (rule, alias) 在 `cooldown_sec` 内不重复通知。

指标映射（哪吒命名 → 我们的 sample 列）：

| 哪吒 metric | 我们的列 | 说明 |
|---|---|---|
| `cpu` | `cpu_pct` | 已算好 |
| `memory` | `mem_used/mem_total` | 百分比 |
| `swap` | `swap_used/swap_total` | total=0 视为无 swap，规则跳过 |
| `disk` | `disk_used/disk_total` | |
| `load1/5/15` | `load1/5/15` | |
| `net_in_speed` / `net_out_speed` | `rx_bps` / `tx_bps` | |
| `tcp_conn_count` / `udp_conn_count` | `tcp` / `udp` | |
| `process_count` | `procs` | |
| `offline` | `status != 'online'` | 连续 N 轮失败 |
| `transfer_in/out/all` | `daily_stat` 月累计 | 按自然月 |
| `transfer_*_cycle` | 同上，按 `CycleStart + CycleInterval` | 计费周期 |
| `temperature_max` | slow 探针 | 无数据则规则跳过并标 `no_data` |
| `gpu` / `gpu_max` | slow 探针 | 同上 |

### 4.6 通知：照抄"HTTP 模板"

字段与哪吒一致：`url / method / bodyType(json|form) / headers / body / verifyTls`。占位符：

```
#SERVER.NAME# #SERVER.ALIAS# #SERVER.IP# #SERVER.GROUP#
#RULE.NAME# #RULE.METRIC# #RULE.THRESHOLD# #RULE.DURATION#
#VALUE# #TIME# #STATE# #MESSAGE# #SERVER.CPU# #SERVER.MEM# #SERVER.DISK#
```

前端给 4 个预置模板（Bark / Telegram / 飞书 / 企业微信）+ "自定义"空白，用户点一下填好，只改 token。

出网注意：`fetch` 在宿主进程里跑，Telegram 需要代理 —— 提供 `proxyUrl` 配置项（Node 24 的 `fetch` 不支持代理，用 `node:https` + `CONNECT` 或直接文档说明走系统代理）。这一项目前写成"配置项占位 + 文档说明"，实现放 P2 末尾。

### 4.7 定时任务：SSH exec + 自写 cron 解析

- 5 字段 cron 解析器自己写（~80 行，支持 `* * , - /`），不引依赖。校验比哪吒松：只接受合法表达式，拒绝 6 字段（秒）。
- 执行：`pool.exec(command, timeoutSec*1000)`，输出截断到末尾 4 KB。
- `cover.mode`：`all` 全部在线主机 / `only` 指定 / `exclude` 排除指定。
- 记录 `cron_run`：`total`、`ok_count`、`duration_ms`、`output_tail`（多主机时只存前 3 台的非空输出，避免爆库）。
- 并发：任务内主机并发 4，任务之间串行（同一时间只跑一个任务），避免把 SSH 池打满。

### 4.8 终端与文件：P4，独立评估

DSH 有 `ctx.webServer.registerUpgrade(handler)`（dsh-ssh 已用），可以走 WebSocket。

- **终端**：`ssh2` 的 `conn.shell({term:'xterm-256color', cols, rows})` 双向管道。前端不引 xterm.js（离线环境不保证能拿），自己写：`<pre>` 渲染 + 隐藏 input 捕获按键 + 处理 `\r`/退格/`\x1b[K` 等常用控制序列。够用但不完美（vim/htop 会花）。
- **文件**：`conn.sftp()` 的 `readdir/stat/readFile/writeFile/rename/unlink`。下载走 HTTP 流式（`/download?alias=&path=`），上传走 `multipart`。**路径必须做规范化 + 白名单根目录**，防止越权读宿主文件。

这两个是本期最大增量，建议先做终端（运维高频），文件管理随后。

---

## 五、分期落地

每期都能独立跑起来、独立验收，不做"半成品挂在那"。

### P0 — 主机元数据与详情深化（约 1 天）

**改动**
- `lib/store.js`：加 `host_meta` 表 + `getMeta/listMeta/upsertMeta/deleteMeta`；升级 `sample` 加 `temp_max REAL, gpu_util REAL, gpu_mem_used INTEGER, gpu_mem_total INTEGER`（ALTER TABLE 要 try/catch，旧库平滑升级）。
- `lib/probe.js`：新增 `SLOW_PROBE_SCRIPT` + `parseSlowProbe()`；`deriveRates` 不动。
- `lib/pool.js`：`probe()` 增加 `kind: 'fast'|'slow'`，slow 用独立超时。
- `lib/collector.js`：`slowDue` 判断（距上次 slow 采集超过 `slowIntervalMs` 才跑）；`record()` 合并 slow 字段。
- `lib/routes.js`：`/meta` GET/POST/DELETE。
- `lib/client.js`：分区导航骨架 + 服务器详情加"磁盘分区 / 网卡 / 温度 / GPU"四块 + 分组 tab + 到期天数徽标。

**验收**：37 台真机跑一轮，`/overview` 里至少 10 台带 `temp` 或 `gpu` 字段（有硬件的那几台）；分组/备注/到期日刷新后不丢。

### P1 — 服务监控（约 1 天）

**改动**
- 新文件 `lib/services.js`：探测器实现（http/tcp/icmp）+ 调度器（每探针独立倒计时，避免集中打点）。
- `lib/store.js`：`service_probe` / `probe_result` 两表 + 环形缓冲裁剪。
- `lib/routes.js`：`/services` GET/POST/DELETE + `/services/history`。
- `lib/client.js`：「服务」tab：表格 + 30 格心跳条 + 证书剩余天数 + 平均可用率。
- `lib/tools.js`：`fleet_services` 工具（模型可问"哪个站点挂了"）。

**验收**：加 3 个探针（1 个 https、1 个 tcp、1 个不可达 IP），60 秒后心跳条正确显示 30 格（不可达的全红）；证书天数正确。

### P2 — 告警规则 + 通知（约 1 天）

**改动**
- 新文件 `lib/alerts.js`：规则评估器（状态机 + 冷却）+ 通知发送器（模板替换）。
- `lib/store.js`：`alert_rule` / `alert_event` / `notify_channel` / `notify_group` / `notify_group_channel`。
- `lib/collector.js`：每轮采集后调 `alerts.evaluate(snapshot)`。
- `lib/routes.js`：`/alerts/rules` CRUD、`/alerts/events`、`/notify/*` CRUD、`/notify/test`（发一条测试消息）。
- `lib/client.js`：「告警」tab + 「设置」里的通知渠道表单（4 个预置模板）。
- `lib/tools.js`：`fleet_alerts` 工具。

**验收**：给 1 台主机设 `cpu > 1%` 持续 60 秒，2 分钟内产生 `firing` 事件并实际收到一条 Bark/自定义 Webhook 消息；阈值恢复后产生 `resolved`。

### P3 — 定时任务（约 1 天）

**改动**
- 新文件 `lib/cron.js`：5 字段解析 + 调度 + 执行。
- `lib/store.js`：`cron_task` / `cron_run`。
- `lib/routes.js`：`/tasks` CRUD + `/tasks/run`（手动跑一次）+ `/tasks/runs`。
- `lib/client.js`：「任务」tab。

**验收**：建一个 `*/5 * * * *` 的 `uptime` 任务，覆盖全部主机，2 次执行后历史里有记录，输出可看。

### P4 — 终端 + 文件管理（约 2 天，独立评估）

`registerUpgrade` WebSocket + `ssh2` shell/sftp。风险最高，建议先只做终端。

### P5 — 在线率与日流量（约 0.5 天）

`daily_stat` 聚合（每轮采集后 upsert 当日行）+ 「概览」里的 30 天在线率条 + 本月流量条。保留 30 天，与哪吒一致。

### 存储与降采样（P0 就必须定）

现状：`keep=2880` 样本 × 37 台 = 10.7 万行（24 小时）。
若按哪吒 30 天全精度：37 × 30 × 24 × 120 = 320 万行 —— SQLite 能扛但查询会慢。

方案：
- `sample` 保留 **24 小时全精度**（30s）
- 新增 `sample_5m` 表，每 5 分钟聚合一次（avg/max/min），保留 **30 天**
- 趋势图默认查 5m 表，24 小时内可切全精度
- 降采样在 `insertSample` 里顺手做（判断是否跨 5 分钟边界），不另起定时器

---

## 六、明确不做（及理由）

| 不做 | 理由 |
|---|---|
| 多用户 / RBAC / JWT / OAuth2 | DSH 是本地单用户桌面宿主，loopback fence 已经足够；加账号体系只是增加面 |
| 前台主题（`frontends` 模板） | 我们的 UI 就是 DSH 面板本身，没有"对外展示站"这个场景 |
| WAF | 同上 |
| MCP OAuth / agent 审计 | DSH 自己的工具暴露机制已经覆盖；再包一层只会重复 |
| DDNS 记录管理 | 需要用户 DNS 商凭据，收益低。改为 P5 附带的"公网 IP 变化告警"（只读 + 通知） |
| NAT 端口转发展示 | 纯静态配置展示，没有可执行动作 |
| 服务器归属转移（`transfer`） | 服务于多用户 SaaS 的机器过户，本地无意义 |
| GPU 每卡内存明细 | 只有 `MemoryTotal>0` 的机器有意义，先只存第一块卡的利用率与内存 |

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| slow 探针把一轮采集拖慢 | 独立并发闸（2）+ 独立超时（8s）+ 独立周期（5min）；slow 失败不影响 fast 的可用性判定 |
| `node:sqlite` ALTER TABLE 兼容旧库 | 所有 DDL 用 `try { db.exec(...) } catch {}` + `PRAGMA table_info` 探测列是否存在 |
| 告警风暴 | 状态机三段 + 冷却 + 每轮最多发 5 条通知（超出的合并成一条摘要） |
| 通知出网被墙 | 渠道表单留 `proxy` 字段（P2 先存不用），文档写清 Telegram 需自备代理 |
| 终端越权 | WebSocket 同样走 loopback fence；SFTP 路径做 `path.resolve` + 根目录白名单校验 |
| 定时任务把 SSH 池打满 | 任务串行、任务内并发 4；与采集共用池但采集优先（池内加优先级） |
| alias 变更导致元数据丢失 | `host_meta` 以 alias 为键；提供"重命名时迁移 meta"的操作；导入时按 `host:port` 兜底匹配 |

---

## 八、工作量与顺序建议

| 期 | 内容 | 新增/改动 | 估时 |
|---|---|---|---|
| P0 | 元数据 + 慢探针 + 详情深化 | `store.js` `probe.js` `collector.js` `pool.js` `routes.js` `client.js` | 1 天 |
| P1 | 服务监控 | 新 `services.js` + 4 处改动 | 1 天 |
| P2 | 告警 + 通知 | 新 `alerts.js` + 5 处改动 | 1 天 |
| P3 | 定时任务 | 新 `cron.js` + 3 处改动 | 1 天 |
| P4 | 终端 / 文件 | 新 `terminal.js` `sftp.js` + WebSocket 路由 | 2 天 |
| P5 | 在线率 / 流量 / 5m 降采样 | `store.js` `collector.js` `client.js` | 0.5 天 |

先做 P0+P1（两天，能把"可看"变成"能用"），P2 让它在没人盯着的时候也有价值，P3/P4 是运维动作，P5 收尾。

建议顺序：**P0 → P1 → P2 → P5 → P3 → P4**。P5 提前是因为它只动 store 与概览，越早做后面所有图表都能直接用 5m 表。
