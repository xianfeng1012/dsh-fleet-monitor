# 上架指南 / Publishing

这份文档说明怎么把 `dsh-fleet-monitor` 放进 DSH 的插件市场。**结论先说**：DSH 的"市场"由两个独立清单组成，收录方式不一样。

| 清单 | 谁在维护 | 怎么进去 | 要不要审核 |
|---|---|---|---|
| **社区目录**（6000+ / 10000+ 条，dsh-m 默认开启） | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 提一个 PR，加一个 YAML 文件 | CI 机械检查 + 维护者读代码 |
| **精选清单**（装机必备 / 崔添翼精选 / iasi自研 / 腾讯轻量云专区 / 观察区） | [iasiv5/dsh-m](https://github.com/iasiv5/dsh-m) 的 `registry.json` | 改那个 JSON | 人工策展，比社区严格 |

社区目录的那份清单会被打成 npm 包 `dsh-plugin-catalog`，dsh-m 通过 jsdelivr / npmmirror / unpkg 拉它的 `plugins.json`。所以**进了 awesome 仓库 = 进了市场**，不需要单独联系谁。

---

## 0. 仓库里已经准备好的东西

| 文件 | 用途 | 状态 |
|---|---|---|
| `package.json` 的 `dsh.bundle.patch` | 声明「可被 `dsh plugin add` 安装」——这是**收录的硬门槛** | ✅ 已有 |
| `cordis.patch.yml` | 上面那一项指向的文件 | ✅ 已有 |
| `LICENSE`（MIT） | 开源标识 | ✅ 已有 |
| `README.md` / `README.zh.md` | GitHub 与 npm 页面 | ✅ 已有 |
| `screenshots.json` + `assets/*.png` | 市场详情页的 AppStore 式截图（1–8 张） | ✅ 已有 6 张 |
| `icon.svg` | 侧边栏图标（市场卡片不用 SVG，见下） | ✅ 已有 |

截图已脱敏：所有 IPv4 都换成了 `192.0.2.x` 文档保留段，主机别名跟着改写，左侧工作区栏做了模糊。**发布前请再看一遍这几张图**，确认没有你不希望公开的内容。

---

## 1. 发布前必须替换的三处占位符

`package.json` 里现在写的是 `GITHUB_OWNER`：

```jsonc
"repository": { "url": "git+https://github.com/GITHUB_OWNER/dsh-fleet-monitor.git" },
"homepage": "https://github.com/GITHUB_OWNER/dsh-fleet-monitor#readme",
"bugs": { "url": "https://github.com/GITHUB_OWNER/dsh-fleet-monitor/issues" }
```

把三处 `GITHUB_OWNER` 换成你的 GitHub 用户名。

这一项不是可选的：awesome 列表靠 `repository` 字段把 npm 包和仓库关联起来，字段对不上，两边不会被认成同一个项目（也拿不到下载量排序）。规则原文：

> The published package's `repository` field must point back at the repository listed here, or the two are not linked.

---

## 2. 推到 GitHub

仓库已经 `git init` 过（`main` 分支，有提交历史）。还缺 remote：

```powershell
cd "E:\claude-project\termius导出账号\dsh-fleet-monitor"

# 先在 GitHub 上建一个空仓库 dsh-fleet-monitor（不要勾 README / .gitignore / LICENSE）
git remote add origin https://github.com/<你的用户名>/dsh-fleet-monitor.git
git add -A
git commit -m "feat: multi-host SSH monitoring panel, service probes, alerts, tasks, terminal, files"
git push -u origin main
```

推完在仓库页面加两个东西（都影响收录）：

1. **Topics**：加上 `dsh-plugin`（收录要求里明确写了，CI 不查但维护者会看）。顺手加 `dsh`、`deepseek-harness`、`ssh`、`monitoring`。
2. **仓库要满 1 天**才符合年龄门槛。刚建就提 PR 会被 CI 挡住——这一项是自动检查的，等一天再提即可，重新提交不会有任何影响。

---

## 3. 发 npm（推荐，但不是收录前提）

好处：安装时跳过 `allowBuilds` 构建授权那一步；市场能显示下载量。

```powershell
# 本机没有 npm，只有 pnpm
& "C:\Users\xianf\AppData\Roaming\npm\pnpm.ps1" login --registry https://registry.npmjs.org
# 按提示在浏览器里完成登录，然后：
cd "E:\claude-project\termius导出账号\dsh-fleet-monitor"
& "C:\Users\xianf\AppData\Roaming\npm\pnpm.ps1" publish --registry https://registry.npmjs.org --no-git-checks
```

发布前确认（`pnpm publish` 会自己跑一遍 dry run 预览文件列表）：

- `name` 是 `dsh-fleet-monitor`，npm 上目前 404 空闲（同名 `dsh-server-monitor` 被别人占了，所以当初改的名）。
- `files` 只带 `lib`、`cordis.patch.yml`、两个 README、`LICENSE`、`icon.svg`、`screenshots.json`、`assets`。`test/` 和 `docs/` 不进包。
- `dependencies` 只有 `@deepseek-ai/schemastery` 和 `ssh2`；`@deepseek-ai/dsh` 与 react 在 `peerDependencies` 里——官方包声明成 peer 是列表的推荐做法，避免与宿主装两份。

---

## 4. 提 PR 到 awesome-dsh-plugin（= 进社区目录）

一个 PR 只加**一个文件**，路径与文件名按仓库命名：

```
data/plugins/<owner>__<repo>.yml
```

我们的是 `data/plugins/<你的用户名>__dsh-fleet-monitor.yml`，内容：

```yaml
url: https://github.com/<你的用户名>/dsh-fleet-monitor
name: <你的用户名>/dsh-fleet-monitor
category: tools
description:
  en: 'Multi-host SSH monitoring in the sidebar: agentless metrics and hardware inventory over the SSH credentials you already have, plus HTTP/TCP/ICMP probes, alert rules with HTTP notifications, cron tasks, an interactive shell, SFTP file browsing and seven read-only agent tools.'
  zh: '侧边栏里的多机 SSH 监控：复用已有 SSH 凭据做无 agent 采集（CPU、内存、磁盘、网络、负载，以及温度、GPU、监听端口、分区、网卡），外加 HTTP/TCP/ICMP 服务探针、告警规则与 HTTP 通知、定时任务、交互式终端、SFTP 文件浏览和七个只读 agent 工具。'
```

几点说明：

- **`description.en` 是唯一必填的字段**，`zh` 写不了可以不写，维护者会补。
- 描述里含 `: `（冒号 + 空格）时**必须加引号**，否则 YAML 会把它当成嵌套键——上面两条已经用单引号包住了。
- `name` 是列表里显示的链接文字，用 `owner/repo` 形式。
- 分类从这组里挑：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`。
  - 首选 **`tools`**（Tools & Capabilities）：它是一套能力扩展，不是 UI 装饰。
  - 备选 **`dev`**（Development & Runtime）：如果你觉得它更偏运维工具。
  - 选得不够准不会被打回，维护者会直接改。
- **一个 PR 最多 3 条**。我们只有 1 条，没问题。
- 不要手工编辑两个 README——它们由 `data/plugins/*.yml` 生成，合并后自动重建。PR 只碰你自己那个文件。

PR 描述可以照这个写：

> Adds `dsh-fleet-monitor`: multi-host SSH monitoring for the DSH web GUI.
>
> - Agentless: reads host inventory from `dsh-ssh.json` and `~/.ssh/config`, then collects over SSH itself — nothing to install on the targets.
> - Sidebar panel with six sections (overview / servers / services / alerts / tasks / settings), per-host hardware inventory from a slower sweep (temperature, GPU, listening ports, per-mount disk, per-NIC traffic), 24-hour availability strips, WebSocket terminal, SFTP file browser.
> - 185 tests, zero-build (plain ESM, no bundler), two runtime dependencies (`@deepseek-ai/schemastery`, `ssh2`).
> - All routes are loopback-fenced; credentials are never returned by the API and never stored by the plugin.
>
> `package.json` declares `dsh.bundle.patch`, so it installs with `dsh plugin add dsh-fleet-monitor`.

---

## 5. 提精选（dsh-m 的 `registry.json`，可选）

进了社区目录之后，如果想让它在 dsh-m 里排在「装机必备 / 观察区」这类策展分区，需要改 [iasiv5/dsh-m](https://github.com/iasiv5/dsh-m) 的 `registry.json`。条目形状（照抄现有条目）：

```json
{
  "id": "dsh-fleet-monitor",
  "name": "机群监控 Fleet Monitor",
  "description": "多机 SSH 监控面板：无 agent 采集、硬件清单、服务探针、告警与 HTTP 通知、定时任务、终端与文件管理。",
  "category": "watchlist",
  "tags": ["监控", "SSH", "运维"],
  "verified": ["0.2.2-rc.1"],
  "source": "npm",
  "npm": "dsh-fleet-monitor",
  "github": "<你的用户名>/dsh-fleet-monitor",
  "homepage": "https://github.com/<你的用户名>/dsh-fleet-monitor"
}
```

`verified` 是「在哪些宿主版本上验证过」——我们只在 **0.2.2-rc.1** 上真机跑过，就只写这一个，别写没测过的。这一项是精选清单最有价值的部分，写假了以后会出事。

精选是人工策展，被接受的概率远低于社区目录。**建议先只做第 4 步**，等社区目录里跑一段时间、有真实用户反馈了再提精选。

---

## 6. CI 会查什么

按顺序：

1. **条目数 ≤ 3**（最先查，早于任何网络请求）。
2. **`dsh.bundle` manifest**——从你仓库的 `package.json` 读。只声明 `dsh.client` 是最常见的被拒原因，我们两样都有。
3. **仓库满 1 天**。
4. **`awesome-lint`** 与站点构建：双语一致性、分隔符、日期、截图。

失败会明确说改什么，在同一个分支推修复即可，不用重开 PR。

## 7. 维护者会读代码核对描述

规则原文：

> **The description must be accurate.** It is read as a claim about your plugin, and it is checked against your code. If you write "46 tools across six domains", there should be 46 tools and six domains; if you name a command or an API, it should exist.

所以上面那条描述里每一个名词都必须是真能点出来的东西。逐条对照：

| 描述里的说法 | 代码里的位置 |
|---|---|
| "agentless metrics" | `lib/probe.js` 的 POSIX sh 脚本，纯 `/proc` + `df` + `ss`，不在目标机留任何文件 |
| "hardware inventory" | `lib/probe-slow.js`：`/sys/class/thermal`、`nvidia-smi`、`ss -lntu`、`df -kPT`、`/proc/net/dev` |
| "HTTP/TCP/ICMP probes" | `lib/services.js`，`PROBE_HTTP=1 / PROBE_TCP=2 / PROBE_ICMP=3` |
| "alert rules with HTTP notifications" | `lib/alerts.js`（19 个指标）+ `lib/notify.js`（通用 HTTP 模板，4 个预置） |
| "cron tasks" | `lib/cron.js`（五字段解析）+ `lib/tasks.js` |
| "an interactive shell" | `lib/terminal.js` + `lib/ws.js`（自写 RFC 6455，不依赖 `ws`） |
| "SFTP file browsing" | `lib/fs.js` |
| "seven read-only agent tools" | `lib/tools.js`：`fleet_snapshot` / `fleet_history` / `fleet_refresh` / `fleet_host` / `fleet_services` / `fleet_alerts` / `fleet_tasks` |

⚠️ 数字类声明最容易被核对。`lib/tools.js` 的 `makeTools()` 在服务探针与告警引擎存在时注册 7 个工具、缺失时降到 5 个（这是条件注册，不是数量对不上）。描述里写 "seven"，因为核心宿主上跑的确实是七个。

---

## 8. 发布前自检

```powershell
cd "E:\claude-project\termius导出账号\dsh-fleet-monitor"

# 1. 全绿（当前 185 条）
& "C:\Program Files\nodejs\node.exe" --test "test/**/*.test.mjs"

# 2. 语法
Get-ChildItem lib\*.js | ForEach-Object { & "C:\Program Files\nodejs\node.exe" --check $_.FullName }

# 3. 仓库里不能出现真实主机地址（应输出 0）
Select-String -Path lib\*.js,test\*.mjs,README*.md -Pattern '\b(\d{1,3}\.){3}\d{1,3}\b' |
  Where-Object { $_.Line -notmatch '192\.0\.2\.|10\.0\.0\.|127\.0\.0\.1|0\.0\.0\.0|1\.2\.3\.4|192\.168\.1\.1' } |
  Measure-Object | Select-Object -ExpandProperty Count

# 4. 凭据类文件不在仓库里（应输出空）
git ls-files | Select-String -Pattern 'dsh-ssh\.json|\.key$|\.pem$|id_rsa|id_ed25519|\.sqlite'

# 5. 打包预览（不会真的发）
& "C:\Users\xianf\AppData\Roaming\npm\pnpm.ps1" pack --dry-run
```

清单：

- [ ] `package.json` 三处 `GITHUB_OWNER` 已替换
- [ ] `dsh.bundle.patch` 存在且 `cordis.patch.yml` 能解析
- [ ] 描述里的工具数量与 `lib/tools.js` 一致（核心宿主上 7 个）
- [ ] 截图看过了，没有真 IP / 真实项目名
- [ ] GitHub 仓库建好、推上去、加了 `dsh-plugin` topic
- [ ] 仓库满 1 天再提 PR
- [ ] PR 只加 `data/plugins/<owner>__dsh-fleet-monitor.yml` 一个文件
- [ ] yml 里 `description.en` 与代码一致（尤其数字）
- [ ] 含 `: ` 的行加了引号
