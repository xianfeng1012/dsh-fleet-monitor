# 实施规格：A 类 + B 类全量对齐哪吒

> 本文件是施工图，不是选项表。所有取舍已定，照着写代码不需要再决策。
> 上一版规划：`docs/nezha-parity-plan.zh.md`（保留作为背景与来源说明）。
> 范围：**A 类（宿主侧计算）+ B 类（远端执行）全做；C 类 SaaS 形态一律不做。**

---

## 零、已定的十条

| # | 决定 | 理由 |
|---|---|---|
| 1 | **页面 = 单一 DSH 面板入口 + 页内 6 分区（hash 路由）** | `slots.register({name:'main'})` 一插件一页；多入口会让侧边栏变噪音 |
| 2 | **采集分 fast(30s) / slow(300s) 两级，各自独立脚本与并发闸** | 一次 exec 塞满会让 37 台一轮继续从 31.9s 变长 |
| 3 | **存储：`sample` 保 24h 全精度 + 新增 `sample_5m` 保 30 天** | 对齐哪吒 `RetentionDays=30`，避免 320 万行拖垮查询 |
| 4 | **服务探针在 DSH 宿主侧执行，不走 SSH** | 探针是"凭什么知道站点活着"，与目标机 SSH 可达性无关；少一次往返 |
| 5 | **告警 = 连续 N 轮 + 三段状态机 + 冷却**，不用哪吒的 3s 采样窗 | 30s 采样下 3s 窗永远算不出占比 |
| 6 | **通知 = 通用 HTTP 模板**（URL/method/header/body + `#占位符#`）+ 4 个预置 | 照抄哪吒，扩展性最高、代码最少 |
| 7 | **终端与文件自实现，但帧协议照抄 dsh-ssh 的 `TerminalServerFrame/TerminalClientFrame`** | 插件必须独立可用（"clone 就能用"是底线）；同构协议便于将来桥接 |
| 8 | **文件上传 = raw POST body + NDJSON 进度流**，不是 multipart | 简单、可流式、可限长；dsh-ssh 同做法 |
| 9 | **所有新路由复用现有 loopback guard；SFTP 增加根目录白名单** | 新表面不能开新口子 |
| 10 | **不引任何新依赖**：cron 解析器自写，WebSocket 服务端自写（`lib/ws.js`，约 150 行 RFC 6455 子集） | 零构建、零安装是本插件的卖点；`ws` 实测从本仓库 realpath 解析失败，见下 |

**为什么不引 `ws`（第二次审视的实测结论）**：`require.resolve('ws')` 在 `C:\Users\xianf\.dsh\profiles\desktop` 下 OK，但在插件真实路径 `E:\claude-project\termius导出账号\dsh-fleet-monitor`（junction 的 target）下报 `MODULE_NOT_FOUND`。dsh-ssh 能用 `ws` 是因为它**本体就在** `profiles\desktop\node_modules\` 里，`node_modules` 向上查找能命中；本仓库在 E: 盘，realpath 走到 `E:\...\node_modules\` 就断了。

引 `ws` 的代价：要么在 E: 侧和 profile 侧各建一条 junction（README 变成四条链接，谁 clone 谁踩），要么 vendor 一份。而 `ws` 在 apply 阶段 import 失败会**回滚整条 entry**，直接重演"面板在但每个 API 都 401"的故障。自写 150 行换掉这个雷，划算。

自写范围（只做终端需要的那一小块）：握手（`Sec-WebSocket-Key` → `sha1(key + 258EAFA5-E914-47DA-95CA-C5AB0DC85B11)` → base64）、帧解析（fin/opcode/mask/len，含 126/127 扩展长度）、text/close/ping/pong、按 16 位掩码解客户端帧、服务端帧不掩码。不做：`permessage-deflate`、二进制大帧分片、子协议协商。

---

## 一、页面结构（最终形态）

```
/api/dsh-fleet-monitor/...          ← host 半
#/overview   概览
#/servers    服务器（列表/卡片 → 详情抽屉）
#/services   服务监控
#/alerts     告警
#/tasks      定时任务
#/settings   设置
```

顶部分区导航：flex 横排，窄屏（<720px）折成下拉；当前项用 `border-bottom: 2px solid currentColor` 标记。状态进 `location.hash`，`hashchange` 监听，刷新保持。

### 1.1 概览

- 4 张统计卡：主机（在线/总）、服务（可用/总）、告警中（firing 数）、任务（今日执行/失败）。
- 「需要处理」列表：firing 事件 + 离线主机 + 证书 30 天内到期，按严重度排序，最多 8 条。
- 「全机队 CPU / 内存」两条堆叠条（各主机按其占比切段，颜色按 utilColor）。
- 「近 24 小时在线率」：每台一行 24 格（1 小时 1 格）。
- 页脚：最后采集时间 / 耗时 / 存储后端 / problems。

### 1.2 服务器

工具条：搜索、分组下拉、排序（alias/cpu/mem/disk/latency/status/到期）、表格·卡片切换、`+ 添加服务器`、刷新。

表格列（12）：状态点 · 名称/别名 · 分组 · 系统 · CPU · 内存 · 磁盘 · 网络↓↑ · 负载 · 延迟 · 到期 · 操作（终端/文件/详情）。
卡片视图：名称 + 四条 mini 进度条 + 系统徽标 + 到期徽标 + 三个操作按钮。

详情（右侧抽屉，宽 560px，`position: sticky`）：
- 身份区：别名、user@host:port、来源徽标、系统、内核、架构、核心数、CPU 型号、虚拟化、启动时间。
- 指标区：CPU/内存/交换/磁盘 四个 Meter + 网络速率 + 连接数 + 进程数 + 运行时长 + 延迟。
- 趋势区：CPU（max 100）、内存（max 100）、网络（自动量纲）三张 SVG 折线，时间窗切换 1h/6h/24h/7d（>24h 读 `sample_5m`）。
- 明细区：磁盘分区表（挂载点/类型/已用/总量/占比）、网卡表（接口/rx/tx）、温度（有则显示）、GPU（有则显示）。
- 最近错误：等宽红字。
- 操作区：`打开终端` `浏览文件` `在该主机执行命令`（弹出单行命令 + 输出）。

「在该主机执行命令」是 B 类里最便宜的能力，P3 就带上（复用 `pool.exec`）。

### 1.3 服务监控

列表列：状态点 · 名称 · 类型徽标（HTTP/TCP/PING）· 目标 · 最近延迟 · 30 格心跳 · 可用率 · 证书剩余 · 操作。
新建/编辑表单：名称、类型、目标、间隔秒、超时毫秒、期望状态码/关键字、延迟上下限、通知组、启用。
30 格心跳：每格 8×20px，成功 `#22c55e`、超 `maxLatency` `#f59e0b`、失败 `#ef4444`、无数据 `currentColor/12%`；hover 显示该格时间与耗时。

### 1.4 告警

- 规则表：名称 · 指标 · 条件 · 持续 · 范围 · 通知组 · 状态（启用/静默）· 操作。
- 规则表单：指标下拉（21 项，用哪吒命名）、运算符（`>` / `<`）、阈值、持续秒数、范围（全部/仅指定/排除指定，多选主机）、通知组、冷却秒数。
- 事件时间线：按时间倒序，每条 `[firing|resolved] 规则名 @ 主机 · 峰值 · 持续 · 时间`；可"静默此规则 1h"。
- 顶部三个筛选 chip：`firing` / `resolved` / `全部`。

### 1.5 任务

- 任务表：名称 · 计划（原始 cron + 人类可读）· 覆盖主机数 · 上次执行 · 结果 · 操作（立即执行/编辑/删除）。
- 执行历史（展开行）：时间 · 成功/总数 · 耗时 · 输出（末尾 4KB，等宽 pre，折叠）。
- 表单：名称、cron 表达式（带 5 个示例按钮）、命令（多行）、覆盖范围、超时秒、通知组。

### 1.6 设置

分三块（手风琴）：
1. **采集**：间隔、并发、超时、慢探针间隔、保留样本数、三个告警阈值（保留兼容）。
2. **通知渠道**：列表 + 新建表单（名称/URL/method/bodyType/headers/body/verifyTls）+「发送测试」按钮 + 4 个预置模板按钮（Bark/Telegram/飞书/企微）。
3. **关于**：版本、宿主版本、存储后端、数据库路径、主机源统计、测试数。

---

## 二、数据层

### 2.1 `sample` 表变更（ALTER）

```sql
ALTER TABLE sample ADD COLUMN temp_max REAL;
ALTER TABLE sample ADD COLUMN gpu_util REAL;
ALTER TABLE sample ADD COLUMN gpu_mem_used INTEGER;
ALTER TABLE sample ADD COLUMN gpu_mem_total INTEGER;
ALTER TABLE sample ADD COLUMN listen_ports INTEGER;
```
实现：`openStore` 里 `PRAGMA table_info(sample)` 读出已有列，缺哪个 `ALTER TABLE` 补哪个，整体 try/catch。JSON 后端不关心列，直接多写字段。

**这五列由 fast 写入时回填，slow 不直接写 `sample`**（第二次审视修正）。原因：`sample` 的主键是 `(alias, ts)`，fast 每 30s、slow 每 300s，两者 ts 会周期性撞在同一毫秒上（300/30 = 10，同相位必然撞），slow 若 `INSERT` 就会把 fast 那行的 cpu/mem 覆盖成 null，反之亦然。正确形态：slow 结果先落 `host_hardware`（每 alias 一行，最新值），`collector.record()` 在写 `sample` 时从内存里的 `this.hardware.get(alias)` 取 slow 列一起写入。`ts` 的唯一来源是 fast，零冲突。

实测已验证 `ALTER TABLE ADD COLUMN` 在已有 5 行数据的 WAL 库上安全，旧行新列为 `null`。

### 2.2 `sample_5m` 表

```sql
CREATE TABLE IF NOT EXISTS sample_5m (
  alias TEXT NOT NULL, ts INTEGER NOT NULL,
  cpu_pct REAL, mem_used INTEGER, mem_total INTEGER, disk_used INTEGER, disk_total INTEGER,
  rx_bps REAL, tx_bps REAL, load1 REAL, tcp INTEGER, procs INTEGER,
  PRIMARY KEY (alias, ts));
```
写入时机：`insertSample` 里判断 `Math.floor(ts / 300000) !== Math.floor(prevTs / 300000)`，跨桶就把**上一桶的聚合值**写进去。聚合值由桶内样本在内存里累计（`bucketAcc: Map<alias, {sum,count,max}>`），不额外查询。

**重启不丢桶（第二次审视补）**：`bucketAcc` 只在内存，宿主重启会丢掉当前半桶。写 5m 行时用 `INSERT INTO sample_5m ... ON CONFLICT(alias,ts) DO UPDATE SET` 全字段覆盖，并在 `openStore` 后首次启动时把 `bucketAcc` 从 `sample` 里"该桶已有 ts 区间的行"重建一次（一条 `SELECT` 按 `ts/300000` 分组聚合）。这样重启前后的样本会合进同一行，不会出现两个半桶。

保留：`sample_5m` 删 `ts < now - 30d`（在 prune 里一起做，每天最多一次，用 `last5mPrune` 时间戳节流）。

### 2.3 新表（完整 DDL）

```sql
CREATE TABLE IF NOT EXISTS host_meta (
  alias TEXT PRIMARY KEY, display_name TEXT, group_name TEXT, tags TEXT DEFAULT '[]',
  note TEXT, display_index INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
  expire_at INTEGER, price REAL, bandwidth_gb INTEGER,
  updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS host_hardware (
  alias TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  temp_max REAL, sensors TEXT DEFAULT '[]',
  gpu_util REAL, gpu_mem_used INTEGER, gpu_mem_total INTEGER, gpu_name TEXT,
  listen_ports INTEGER, partitions TEXT DEFAULT '[]', nics TEXT DEFAULT '[]',
  error TEXT);

CREATE TABLE IF NOT EXISTS service_probe (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  type INTEGER NOT NULL, target TEXT NOT NULL,
  interval_sec INTEGER DEFAULT 60, timeout_ms INTEGER DEFAULT 5000,
  expect_status TEXT, expect_keyword TEXT, max_latency_ms INTEGER DEFAULT 0,
  notify_group_id INTEGER, enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS probe_result (
  probe_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  ok INTEGER NOT NULL, latency_ms INTEGER,
  status_code INTEGER, error TEXT, cert_days INTEGER,
  PRIMARY KEY (probe_id, ts));

CREATE TABLE IF NOT EXISTS alert_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  metric TEXT NOT NULL, op TEXT NOT NULL DEFAULT 'gt', threshold REAL NOT NULL,
  duration_sec INTEGER DEFAULT 180,
  scope TEXT DEFAULT '{"mode":"all","aliases":[]}',
  notify_group_id INTEGER, cooldown_sec INTEGER DEFAULT 1800,
  enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS alert_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL, alias TEXT NOT NULL,
  state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  peak REAL, last_value REAL, message TEXT);

CREATE TABLE IF NOT EXISTS notify_channel (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  url TEXT NOT NULL, method TEXT DEFAULT 'POST', body_type TEXT DEFAULT 'json',
  headers TEXT DEFAULT '{}', body TEXT, verify_tls INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS notify_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS notify_group_channel (
  group_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, channel_id));

CREATE TABLE IF NOT EXISTS cron_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  schedule TEXT NOT NULL, command TEXT NOT NULL,
  cover TEXT DEFAULT '{"mode":"all","aliases":[]}',
  timeout_ms INTEGER DEFAULT 60000,
  notify_group_id INTEGER, enabled INTEGER DEFAULT 1,
  last_run_at INTEGER, last_ok INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS cron_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  total INTEGER, ok_count INTEGER, duration_ms INTEGER, output TEXT);

CREATE TABLE IF NOT EXISTS daily_stat (
  alias TEXT NOT NULL, day TEXT NOT NULL,
  samples INTEGER DEFAULT 0, up_samples INTEGER DEFAULT 0,
  rx_bytes INTEGER DEFAULT 0, tx_bytes INTEGER DEFAULT 0,
  PRIMARY KEY (alias, day));
```

索引：`probe_result(probe_id, ts DESC)`、`alert_event(started_at DESC)`、`cron_run(task_id, ts DESC)`。

`daily_stat` 写入：每轮 `record()` 后 upsert 当日行，`samples+1`、在线则 `up_samples+1`；流量用差值累加。

**差值的三个前置条件（第二次审视修正）**：
1. `prev` 必须存在且 `now - prev.ts <= 2 * intervalMs`。主机离线三天回来时，`store.previous()` 给的是三天前的行，直接相减会把这三天流量全记到今天。
2. `cur >= prev`（否则是计数器重置/重启，跳过本轮，不记负数）。
3. `day` 用**宿主本地日期** `new Date().toLocaleDateString('sv')`（`sv` 给 `YYYY-MM-DD`），不是 `toISOString().slice(0,10)` —— 后者是 UTC 日，东八区用户在 08:00 前看到的"今天"其实是昨天。

`alert_rule.duration_sec` 是用户输入的唯一时间维度；`N = max(1, round(duration_sec * 1000 / intervalMs))` 里 `offline` 指标额外取 `max(N, 2)`（单次连接失败不足以判死，池里已有一次传输层重试，再给一轮冗余）。

---

## 三、模块划分（最终文件表）

| 文件 | 职责 | 新增/改 |
|---|---|---|
| `lib/probe.js` | `PROBE_SCRIPT`（fast）+ `SLOW_PROBE_SCRIPT`、`parseProbe`、`parseSlowProbe`、`deriveRates` | 改 |
| `lib/hosts.js` | 三源发现、`normalisePanelHost`、`SOURCE_RANK` | 不动 |
| `lib/store.js` | 所有表与方法（约 900 行 → 拆出 `store-schema.js`） | 大改 |
| `lib/store-schema.js` | 纯 DDL 常量 + `migrate(db)` | 新 |
| `lib/pool.js` | 连接池；新增 `kind: 'fast'|'slow'` 超时、`execWithOutput` | 改 |
| `lib/collector.js` | 调度 fast/slow、`record()`、`shapeRow()`、`dailyRollup()` | 大改 |
| `lib/services.js` | 探针执行器 + 调度器 + 30 格环形缓冲 | 新 |
| `lib/alerts.js` | 规则评估状态机 + 事件生命周期 | 新 |
| `lib/notify.js` | 模板替换 + HTTP 发送 + 冷却表 + 预置模板 | 新 |
| `lib/cron.js` | 5 字段 cron 解析 + 调度 + 执行（含通知） | 新 |
| `lib/terminal.js` | 终端会话注册表 + upgrade 处理（背压/滚动缓冲/回收） | 新 |
| `lib/sftp.js` | ls / download / upload / mkdir / rename / delete + 根白名单 | 新 |
| `lib/routes.js` | 所有 HTTP 路由（约 900 行 → 按域拆 `routes/*.js`） | 大改 |
| `lib/tools.js` | 7 个 agent 工具（现有 3 + 服务/告警/任务/文件 4） | 改 |
| `lib/index.js` | Config 扩字段、apply 接线、upgrade 注册 | 改 |
| `lib/client.js` | 6 分区 UI（约 1457 → 4000+ 行，按分区拆 `client/*.js` 再内联进 bundle） | 大改 |

**关于 `client.js` 拆分**：bundle 必须是单文件、`window.__ModuleLoader__.load` 包裹。做法：源码拆成 `src/client/*.js`（每分区一个），构建时用 `scripts/bundle-client.mjs`（Node 脚本，纯字符串拼接）打成一个 `lib/client.js`。这样既保持零构建依赖，又能让 4000 行可维护。`npm run build:client` 触发，产物入库。

**拆分的硬性约定（第二次审视补，不写清后面必返工）**：拼接是纯文本拼接，不是模块系统，所以各分区文件之间**没有** import/export，全部靠约定的命名空间：

- `src/client/00-preamble.js`：`window.__ModuleLoader__.load({...})` 开头 + `const h/React` + `let translate` + `t()` + 所有 `fmt*` / `utilColor` / `statusColor` + `api()` + 字典 `zh`/`en`。**只有这个文件可以声明顶层 `const`**。
- `src/client/10-hooks.js`：`useFleet` / `useHosts` / `useHistory` / `useServices` / `useAlerts` / `useCron`，全部 `function` 声明。
- `src/client/20-*` … `25-*`：`Field`/`Meter`/`Sparkline`/`Pill`/`HostForm` 等共享组件，全部 `function` 声明。
- `src/client/30-overview.js` … `35-settings.js`：分区页面，导出成 `function OverviewPanel(props) {...}` 这样的**具名函数声明**（不要 `const`，否则 `00-preamble` 之后的文件里同名会 `SyntaxError`）。
- `src/client/90-apply.js`：`function FleetMonitorPage()`（按 `location.hash` 切分区）+ `FleetMonitorIcon` + `function apply(ctx)` + `exports.apply = apply; exports.inject = ['slots','locale']; return module.exports`。

约定一句话：**除 `00-preamble.js` 外，任何文件都只用 `function` 声明，不允许顶层 `const`/`let`/`class`** —— 这样拼接顺序无关，也不会有重名崩塌。`bundle-client.mjs` 按文件名排序拼接，并在开头加 `/* generated by scripts/bundle-client.mjs — do not edit */`。

---

## 三点五、主键与重命名（第二次审视新增）

`node` / `sample` / `sample_5m` / `host_meta` / `daily_stat` 全部以 `alias` 为键。所以：

**`alias` 一旦存在就不能改**。`PATCH /hosts` 只允许改 `host/port/user/auth/tags/note/groupName/displayIndex/hidden/expireAt/price/bandwidthGb`，提交里带不同 `alias` 直接 400 `alias is immutable; delete and re-add instead`。理由：改 alias 等于丢掉这台机器的全部历史与告警状态，而用户以为只是改个显示名。真要换名字就删了重加（UI 在删除确认条里明说"历史数据一并删除"）。

`host_meta` 的"起名"需求用另一个字段满足：`display_name`（可空，UI 优先显示它，节点匹配仍用 alias）。加进 `host_meta` DDL：`display_name TEXT`。

---

## 三点六、空态引导（第二次审视新增）

新装用户打开面板看到 6 个分区全空，不知道该干什么。三处必须有引导，否则"能装不会用"：

| 条件 | 显示 |
|---|---|
| 全机队 0 台主机 | 大块空态：`还没有可监控的主机` + 三个按钮（`从 dsh-ssh 导入`（说明读的是 `~/.dsh/dsh-ssh.json`）/`手动添加`/`查看 ~/.ssh/config 路径`）+ 一行字"本插件不发现新主机，只监控已配置的" |
| 有主机但 `alert_rule` 为 0 | 概览顶部一条提示条：`还没有告警规则，超标不会通知你` + 按钮`一键创建推荐规则`（CPU>85% 持续 180s / 内存>90% 持续 300s / 磁盘>90% 持续 600s / 离线 120s，四条，指向"默认通知组"） |
| 有 `alert_rule` 但 `notify_group` 为 0 | 告警页顶部提示条：`规则已建但没有通知渠道，触发后只在面板里标红` + 按钮`添加通知渠道` |

推荐规则按钮的语义是"建四条 `enabled: 1` 的规则并指向 `notify_group_id = null`"，不自动建渠道（渠道要用户填自己的 token，猜不出来）。

---

## 四、采集层规格

### 4.1 fast 脚本（现有 `PROBE_SCRIPT`，只加两项）

新增采集：
- `listen_ports`：`ss -Htln 2>/dev/null | wc -l`（`ss` 不在就用 `netstat -tln | grep -c LISTEN`），失败输出空。
- `boot_epoch` 已有，不动。

其余不动。**不要**在这里加温度/GPU —— 那会让 30s 一轮变慢。

### 4.2 slow 脚本（新增 `SLOW_PROBE_SCRIPT`）

```sh
set -u
echo "slow_ts=$(date +%s)"

# 温度：thermal zone 逐个取 type + temp
i=0
for z in /sys/class/thermal/thermal_zone*; do
  [ -r "$z/temp" ] || continue
  t=$(cat "$z/temp" 2>/dev/null) || continue
  ty=$(cat "$z/type" 2>/dev/null) || ty="zone$i"
  case "$t" in ''|*[!0-9-]*) continue;; esac
  # 绝大多数平台给 millidegree（45000），少数直接给摄氏度（45）。
  # 无条件 /1000 会让后者全变成 0，所以要按量级判断。
  c=$(awk -v v="$t" 'BEGIN{ if (v>=1000 || v<=-1000) printf "%.1f", v/1000; else printf "%.1f", v }')
  echo "temp_${i}_name=$(echo "$ty" | tr ' ' '_')"
  echo "temp_${i}_c=$c"
  i=$((i + 1))
  [ "$i" -ge 8 ] && break
done

# GPU：nvidia-smi 优先，其次 AMD sysfs
if command -v nvidia-smi >/dev/null 2>&1; then
  g=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1)
  case "$g" in
    *[0-9]*) echo "gpu_util=$(echo "$g" | awk -F', *' '{print $1}')"
             echo "gpu_mem_used=$(echo "$g" | awk -F', *' '{print $2}')"
             echo "gpu_mem_total=$(echo "$g" | awk -F', *' '{print $3}')";;
  esac
else
  u=$(cat /sys/class/drm/card0/device/gpu_busy_percent 2>/dev/null) || u=""
  case "$u" in ''|*[!0-9]*) ;; *) echo "gpu_util=$u";; esac
fi

# 磁盘分区明细（按挂载点，dev 去重，排除伪文件系统）
if df -kPT >/dev/null 2>&1; then
  df -kPT 2>/dev/null | awk 'NR>1 && $2!="tmpfs" && $2!="devtmpfs" && $2!="devfs" && $2!="efivarfs" && $2!="autofs" && $2!="squashfs" && $2!="overlay_on_tmpfs" && $7!~"^/(proc|sys|dev)(/|$)" { if (seen[$1]++) next; printf "part=%s|%s|%s|%s\n", $7, $2, $4, $3 }'
else
  df -kP 2>/dev/null | awk 'NR>1 { if (seen[$1]++) next; printf "part=%s|%s|%s|%s\n", $6, "auto", $3, $2 }'
fi

# 网卡明细（跳过 lo）
awk -F'[: ]+' 'NR>2 && $1!="lo" && $2+0>0 { printf "iface=%s|%s|%s\n", $1, $2, $10 }' /proc/net/dev 2>/dev/null

echo "slow_ok=1"
echo "slow_done=1"
```

解析：`parseSlowProbe(stdout)` → `{ ts, temps: [{name, c}], gpu: {util, memUsed, memTotal}|null, parts: [{mount, fs, usedKb, totalKb}], ifaces: [{name, rxBytes, txBytes}], complete }`。

**关键约束**（踩过的坑）：任何一段取不到都必须静默跳过，不能输出非法字符，不能让 `set -e` 生效（用 `set -u` 而非 `-eu`）；末尾 `slow_ok=1` 必须在所有段之后无条件执行。

**已知限制（写进 README，不在代码里绕）**：`df -kPT` 的挂载点字段按空格分列，挂载点本身含空格（`/mnt/my disk`）时会被拆成 `$7` + `$8`，解析出来的 mount 会截断。Linux 上极罕见（`/etc/fstab` 里得显式转义 `\040`），不为此加 `substr` 位置计算 —— 那会让支持 `-P` 回退的分支更脆。分区明细页对解析异常的行只显示设备名不显示挂载点。

### 4.3 调度

`Collector` 新增：
```js
this.lastSlowAt = 0
async refresh(reason, kind = 'fast') { ... }
// fast 循环里：
const slowDue = Date.now() - this.lastSlowAt >= this.config.slowIntervalMs
if (slowDue) { this.lastSlowAt = Date.now(); void this.refreshSlow() }
```
`refreshSlow()` 独立并发闸 2、超时 8000ms、失败只写 `lastSlowError` 不影响 `status`。

---

## 五、服务探针规格

```js
// lib/services.js
export class ServiceMonitor {
  constructor({ store, config, emit })
  start() / dispose() / reload()
  async runProbe(probe)   // 单次执行
  list()                  // 含最近 30 格
}
```

### 5.1 三种类型的实现

```js
// HTTP
const started = performance.now()
const res = await fetch(target, {
  method: 'GET', redirect: 'manual',
  signal: AbortSignal.timeout(timeoutMs),
  headers: { 'user-agent': 'dsh-fleet-monitor/0.2' },
})
ok = expectStatus ? matchStatus(res.status, expectStatus) : res.status < 400
if (ok && expectKeyword) { const body = await res.text(); ok = body.includes(expectKeyword) }
latencyMs = Math.round(performance.now() - started)

// TLS 证书（仅 https，且距上次检查 > 6h）
const days = await certDaysLeft(new URL(target).hostname, timeoutMs)

// TCP
ok = await new Promise(resolve => {
  const sock = net.createConnection({ host, port })
  const t = setTimeout(() => { sock.destroy(); resolve(false) }, timeoutMs)
  sock.once('connect', () => { clearTimeout(t); latency = Date.now() - started; sock.end(); resolve(true) })
  sock.once('error', () => { clearTimeout(t); sock.destroy(); resolve(false) })
})

// ICMP
win32: spawn('ping', ['-n','1','-w',String(timeoutMs), host])
other: spawn('ping', ['-c','1','-W',String(Math.ceil(timeoutMs/1000)), host])
parse /[=<]\s*([\d.]+)\s*ms/  → latency；无匹配但 exit 0 → latency 记为 null 但仍 ok
```

**`certDaysLeft` 的两个必须（第二次审视补）**：
1. `https.request({ hostname, port: 443, rejectUnauthorized: false, servername: hostname })` —— 不加 `rejectUnauthorized: false`，自签证书站点连 `socket.getPeerCertificate()` 都拿不到，探针会把它判成"证书不可用"。要做到期监控就必须能读自签证书。
2. 必须 `servername: hostname` 发 SNI，否则共享 IP 的 CDN 回错证书。
3. 返回值语义：`null` = 非 https 或连不上；`0` = 已过期；正数 = 剩余天数。

`matchStatus`：`"200"` 精确、`"2xx"` 区间、`"200,204"` 枚举、以 `/` 开头的当正则。

**探针出网的边界说明**：探针从 DSH 宿主发起，所以 `target` 可以是内网地址（`http://192.168.31.2`）。这是特性不是漏洞 —— 用户本来就要监控自己的内网服务。同理 `notify_channel.url` 不做内网过滤。写进 README 的"安全边界"一节：本插件的信任边界是"能在本机 loopback 打开面板的人 = 本机用户"，不是"目标 URL 只能是公网"。

### 5.2 调度

每个探针独立 `setTimeout(interval)` 循环（不是统一 tick），首次延迟随机 `0~interval*0.3` 打散。同一探针不重入（`running` 标记）。`dispose()` 清所有 timer。

### 5.3 环形缓冲存储

`probe_result` 只保留每探针最近 **200** 条（够 30 格 + 日聚合），`runProbe` 后 `DELETE FROM probe_result WHERE probe_id=? AND ts <= (SELECT ts FROM probe_result WHERE probe_id=? ORDER BY ts DESC LIMIT 1 OFFSET 199)`。

API 返回 30 格：`SELECT ts, ok, latency_ms FROM probe_result WHERE probe_id=? ORDER BY ts DESC LIMIT 30` 再反转。

---

## 六、告警引擎规格

### 6.1 状态（内存 + 落库）

```js
// 内存：key = `${ruleId}:${alias}`
{ consecutive: 0, state: 'idle' | 'pending' | 'firing', eventId: null, peak: 0, lastNotifiedAt: 0 }
```

启动时从 `alert_event WHERE ended_at IS NULL` 恢复 `firing` 状态（重启不丢）。

### 6.2 评估（每次 `collector.record()` 之后）

```js
evaluateRule(rule, nodes) {
  const N = Math.max(rule.metric === 'offline' ? 2 : 1,
                     Math.round(rule.durationSec * 1000 / this.config.intervalMs))
  for (const node of nodes) {
    if (!inScope(rule.scope, node.alias)) continue
    const value = metricValue(rule.metric, node)     // null = 无数据
    const st = this.state.get(key(rule, node)) ?? { consecutive: 0, state: 'idle', peak: 0, lastNotifiedAt: 0 }

    // null 是「这一轮没拿到数据」，不是「恢复正常」。冻结状态，否则一次 SSH 超时
    // 就会把 firing 的规则判成 resolved，下一轮再触发 —— 通知来回震荡。
    if (value === null) { st.state = st.state === 'firing' ? 'firing' : st.state; st.noData = true; this.state.set(key, st); continue }
    st.noData = false

    const breach = rule.metric === 'offline'
      ? node.status !== 'online'
      : (rule.op === 'gt' ? value > rule.threshold : value < rule.threshold)

    if (breach) { st.consecutive++; st.peak = Math.max(st.peak, value) }
    else { st.consecutive = 0 }

    if (st.state !== 'firing' && st.consecutive >= N) {
      st.state = 'firing'; st.eventId = store.openEvent(rule, node, value, st.peak)
      if (this.config.intervalMs > 0 && Date.now() - st.lastNotifiedAt >= rule.cooldownSec * 1000) {
        st.lastNotifiedAt = Date.now()
        notify(rule, node, 'firing', value)          // 只有这一处受 cooldown 约束
      }
    } else if (st.state === 'firing' && st.consecutive === 0) {
      st.state = 'idle'; store.closeEvent(st.eventId, value); st.eventId = null; st.peak = 0
      notify(rule, node, 'resolved', value)          // 恢复通知不受 cooldown 限制
    }
  }
}
```

**`cooldown_sec` 的确切语义**（第二次审视写死，否则实现容易做成每轮都发）：持续超标时状态一直是 `firing`，上面分支根本不进 → 永不重复发。`cooldown` 只在 `idle/pending → firing` 的入口生效，即「这条规则对这台机器在 `cooldown` 内刚发过触发通知」才压掉，用来抑制 `firing → resolved → firing` 的反复震荡。`resolved` 一律立即发。

**`no_data` 处理**：`value === null`（无 swap、无温度、无 GPU、这一轮 SSH 失败）→ 冻结状态、不累计、不触发、不归零，UI 标"规则不适用 / 无数据"。`offline` 指标不走这条（离线本身就是有意义的观测）。

**`N` 依赖 `intervalMs`**：用户把采集间隔从 30s 改成 10s，`N` 会变成 3 倍，同样的 `durationSec` 会更快触发。这是设计意图（`durationSec` 才是语义单位，`N` 只是换算结果），但设置页要显示"当前间隔下 = N 轮"。

**`peak` 在 resolved 后重置为 0**，避免下个事件继承上个事件的峰值。

### 6.3 指标映射（`metricValue`）

| metric | 取值 | 单位 |
|---|---|---|
| `cpu` | `node.cpuPct` | % |
| `memory` | `mem.usedBytes / mem.totalBytes * 100` | % |
| `swap` | `swap.totalBytes > 0 ? used/total*100 : null` | % |
| `disk` | `disk.usedBytes / disk.totalBytes * 100` | % |
| `load1/5/15` | `node.load1/5/15` | — |
| `net_in_speed` / `net_out_speed` | `node.rxBps / txBps`（B/s） | B/s |
| `net_all_speed` | `rxBps + txBps` | B/s |
| `tcp_conn_count` / `udp_conn_count` | `node.tcp / node.udp` | 个 |
| `process_count` | `node.procs` | 个 |
| `offline` | `node.status !== 'online' ? 1 : 0` | — |
| `transfer_in` / `out` / `all` | `daily_stat` 本月累计 | **GB**（`Σ bytes / 1024³`，阈值按 GB 填） |
| `transfer_*_cycle` | 按 `cycleStart + cycleInterval` 窗口累计 | **GB**（同上换算） |
| `temperature_max` | `Math.max(...temps.map(t=>t.c))` | ℃ |
| `gpu` / `gpu_max` | `node.gpu?.util` / 各卡最大 | % |

### 6.4 通知（`lib/notify.js`）

```js
const PLACEHOLDERS = {
  '#SERVER.NAME#': n => n.name ?? n.alias,
  '#SERVER.ALIAS#': n => n.alias,
  '#SERVER.IP#': n => n.host,
  '#SERVER.GROUP#': n => n.group ?? '',
  '#SERVER.CPU#': n => fmtPct(n.cpuPct),
  '#SERVER.MEM#': n => fmtPct(memPct(n)),
  '#SERVER.DISK#': n => fmtPct(diskPct(n)),
  '#RULE.NAME#': (_, r) => r.name,
  '#RULE.METRIC#': (_, r) => r.metric,
  '#RULE.THRESHOLD#': (_, r) => String(r.threshold),
  '#RULE.DURATION#': (_, r) => String(r.durationSec),
  '#VALUE#': (_, __, v) => v === null ? 'n/a' : String(Math.round(v * 100) / 100),
  '#TIME#': () => new Date().toLocaleString('zh-CN'),
  '#STATE#': (_, __, ___, s) => s === 'firing' ? '触发' : '恢复',
  '#MESSAGE#': (_, __, ___, __, m) => m,
}
```

发送：`fetch(url, {method, headers, body})`，`body_type==='json'` 时 `content-type: application/json`，`form` 时 `application/x-www-form-urlencoded`。`verifyTls===0` 时用 `node:https` + `rejectUnauthorized:false`（`fetch` 做不到，需分支）。

失败处理：记录 `lastError`，不重试（避免风暴），不抛。

**合并抑制**：一次评估若产生 >5 条通知，把其余合并成一条摘要发到同组。

**预置模板**（4 个，前端一键填）：
- Bark：`https://api.day.app/<KEY>/#SERVER.NAME#`，body `{"title":"#STATE# #RULE.NAME#","body":"#SERVER.ALIAS# #RULE.METRIC# = #VALUE#"}`
- Telegram：`https://api.telegram.org/bot<TOKEN>/sendMessage`，body `{"chat_id":"<CHAT_ID>","text":"..."}`
- 飞书：`https://open.feishu.cn/open-apis/bot/v2/hook/<TOKEN>`，body `{"msg_type":"text","content":{"text":"..."}}`
- 企微：`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>`，body `{"msgtype":"text","text":{"content":"..."}}`

### 6.5 静默

`POST /alerts/silence {ruleId, alias?, minutes}` → 写内存 `silencedUntil` Map，评估时跳过通知但仍记录事件。

---

## 七、定时任务规格

### 7.1 cron 解析（自写，约 90 行）

支持 `* / , -`，5 字段（分 时 日 月 周），周 0/7 = 周日。

```js
export function parseCron(expr) → { minutes:Set, hours:Set, days:Set, months:Set, weekdays:Set }
export function nextRun(parsed, from) → number   // 逐分钟推进最多 366*24*60 次，超限返回 null
export function describeCron(expr) → string      // "每天 03:00" / "每 5 分钟" / 原样返回
```

拒绝：字段数 ≠ 5、含非法字符、范围越界 → 抛错，API 返回 400 带具体原因。

### 7.2 调度

单 `setTimeout` 驱动：`scheduleNext()` 找最近一次 → `setTimeout(ms)` → 执行 → 重新 `scheduleNext()`。任务表变更时 `reload()` 重排。

### 7.3 执行

```js
async runTask(task, { manual = false } = {}) {
  if (this.running) return { skipped: 'another task is running' }   // 任务间串行
  this.running = true
  const targets = resolveCover(task.cover, this.hosts)
  const sem = new Semaphore(4)
  const results = await Promise.all(targets.map(h => sem.run(async () => {
    const r = await pool.run(h, task.command, task.timeoutMs)   // 见下
    return { alias: h.alias, ok: r.exitCode === 0, exitCode: r.exitCode, ms: r.durationMs, out: r.stdout + r.stderr }
  })))
  const okCount = results.filter(r => r.ok).length
  store.insertCronRun(task.id, { total: targets.length, okCount, durationMs, output: tail(results) })
  if (task.notifyGroupId) notifyTaskResult(task, results)
  this.running = false
}
```

**`pool.run` 是新方法，`lib/pool.js` 现在只有 `acquire/release/probe/reap/dispose`**（第二次审视查实：`probe()` 把 `PROBE_SCRIPT` 写死在内部，`PooledConnection.exec()` 才是通用入口）。要加：

```js
// lib/pool.js
async run(host, config, command, timeoutMs) {
  await this.acquire()
  try {
    const pooled = this.connectionFor(host, config)   // 取或建，抽自 probe() 的现有逻辑
    let result = await pooled.exec(command, timeoutMs ?? this.execTimeoutMs)
    if (result.error !== undefined && !result.timedOut) {
      pooled.destroy(); this.connections.delete(host.alias)
      result = await this.connectionFor(host, config).exec(command, timeoutMs ?? this.execTimeoutMs)
    }
    return result      // { stdout, stderr, exitCode, durationMs, error?, timedOut }
  } finally { this.release() }
}
```

`connectionFor(host, config)` 同时是终端与 SFTP 需要的入口（它们要拿同一条长连接开 shell / 建 sftp 通道，不能自己 `new PooledConnection`）。`probe()` 改为内部调用它，语义不变。

`tail(results)`：每台取末尾 1KB，**全部主机**（不截成 3 台 —— 用户要看第 20 台的输出），用 `\n--- alias ---\n` 分隔，整体截 8KB，截断时末尾加 `\n[truncated]`。

---

## 八、终端规格

### 8.1 路由

```js
// lib/routes.js
export const TERMINAL_PATH = '/api/dsh-fleet-monitor/terminal'
```
`ctx.webServer.registerUpgrade(upgrade)`，`upgrade(req, socket, head)`：

**宿主不做任何校验，这条路径的守门全在 handler 里**（`dsh-host-webserver/lib/index.js:509-542` 只用 `new URL(req.url,'http://x').pathname` 精确匹配 `upgrades` Map，命中就把 `(req, socket, head)` 原样交给你）。所以：

1. **loopback + 同源校验（防 CSWSH）**：沿用 `isLoopbackRequest`；不通过 → `socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')` 然后 `socket.destroy()`。
   - 这一步不是可选项。WebSocket 不受同源策略约束，任意网页都能 `new WebSocket('ws://127.0.0.1:PORT/api/dsh-fleet-monitor/terminal?alias=x')`；只靠"监听 127.0.0.1"挡不住，必须看 `Origin` 与 `Host` 同源（`isLoopbackRequest` 已经做了：`X-Forwarded-For`/`CF-Connecting-IP` 一律拒绝、`sec-fetch-site: cross-site` 拒绝、`Origin` 的 host 不等于请求 host 拒绝）。
2. `size` 从 query 取 `cols`/`rows`，非法回退 80×24。
3. `new WebSocketServer({ noServer: true })` 的等价物：自写 `lib/ws.js` 的 `accept(req, socket, head)` → 返回 `WsConnection`（`on('message'|'close')`、`send(text)`、`close(code, reason)`、`bufferedAmount`）。
4. `registry.handle(conn, url)`。

`url.searchParams`: `alias`（必填）、`session`（可选，重连用）；两者都空 → `HTTP/1.1 400 Bad Request` + `destroy`。

### 8.2 会话注册表（`lib/terminal.js`）

照抄 dsh-ssh 的语义，参数自定：

```js
const BACKPRESSURE_HIGH = 1024 * 1024
const BACKPRESSURE_LOW  = 512 * 1024
const MAX_BUFFER_BYTES  = 256 * 1024
const IDLE_MS           = 10 * 60 * 1000
const EXIT_GRACE_MS     = 60 * 1000

class TerminalRegistry {
  open(conn, alias, size)      // 新建会话
  attach(conn, sessionId, size) // 重连，回放滚动缓冲
  handle(conn, url)            // 统一入口：有 session 参数则 attach，否则 open
  dispose()                  // 关闭所有 shell 与 socket
}
```

帧（与 dsh-ssh 完全一致）：
```ts
// host -> client
{ type:'ready', alias, sessionId }
{ type:'output', data }
{ type:'exit', code, error? }
// client -> host
{ type:'input', data }
{ type:'resize', cols, rows }
{ type:'detach' }
{ type:'close' }
```
（`auth_prompt` / `auth_response` 也实现，用于 keyboard-interactive 认证的主机 —— `ssh2` 的 `tryKeyboard` 回调。）

实现要点：
- `conn.shell({ term:'xterm-256color', cols, rows, env:{ TERM:'xterm-256color' } }, cb)`，`stream.on('data')` → 广播 output；`stream.on('close')` → `exit` 帧。
- 背压：`conn.bufferedAmount > HIGH` → `stream.pause()`；所有连接都 `< LOW` → `stream.resume()`。
- 滚动缓冲：按 UTF-8 字节累计，超 `MAX_BUFFER_BYTES` 从头部丢整块。
- resize：`stream.setWindow(rows, cols, 0, 0)`。
- 关闭：无 socket 起 `IDLE_MS` 定时器；有 socket 附着则清除。

### 8.3 前端终端（`src/client/40-terminal.js`）

不引 xterm.js。自己实现：

```js
class MiniTerm {
  // <pre> 内容累积 + 虚拟滚动（只保留末尾 2000 行）
  // 隐藏 <textarea> 捕获输入
  // 控制序列处理：
  //   \x1b[<n>m        颜色/样式（只保留 0 重置 + 3x/9x 前景，其余丢弃）
  //   \x1b[K / \x1b[J   擦除行/屏（用 \r + 空格覆盖当前行）
  //   \x1b[<n>A/B/C/D   光标移动（退化成忽略，输出按追加）
  //   \b \r \n \t       正常处理
  //   \x1b]0;...\x07    OSC 标题（丢弃）
}
```

明确限制并写进 UI 提示条：**不支持全屏程序（vim/htop/top）的正确渲染**，适合 `ls` / `cat` / `tail` / `journalctl` / `systemctl status` / 脚本执行。要做全屏请用 dsh-ssh 的终端面板。

这是诚实取舍：自写解析器做不到完整 VT100，与其假装能用，不如明说边界。

---

## 九、文件管理规格

### 9.1 路由

```js
API.ls       = '/api/dsh-fleet-monitor/fs/ls'        // GET  ?alias=&path=
API.stat     = '/api/dsh-fleet-monitor/fs/stat'      // GET
API.mkdir    = '/api/dsh-fleet-monitor/fs/mkdir'     // POST
API.rename   = '/api/dsh-fleet-monitor/fs/rename'    // POST
API.delete   = '/api/dsh-fleet-monitor/fs/delete'    // POST
API.download = '/api/dsh-fleet-monitor/fs/download'  // GET  → 流
API.upload   = '/api/dsh-fleet-monitor/fs/upload'    // POST raw body → NDJSON 进度
```

### 9.2 路径校验

```js
export function resolveRemotePath(raw, roots) {
  if (!raw || raw.includes('\0')) throw new Error('invalid path')
  const p = posix.normalize('/' + raw.replace(/^\.\/+/, ''))
  if (p.includes('..')) throw new Error('path traversal is not allowed')
  const root = roots.find(r => p === r || p.startsWith(r.endsWith('/') ? r : r + '/'))
  if (root === undefined) throw new Error(`path outside allowed roots (${roots.join(', ')})`)
  return p
}
```
`roots` 默认 `['/']`（**登录用户自己的权限就是边界**，SSH 天然沙箱），配置项 `fsRoots` 可收紧成 `['/home', '/var/log']`。

> 说明：不限制成 home 是因为目标是运维（看 `/var/log`、`/etc/nginx`）；真正的边界是 SSH 账号权限，不是插件。收紧留给配置。

### 9.3 下载

```js
conn.sftp((err, sftp) => {
  const st = await stat(path)   // 先 stat 拿 size，写 content-length
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'content-disposition': `attachment; filename="${basename(path)}"`,
    'cache-control': 'no-store',
  })
  sftp.createReadStream(path).on('error', () => res.destroy()).pipe(res)
})
```
上限 `maxDownloadBytes`（默认 256 MB，配置项），超限 413。

### 9.4 上传（raw body + NDJSON 进度）

```js
// POST ?alias=&path=
res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' })
let received = 0
const ws = sftp.createWriteStream(path)
req.on('data', chunk => {
  received += chunk.length
  if (received > maxUploadBytes) { req.destroy(); fail('too large'); return }
  ws.write(chunk)
  if (Date.now() - lastEmit > 200) { lastEmit = Date.now(); emit({ type:'progress', received, total }) }
})
req.on('end', () => ws.end(() => emit({ type:'result', ok:true, received })))
```
前端用 `fetch` + `ReadableStream` 读 NDJSON 逐行更新进度条。

---

## 十、接口清单（最终）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/overview` | 快照（含 meta 合并、慢指标） |
| GET | `/status` | 只回计数，不含主机名 |
| GET | `/events` | SSE |
| GET | `/history` | `?alias&from&limit&res=raw\|5m` |
| POST | `/refresh` | 触发一轮 |
| GET/POST/DELETE | `/hosts` | 面板主机 CRUD |
| POST | `/test` | 单机连通性测试 |
| GET/POST/DELETE | `/meta` | 主机元数据 |
| GET/POST/PATCH/DELETE | `/services` | 探针 CRUD |
| GET | `/services/history` | `?id&limit` |
| GET/POST/PATCH/DELETE | `/alerts/rules` | 规则 CRUD |
| GET | `/alerts/events` | `?state&limit` |
| POST | `/alerts/silence` | 静默 |
| GET/POST/PATCH/DELETE | `/notify/channels` | 渠道 CRUD |
| POST | `/notify/test` | 发测试消息 |
| GET/POST/PATCH/DELETE | `/notify/groups` | 通知组 CRUD |
| GET/POST/PATCH/DELETE | `/tasks` | 任务 CRUD |
| POST | `/tasks/run` | 手动执行 |
| GET | `/tasks/runs` | `?taskId&limit` |
| GET | `/fs/ls` `/fs/stat` | 浏览 |
| POST | `/fs/mkdir` `/fs/rename` `/fs/delete` | 变更 |
| GET | `/fs/download` | 下载流 |
| POST | `/fs/upload` | 上传流 |
| WS | `/terminal` | 终端 |

路由数 7 → 24（`/fs/*` 与 `/notify/*` 各自共用一个 handler 按 method 分发，实际 `register` 次数约 16）。

**每条路由都必须先 `guard(req, res, methods)`**，`status` 与 `notify/test` 额外要求 POST。

---

## 十一、agent 工具（最终 7 个）

| 工具 | 参数 | 并发安全 |
|---|---|---|
| `fleet_snapshot` | filter, limit | true |
| `fleet_history` | alias, minutes, limit | true |
| `fleet_alerts` | state(firing/all), limit | true |
| `fleet_services` | onlyDown(bool) | true |
| `fleet_tasks` | limit | true |
| `fleet_run_task` | id | false |
| `fleet_refresh` | — | false |

每个都必须有 `output: { schema, render }`（缺了整条 entry 会回滚 —— 已经踩过）。

---

## 十二、实施顺序（每步做完即可验收）

> 进度：**步骤 1–10 全部完成**（测试 51 → 184 条全绿）。每一步都在真实宿主里用真机数据验收过（服务探针 25/25、告警通知 21/21、定时任务 19/19、终端 shell 实跑 `echo` 回显、文件管理 24/24 含上传下载往返、7 个 agent 工具全部注册并渲染真实数据）。

### 步骤 1 — 数据层与迁移（0.5 天）✅
`store-schema.js` + `store.js` 新方法 + `sample` ALTER + `sample_5m` + `daily_stat` 写入。
**验收**：旧库直接打开不报错，`PRAGMA table_info(sample)` 有 5 个新列；跑两轮采集后 `sample_5m` 有行。
**实测**：旧库 `migratedColumns` 报出 5 列并保留旧行数据；新建库返回 `[]`（不误报）；两轮采集后 `sample_5m` 1 行、`daily_stat` 2 行（`samples=2 up=2`）。JSON 后端同接口实现，`store.test.mjs` 的两个后端跑同一套断言。

### 步骤 2 — 慢探针与详情（0.5 天）✅
`SLOW_PROBE_SCRIPT` + `parseSlowProbe` + 调度 + 详情抽屉四块。
**验收**：有硬件的主机详情里出现温度/GPU；分区表列出 ≥3 个挂载点；无 GPU 主机不报错。
**实测**：t003 一轮 2209 ms，17 个监听端口、`/` 与 `/boot/efi` 两个分区、`eth0` 累计收发;云 VM 无热区时温度显示「无」而不是报错；`parseSlow` 用 `slow_ok !== '1' || slow_done !== '1'` 判定完整性（脚本在 `fi` 之后无条件打印 `slow_done`，只判它会把 FreeBSD 当成"零传感器的健康机器"）。

### 步骤 3 — 元数据与分区骨架（0.5 天）✅
`host_meta` + `/meta` + 6 分区导航 + 分组/到期徽标。
**验收**：给 3 台主机设分组与到期日，刷新后保持；分组筛选正确。
**实测**：`/meta` POST/GET/DELETE 与 `/detail` 在真实宿主全通；中文显示名/分组/标签/备注往返无损（`tags` 始终是数组）；未知 alias 的 DELETE 与 detail 都是 404，PUT 405；分区导航用 hash 路由，`client.test.mjs` 用 React 替身静态渲染断言了 6 个 tab、默认落在总览、以及表格只在「服务器」分区出现。

### 步骤 4 — 服务监控（1 天）✅
`services.js` + 2 表 + 4 路由 + 「服务」分区。
**验收**：3 个探针（https / tcp / 不可达）60 秒内出 30 格；证书天数正确。
**实测**：真实宿主里 5 个探针一次建成（http-public / http-keyword / tcp-host-ui / tcp-closed / icmp-loop），`http-public ok=true latency=124 status=200 cert=73`、`http-keyword` 因正文不含关键字判失败、`tcp-host-ui ok=true latency=1`、`tcp-closed` 报 `ECONNREFUSED`、`icmp-loop ok=true latency=1`；`/services/results` 19 条、`limit=1` 正确截断、删除后 404。25/25 断言通过。

### 步骤 5 — 告警与通知（1 天）✅
`alerts.js` + `notify.js` + 5 表 + 6 路由 + 「告警」分区 + 「设置」通知块。
**验收**：`cpu > 1%` 持续 60s → 2 分钟内 firing + 实际收到 webhook；恢复后 resolved。
**实测**：`_alert_check.mjs` 21/21 —— 自动挑一台在线主机（脚本从 `/overview` 里取，不写死）、建渠道/组/规则（cpu gt 0，`durationSec: 1`）、一轮 sweep 后事件 `firing` 且 `peak=1.10`、本地 hook 收到渲染后的正文 `触发 t002 e2e cpu above zero 1.1`；坏 metric 与坏 scope 均 400；静默返回 `silencedUntil`；删规则后通知停止。
**两个真 bug（真机验收暴露）**：非法 `scope.mode` 原本被静默默认成 `all`（一个错字把 1 台规则的告警扩到全机群），改成显式 400，且 `include` 空列表也 400；`PRESETS` 是数组而前端按对象取键，下拉显示成 `0 1 2 3`，改成 `presetList.find(item => item.id === key)`。

### 步骤 6 — 概览与在线率（0.5 天）✅
概览四卡 + 需要处理 + 24 小时在线率条。
**验收**：数据来自 `daily_stat`，与主机数一致。
**实测**：真实宿主 `/overview` 返回 `uptime.hours=24`、`measuredHosts=27`，机群条最近三格 `4% / 78% / 97%`（当前小时未满所以在补）；`t003` 单机同形。**实现与原文不同的一处**：24 小时条不用 `daily_stat`（天粒度，画不出小时格），改为 `/overview` 时从 `sample` 表按 `ts / 3600000` 分组计数 —— 每格 = 实际样本数 ÷ 该小时应有样本数（`3600000 / intervalMs`）。`daily_stat` 继续保留给"今日/本月流量"类统计与告警的月度流量指标用。没有样本的小时返回 `null` 而不是 0，面板画成空心格：插件当时没在采集，不是主机宕了。

### 步骤 7 — 定时任务（1 天）✅
`cron.js` + 2 表 + 3 路由 + 「任务」分区。
**验收**：`*/2 * * * *` 跑 `uptime`，两次后历史有记录；非法表达式返回 400。

### 步骤 8 — 终端（1.5 天）
`terminal.js` + upgrade + 前端 MiniTerm。
**验收**：`ls -la` / `cat /etc/os-release` 正确显示；`detach` 后 `session` 重连能回放；`exit` 帧正确。

### 步骤 9 — 文件管理（1 天）
`sftp.js` + 7 路由 + 浏览/下载/上传 UI。
**验收**：下载 10MB 文件校验 md5 一致；上传后远端 `ls -l` 大小一致；`../etc/passwd` 被拒。

### 步骤 10 — 工具与文档（0.5 天）✅
4 个新工具 + README 双语更新 + 兼容矩阵补测。
**验收**：`node --test` 全绿（预计 90+ 条）；7 个工具在宿主里 `register` 成功。

**实测**：7 个工具全部注册（`fleet_alerts, fleet_history, fleet_host, fleet_refresh, fleet_services, fleet_snapshot, fleet_tasks`），对着真机把每个 `execute` + `output.render` 都跑了一遍，无 NaN、无抛错；顺手抓出两个真 bug —— 探针工具读了 `probe.results` 而 `ServiceMonitor.list()` 报的是 `latest`/`grid`（真机上直接抛 `Cannot read properties of undefined`），百分比没有取整会把 `54.78847450691375%` 原样喂给模型。测试 184 条全绿。

总计约 **7.5 天**（单人，含测试与真机验证）。

---

## 十三、测试计划

| 文件 | 覆盖 | 预计条数 |
|---|---|---|
| `test/store.test.mjs` | 新表 CRUD、迁移幂等、5m 聚合、日聚合 | +8 |
| `test/probe.test.mjs` | slow 脚本无 bashism、空硬件静默、分区解析、GPU 解析 | +6 |
| `test/services.test.mjs` | 三种探针、超时、状态码匹配、关键字、环形缓冲裁剪 | +8 |
| `test/alerts.test.mjs` | 连续 N 轮、状态机三段、离线特例、no_data、冷却 | +10 |
| `test/notify.test.mjs` | 占位符替换、JSON/Form、合并抑制、失败不抛 | +6 |
| `test/cron.test.mjs` | 解析、nextRun（含跨月/闰年）、非法表达式、describe | +10 |
| `test/terminal.test.mjs` | 帧协议、滚动缓冲、背压、idle 回收（用假 `conn`） | +6 |
| `test/ws.test.mjs` | 握手 `Sec-WebSocket-Accept` 正确、单帧/126/127 长度、掩码解码、分片重组、close 码回传、超长帧拒绝 | +7 |
| `test/sftp.test.mjs` | 路径校验（..、根白名单、空路径）、大小上限 | +6 |
| `test/routes.test.mjs` | 新路由鉴权、method 分发、404、alias 不可改 400 | +13 |

预计新增 ~80 条，总数 51 → 131。

---

## 十四、不做清单（与理由）

| 不做 | 理由 |
|---|---|
| 多用户 / RBAC / JWT / OAuth2 | DSH 本地单用户；loopback fence 是唯一必要边界 |
| 前台主题 / WAF / MCP OAuth | 无"对外站点"场景 |
| DDNS 记录管理 | 需要用户 DNS 商凭据。改为「公网 IP 变化通知」（P2 附带，只读 + 通知） |
| NAT 端口转发展示 | 纯静态展示，无可执行动作 |
| 服务器归属转移 | 多用户 SaaS 的机器过户场景 |
| 完整 VT100 / 全屏 TUI | 自写解析器做不到；明确提示用 dsh-ssh 终端 |
| 多卡 GPU 逐卡明细 | 只存第一块卡的 util + 内存（`MemoryTotal>0` 才有意义） |
| 集群执行编排（一次广播到多机并汇总） | 已由 `cron_task` 的 cover=all 覆盖 |

---

## 十五、风险与既定对策

| 风险 | 对策 |
|---|---|
| 自写 WebSocket 有 bug | 只做终端需要的最小帧集；`test/ws.test.mjs` 7 条覆盖握手/长度/掩码/分片/close；任何解析异常 → `conn.close(1002)` 并 `console.warn`，绝不 throw（throw 会被宿主 `logger.warn` 后 destroy socket，看起来像"终端连不上"） |
| 旧库 ALTER 失败 | 全部 `try/catch` + `PRAGMA table_info` 探测；失败降级到 JSON 后端并如实上报 |
| 慢探针拖慢 | 独立并发 2 / 超时 8s / 周期 5min；失败只记 `lastSlowError` |
| 告警风暴 | 三段状态机 + 冷却 + 单轮 >5 条合并 |
| 终端持有 shell 不放 | idle 10min 回收 + 插件卸载时 `registry.dispose()` |
| 上传占满磁盘 | `maxUploadBytes` 默认 64 MB + 前置 `content-length` 检查 |
| cron 时区 | 一律用宿主本地时区，UI 明示"按本机时区" |
| 新建的 tool 漏 `output` | 已经踩过：会让整条 entry 回滚、所有路由消失、面板全 401。`test/mount.test.mjs` 已有断言；步骤 10 新增的 4 个工具必须在同一次改动里补测试 |
| 新增 `inject` 需求 | 终端用 `registerUpgrade` **不需要**加 inject（`webServer` 已包含）；不要为了"看起来完整"去加不存在的服务名，加了会让 `ctx.xxx` 解析失败、apply 崩、整条 entry 回滚 |

---

## 十六、开始条件

无外部依赖待确认：`ssh2` 已在 profile，WebSocket 自写，cron 自写，其余全是 Node 内置（`node:sqlite`、`node:http`、`node:net`、`node:crypto`、`node:https`、`node:child_process`、`node:fs`）。**`package.json` 的 `dependencies` 保持只有 `@deepseek-ai/schemastery` 与 `ssh2` 两项**，不新增。

步骤 1 可以直接动手。

---

## 十七、第二次审视的修订汇总（本轮改了什么）

按"会直接导致跑不通 / 会导致数据错"排序：

| # | 原方案 | 改成 | 性质 |
|---|---|---|---|
| 1 | 终端用宿主已装的 `ws` | 自写 `lib/ws.js`（RFC 6455 子集） | **会崩**：`ws` 从仓库 realpath 解析不到（实测 `MODULE_NOT_FOUND`），apply 阶段 import 失败 → 整条 entry 回滚 → 面板全 401，正是刚修完那个故障 |
| 2 | `pool.exec(host, cmd, ms)` | 新增 `pool.run()` + `pool.connectionFor()` | **会崩**：`pool` 只有 `acquire/release/probe/reap/dispose`，`exec` 在 `PooledConnection` 上 |
| 3 | upgrade 里"沿用 loopback guard" | 手写 403 拒绝 + 说明宿主不校验 | **安全**：宿主 `registerUpgrade` 只按 path 匹配就调 handler，不做任何校验；WS 不受同源策略约束，漏了就是任意网页能开 shell |
| 4 | slow 数据写 `sample`（加 5 列） | slow 落 `host_hardware`，fast 写 `sample` 时回填 | **数据错**：`(alias,ts)` 主键在 30s/300s 同相位时必然撞，互相覆盖成 null |
| 5 | `daily_stat` 流量 `max(0, cur-prev)` | 加"`prev` 必须在 2×interval 内"前置 | **数据错**：主机离线三天回来，差值把三天流量全记到今天 |
| 6 | `no_data` 当作"不 breach" → `consecutive=0` | 冻结状态，不归零 | **通知震荡**：一次 SSH 超时就让 firing 判 resolved，下一轮又 firing |
| 7 | `cooldown` 未定语义 | 只在 firing 入口生效，resolved 不受限 | 避免实现成"每轮都发" |
| 8 | `daily_stat.day` 用 `toISOString().slice(0,10)` | `toLocaleDateString('sv')` | 东八区 08:00 前的"今天"会算成昨天 |
| 9 | 允许改 alias | `alias` 不可变 + `host_meta.display_name` | 改 alias 会让 `node`/`sample`/`host_meta` 三表历史全失联 |
| 10 | `cron_run` 只存 3 台输出 | 存全部，整体限 8KB | 用户看第 20 台的输出看不到 |
| 11 | 温度无条件 `/1000` | 按量级判断（`>=1000` 才除） | 少数平台直接给摄氏度，会全变 0 |
| 12 | 服务探针 `skip_aliases` | 删列 | 宿主侧执行，这台"跳过"语义无意义 |
| 13 | `certDaysLeft` 未提 TLS 细节 | `rejectUnauthorized:false` + SNI | 自签证书站点取不到证书，到期监控直接失效 |
| 14 | 服务探针/通知可打内网 —— 未说明 | 写进 README 的安全边界一节 | 这是特性（内网服务要监控），但必须讲清信任边界 |
| 15 | `client.js` 拆模块只说"拼接" | 定死命名约定（除 preamble 外只用 `function`） | 纯文本拼接下顶层 `const` 重名 = 整个 bundle `SyntaxError` |
| 16 | 无空态引导 | 三处引导 + 一键推荐规则 | 装完看到 6 个空分区，不知道怎么开始 |
| 17 | 分区表伪文件系统白名单只有 3 种 | 补 `devfs`/`efivarfs`/`autofs`/`squashfs` | 会把 `/sys/firmware/efi` 之类算成磁盘 |
| 18 | 挂载点解析未提限制 | 写进 README 已知限制 | 含空格的挂载点会截断，为此加 `substr` 反而更脆 |
| 19 | 风险表"`ws` 未安装" | 换成"自写 WS 有 bug" | 依赖已去掉，那条风险不存在 |
| 20 | 测试 123 条 | 131 条（新增 `test/ws.test.mjs` 7 条、routes +1） | 跟着改动走 |

**仍然没变的三个大决策**（复核后确认正确）：采集分 fast/slow 两级、存储 24h 全精度 + 5m 保 30 天、服务探针放宿主侧执行。

**工期不变**：7.5 天。第 1 项（自写 ws）落在步骤 8 的 1.5 天里，那一步从"接 ws"变成"写 ws + 接终端"，但少了依赖排查，实际持平。

---

## 十八、实施中挖出来的坑（都是真机撞出来的，不是设想）

前面十七节是纸面复核，这一节是十步走完之后真机打出来的。每条都改在代码里了，留档是因为它们都属于"单测永远抓不到"那一类。

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 面板能渲染，但每个接口 401 | tool 少 `output { schema, render }` → `ctx.tools.register` 抛错 → cordis 把整条 entry 的效果（含已注册的路由）全部回滚 | 三个（后来七个）tool 全部声明 `output`；`test/mount.test.mjs` 加断言，注释写明"缺 output 会拆掉本插件的每一个 effect" |
| 2 | 设置页改了等于没改 | `volatile()` 字段给的是**引用**（`{ get() }`），不是值，`Number(对象)` 全是 NaN | `readField()` 统一解引用 |
| 3 | 30 台主机磁盘全是 0% | `df` 的过滤条件 `dev ~ /^\/(proc\|sys\|dev)/` 拿**设备路径**判断，而真实磁盘本来就叫 `/dev/vda1`，全被当伪文件系统丢掉 | 改成按**挂载点**（`$7`）过滤 |
| 4 | 面板「刷新」按钮 400，body 为空 | 宿主 `handle().catch()` 兜底写裸 400 并吞堆栈；真实原因是一台主机的 `date +%s%3N` 被 busybox 当成 `%s%N`，写入 19 位纳秒，`node:sqlite` 拒绝转换超过 `MAX_SAFE_INTEGER` 的整数 → `hardwareFor` 抛 → 整轮 sweep 挂 | (1) `parseSlow` 用 `epochMillis()` 按量级归一化；(2) `hardwareFor` 读 `CAST(ts AS REAL)` + `toMillis()` 兜底；(3) `refresh` handler 保留 `500 {error, stack}`，因为宿主不写日志时这是唯一诊断手段 |
| 5 | 定时任务真机跑 `hostname` 成功却报失败 | `pool.run` 返回 `code`，代码读 `exitCode` → 永远 undefined。**单测桩也写成了 `exitCode`，所以桩照着实现错** | 读 `result.code`；桩同步改 |
| 6 | 一个探针创建失败连带 5 个 FAIL | 冒烟脚本读错响应形状（`POST /services` 回 `{probe}`，`/services/results` 回 `{id, results}`） | 修脚本，不是修路由 —— 路由是对的 |
| 7 | 服务监控下拉里显示 `0 1 2 3` | `presets` 是数组，前端按对象取键 | `Array.isArray` + `find(item => item.id === key)` |
| 8 | 打错一个字的 scope 让 30 台全告警 | `readRuleInput` 把非法 `mode` 静默 round 成 `all` | 显式 400；`include` 空列表也 400 |
| 9 | 面板一打开「新建任务」弹窗就压住表格 | `TaskForm` 没有 `open` 判断 | 加 guard，**但必须放在所有 hook 之后**（否则开关对话框改变 hook 数量直接崩） |
| 10 | 终端开 30 秒后自己消失 | `terminalOpen` 是详情组件自己的 state，SSE 每 30 秒推快照 → 重挂载 → state 丢 | 提到 `FleetMonitorPage`（`terminalAlias`/`filesAlias` 同样处理） |
| 11 | 打开终端后第一次回车把面板关了 | 焦点留在刚才那个按钮上 | `TerminalView` 挂载后 `pre.focus()` |
| 12 | `test/ws.test.mjs` 挂住 20 分钟 | 脚手架用了 `node:net` 的 `createServer()` 监听 `'upgrade'` —— 那是 `http.Server` 的事件，裸 `net.Server` 永不触发 | 改 `node:http` |
| 13 | `fleet_services` 在真机上 `TypeError` | 读了 `probe.results`，而 `ServiceMonitor.list()` 给的是 `latest` + `grid` | 改字段名 |

**测试数**：51 → 184。**依赖**：零新增（`ws` 没有引入，`cron` 解析器与 WebSocket 服务端都是自写）。

