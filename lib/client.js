/**
 * dsh-fleet-monitor — browser half.
 *
 * Hand-written, zero-build client bundle. The host loads this file with
 * `window.__ModuleLoader__.load`, so the factory receives the host's own
 * `require` and returns a module object with `apply` and `inject`.
 *
 * The panel is a fleet console: live table/card views, per-host history drawn as
 * inline SVG, and full host management (add, edit, delete, test) for the hosts
 * this plugin owns. Imported hosts (dsh-ssh.json, ~/.ssh/config) are shown
 * read-only because another tool owns those files.
 *
 * @module dsh-fleet-monitor/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-fleet-monitor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const ReactModule = require('react')
    const React = ReactModule.useState === undefined ? (ReactModule.default ?? ReactModule) : ReactModule
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'dsh-fleet-monitor'
    const API_BASE = '/api/dsh-fleet-monitor'
    const PANEL_ID = 'fleet-monitor'

    /** Sidebar order: after SSH (40), so the two server surfaces sit together. */
    const PANEL_ORDER = 50

    // ── copy ────────────────────────────────────────────────────────────────

    const zh = {
      'entry.label': '机群监控',
      'page.title': '机群监控',
      'page.subtitle': '通过 SSH 采集 dsh-ssh、~/.ssh/config 以及本面板添加的主机',
      'nav.overview': '总览',
      'nav.servers': '服务器',
      'nav.services': '服务监控',
      'nav.alerts': '告警',
      'nav.tasks': '定时任务',
      'nav.settings': '设置',
      'overview.alerts': '正在告警',
      'overview.offline': '离线主机',
      'overview.quiet': '当前没有告警。',
      'overview.uptimeHead': '在线情况',
      'overview.fleetHead': '机群在线率',
      'overview.fleet24': '近 24 小时在线率',
      'overview.noSamples': '无采集',
      'overview.fleetHead': '机群概况',
      'overview.memTotal': '内存合计',
      'overview.diskTotal': '磁盘合计',
      'pending.title': '即将接入',
      'pending.body': '数据层与后端路由已经就位，界面在下一步接上来。',
      'task.add': '添加任务',
      'task.newTask': '新建任务',
      'task.editTask': '编辑任务',
      'task.list': '任务',
      'task.emptyTitle': '还没有定时任务',
      'task.emptyBody': '定时任务在到点时通过 SSH 在目标主机上执行一条命令，并保留每台主机自己的退出码与输出尾部。',
      'task.schedule': '执行计划',
      'task.command': '命令',
      'task.commandHint': '命令经登录 shell 在远端执行，原样传递，不做转义。',
      'task.nextRun': '下次运行',
      'task.lastRun': '上次运行',
      'task.never': '还没跑过',
      'task.runNow': '立即执行',
      'task.running': '执行中…',
      'task.busy': '另一个任务正在执行，稍后再试。',
      'task.history': '运行历史',
      'task.noHistory': '还没有运行记录',
      'task.cover': '作用范围',
      'task.scopeAll': '全部主机',
      'task.scopeInclude': '仅指定主机',
      'task.scopeExclude': '排除指定主机',
      'task.timeout': '超时（毫秒）',
      'task.enabled': '启用',
      'task.everyMinute': '每分钟',
      'task.everyNMinutes': '每 {n} 分钟',
      'task.hourly': '每小时整点',
      'task.hourlyAt': '每小时第 {m} 分',
      'task.dailyAt': '每天 {time}',
      'task.exitCode': '退出码 {code}',
      'task.failed': '失败',
      'task.ok': '成功',
      'task.hosts': '{n} 台主机',
      'task.duration': '耗时 {ms}',
      'settings.runtime': '运行状态',
      'settings.interval': '采集间隔',
      'settings.slowInterval': '硬件采集间隔',
      'settings.backend': '存储后端',
      'settings.keep': '历史保留',
      'settings.howto': '这些值存在插件自己的数据库里，覆盖 DSH 插件配置中的同名项，保存后立即生效、不需要重启。「恢复默认」会清掉全部覆盖。',
      'settings.sweep': '最近一轮',
      'settings.state': '采集状态',
      'settings.running': '运行中',
      'settings.stopped': '已停止',
      'settings.adjust': '可调整项',
      'settings.save': '保存',
      'settings.restore': '恢复默认',
      'settings.saved': '已保存，立即生效。',
      'settings.restored': '已恢复为 DSH 插件配置里的值。',
      'settings.saveFailed': '保存失败',
      'settings.unchanged': '没有改动。',
      'settings.pinned': '已覆盖',
      'settings.on': '是',
      'settings.off': '否',
      'settings.key.intervalMs': '采集间隔（毫秒）',
      'settings.key.slowIntervalMs': '硬件采集间隔（毫秒）',
      'settings.key.slowTimeoutMs': '硬件采集超时（毫秒）',
      'settings.key.execTimeoutMs': '命令执行超时（毫秒）',
      'settings.key.connectTimeoutMs': '连接超时（毫秒）',
      'settings.key.concurrency': '并发主机数',
      'settings.key.keep': '每台历史样本数',
      'settings.key.cpuAlertPct': 'CPU 告警阈值（%）',
      'settings.key.memAlertPct': '内存告警阈值（%）',
      'settings.key.diskAlertPct': '磁盘告警阈值（%）',
      'settings.key.announceToAgent': '向模型声明工具',
      'settings.key.excludeAliases': '排除的主机（逗号分隔）',
      'settings.key.fsRoots': '文件管理根目录（逗号分隔）',
      'settings.key.maxDownloadBytes': '下载上限（字节）',
      'settings.key.maxUploadBytes': '上传上限（字节）',
      'meta.title': '展示信息',
      'meta.displayName': '显示名',
      'meta.group': '分组',
      'meta.tags': '标签',
      'meta.note': '备注',
      'meta.expireAt': '到期日',
      'meta.price': '价格',
      'meta.bandwidth': '带宽 (GB)',
      'meta.hidden': '隐藏',
      'meta.hiddenHint': '在列表里折叠',
      'meta.edit': '展示信息',
      'services.add': '添加探针',
      'services.edit': '编辑探针',
      'services.note': '探针从本机发起，可监控内网地址',
      'services.emptyTitle': '还没有服务探针',
      'services.emptyBody': '添加一个 HTTP / TCP / ICMP 探针，就能看到它的可用性与延迟。',
      'services.never': '未运行',
      'services.up': '正常',
      'services.down': '失败',
      'services.cert': '证书 {days} 天',
      'services.noData': '无数据',
      'services.type1': 'HTTP',
      'services.type2': 'TCP',
      'services.type3': 'ICMP',
      'form.name': '名称',
      'form.type': '类型',
      'form.target': '目标',
      'form.interval': '间隔（秒）',
      'form.timeout': '超时（毫秒）',
      'form.expectStatus': '期望状态码',
      'form.expectKeyword': '期望关键字',
      'form.enabled': '启用',
      'form.metric': '指标',
      'form.threshold': '阈值',
      'form.op': '方向',
      'form.opGt': '高于阈值',
      'form.opLt': '低于阈值',
      'form.duration': '持续（秒）',
      'form.cooldown': '冷却（秒）',
      'form.group': '通知组',
      'form.scope': '作用范围',
      'form.scopeAll': '全部主机',
      'form.scopeInclude': '仅这些主机',
      'form.scopeExclude': '排除这些主机',
      'form.aliases': '主机别名（逗号分隔）',
      'metric.cpu': 'CPU',
      'metric.memory': '内存',
      'metric.swap': '交换分区',
      'metric.disk': '磁盘',
      'metric.load1': '负载 1 分钟',
      'metric.load5': '负载 5 分钟',
      'metric.load15': '负载 15 分钟',
      'metric.temperature_max': '最高温度',
      'metric.gpu': 'GPU 使用率',
      'metric.net_in_speed': '入站速率',
      'metric.net_out_speed': '出站速率',
      'metric.net_all_speed': '总速率',
      'metric.tcp_conn_count': 'TCP 连接数',
      'metric.udp_conn_count': 'UDP 连接数',
      'metric.process_count': '进程数',
      'metric.offline': '离线',
      'metric.transfer_in': '本月入站流量',
      'metric.transfer_out': '本月出站流量',
      'metric.transfer_all': '本月总流量',
      'alerts.add': '添加规则',
      'alerts.newRule': '新建告警规则',
      'alerts.editRule': '编辑告警规则',
      'alerts.rules': '告警规则',
      'alerts.events': '最近事件',
      'alerts.noEvents': '还没有触发过告警。',
      'alerts.emptyTitle': '还没有告警规则',
      'alerts.emptyBody': '规则随每轮采集评估：命中后按持续时间判定，恢复时再发一条。',
      'alerts.rounds': '轮',
      'alerts.cooldown': '冷却',
      'alerts.silence': '静默 1 小时',
      'alerts.firing': '告警中',
      'alerts.resolved': '已恢复',
      'alerts.off': '已停用',
      'alerts.noGroup': '不发通知',
      'alerts.hint': '告警随每轮采集评估，规则保存在本机数据库',
      'notify.title': '通知渠道',
      'notify.add': '添加渠道',
      'notify.newChannel': '新建通知渠道',
      'notify.emptyTitle': '还没有通知渠道',
      'notify.emptyBody': '用通用 HTTP 模板接入 Bark、Telegram、飞书、企微，或任何接受 POST 的地址。',
      'notify.url': '地址',
      'notify.method': '方法',
      'notify.bodyType': '请求体格式',
      'notify.headers': '请求头（JSON）',
      'notify.body': '请求体模板',
      'notify.verifyTls': '校验 TLS 证书',
      'notify.test': '发送测试',
      'notify.testOk': '已发送',
      'notify.testFail': '发送失败',
      'notify.group': '通知组',
      'notify.presets': '预置模板',
      'notify.placeholders': '可用占位符',
      'error.nameRequired': '请填写名称',
      'error.thresholdRequired': '请填写数值阈值',
      'error.channelRequired': '请填写名称和地址',
      'action.refresh': '刷新',
      'action.refreshing': '采集中…',
      'action.add': '添加服务器',
      'action.edit': '编辑',
      'action.delete': '删除',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.cancel': '取消',
      'action.test': '测试连接',
      'action.testing': '测试中…',
      'action.close': '关闭',
      'action.confirmDelete': '确认删除',
      'action.retry': '重试',
      'stat.total': '主机',
      'stat.online': '在线',
      'stat.alerting': '告警',
      'stat.offline': '离线',
      'filter.all': '全部',
      'filter.online': '在线',
      'filter.alerting': '告警',
      'filter.offline': '离线',
      'filter.owned': '本面板添加',
      'search.placeholder': '搜索别名、地址、系统、标签…',
      'sort.alias': '别名',
      'sort.cpu': 'CPU',
      'sort.mem': '内存',
      'sort.disk': '磁盘',
      'sort.latency': '延迟',
      'sort.status': '状态',
      'view.table': '表格',
      'view.cards': '卡片',
      'group.all': '全部分组',
      'group.none': '未分组',
      'col.alias': '主机',
      'col.status': '状态',
      'col.os': '系统',
      'col.cpu': 'CPU',
      'col.mem': '内存',
      'col.disk': '磁盘',
      'col.net': '网络 ↓/↑',
      'col.load': '负载',
      'col.latency': '延迟',
      'col.uptime': '运行时长',
      'col.tags': '标签',
      'col.actions': '操作',
      'status.online': '在线',
      'status.offline': '离线',
      'status.skipped': '跳过',
      'status.unknown': '未知',
      'source.panel': '面板',
      'source.manual': '设置',
      'source.dsh-ssh': 'dsh-ssh',
      'source.ssh-config': 'ssh_config',
      'empty.title': '还没有服务器',
      'empty.body': 'dsh-ssh 与 ~/.ssh/config 里已配置的主机会自动出现。也可以在这里手动添加一台。',
      'empty.action': '添加第一台服务器',
      'empty.filtered': '没有符合条件的主机',
      'files.open': '文件',
      'files.hide': '收起文件',
      'files.newDir': '新建目录',
      'files.upload': '上传',
      'files.download': '下载',
      'files.rename': '重命名',
      'files.renameTo': '重命名为',
      'files.loading': '正在读取…',
      'files.empty': '这个目录是空的',
      'files.hint': '走 SFTP，复用监控自己那条 SSH 连接。删除目录会连同里面的内容一起删，没有回收站。',
      'form.add': '添加服务器',
      'form.edit': '编辑服务器',
      'form.alias': '别名',
      'form.alias.hint': '留空则用 user@host:port',
      'form.host': '地址',
      'form.port': '端口',
      'form.user': '用户',
      'form.auth': '认证方式',
      'form.auth.key': '密钥',
      'form.auth.password': '密码',
      'form.auth.agent': 'ssh-agent',
      'form.keyPath': '私钥路径',
      'form.keyPath.hint': '例如 C:\\Users\\me\\.ssh\\id_ed25519',
      'form.passphrase': '私钥口令',
      'form.password': '密码',
      'form.group': '分组',
      'form.tags': '标签',
      'form.tags.hint': '逗号分隔',
      'form.note': '备注',
      'form.required': '必填',
      'test.ok': '连接成功',
      'test.fail': '连接失败',
      'test.running': '测试中…',
      'error.host': '请填写地址',
      'error.port': '端口需为 1-65535',
      'error.keyPath': '密钥认证需要私钥路径',
      'error.password': '密码认证需要密码',
      'error.load': '读取失败',
      'error.loadBody': '接口没有响应。宿主可能尚未加载插件，退出并重新打开 DSH 后再试。',
      'detail.title': '主机详情',
      'detail.system': '系统',
      'detail.kernel': '内核',
      'detail.cores': '核心',
      'detail.model': 'CPU 型号',
      'detail.swap': '交换分区',
      'detail.conn': 'TCP / UDP',
      'detail.procs': '进程',
      'detail.error': '最近错误',
      'detail.history': '近 1 小时',
      'detail.nothing': '暂无历史样本，等待下一轮采集。',
      'detail.cpu': 'CPU',
      'detail.mem': '内存',
      'detail.net': '网络 KB/s',
      'detail.hardware': '硬件',
      'terminal.open': '终端',
      'terminal.hide': '收起终端',
      'terminal.end': '结束会话',
      'terminal.failed': '终端连接失败',
      'terminal.hint': '交互式 shell。全屏程序（top、vim、htop）请改用 dsh-ssh 的终端。',
      'detail.temp': '温度',
      'detail.gpu': 'GPU',
      'detail.ports': '监听端口',
      'detail.hw_none': '无',
      'detail.hw_pending': '等待首次硬件采集（约 5 分钟）',
      'detail.hw_failed': '硬件采集失败',
      'detail.sensor_count': '{count} 个传感器',
      'footer.updated': '最后采集',
      'footer.backend': '存储',
      'footer.took': '耗时',
      'footer.problems': '采集问题',
      'imported.title': '导入的主机',
      'imported.hint': '来自 dsh-ssh / ~/.ssh/config，只读',
      'host.saved': '已保存',
      'host.removed': '已删除',
      'never': '从未',
    }

    const en = {
      'entry.label': 'Fleet Monitor',
      'page.title': 'Fleet Monitor',
      'page.subtitle': 'SSH-collected health for dsh-ssh, ~/.ssh/config, and hosts added here',
      'nav.overview': 'Overview',
      'nav.servers': 'Servers',
      'nav.services': 'Services',
      'nav.alerts': 'Alerts',
      'nav.tasks': 'Tasks',
      'nav.settings': 'Settings',
      'overview.alerts': 'Alerting',
      'overview.offline': 'Offline',
      'overview.quiet': 'Nothing is alerting.',
      'overview.uptimeHead': 'Availability',
      'overview.fleetHead': 'Fleet availability',
      'overview.fleet24': 'Availability, last 24 hours',
      'overview.noSamples': 'not collected',
      'overview.fleetHead': 'Fleet',
      'overview.memTotal': 'Memory total',
      'overview.diskTotal': 'Disk total',
      'pending.title': 'Coming next',
      'pending.body': 'The storage layer and routes are already in place; this view lands in the next step.',
      'task.add': 'Add task',
      'task.newTask': 'New task',
      'task.editTask': 'Edit task',
      'task.list': 'Tasks',
      'task.emptyTitle': 'No scheduled tasks yet',
      'task.emptyBody': 'A scheduled task runs one command over SSH when its time comes, and keeps each host\'s own exit code and output tail.',
      'task.schedule': 'Schedule',
      'task.command': 'Command',
      'task.commandHint': 'The command runs through the remote login shell, passed through verbatim and not escaped here.',
      'task.nextRun': 'Next run',
      'task.lastRun': 'Last run',
      'task.never': 'never run',
      'task.runNow': 'Run now',
      'task.running': 'Running…',
      'task.busy': 'Another task is already running; try again shortly.',
      'task.history': 'Run history',
      'task.noHistory': 'No runs recorded yet',
      'task.cover': 'Coverage',
      'task.scopeAll': 'All hosts',
      'task.scopeInclude': 'Only these hosts',
      'task.scopeExclude': 'All except these hosts',
      'task.timeout': 'Timeout (ms)',
      'task.enabled': 'Enabled',
      'task.everyMinute': 'every minute',
      'task.everyNMinutes': 'every {n} minutes',
      'task.hourly': 'hourly, on the hour',
      'task.hourlyAt': 'hourly, at minute {m}',
      'task.dailyAt': 'daily at {time}',
      'task.exitCode': 'exit {code}',
      'task.failed': 'failed',
      'task.ok': 'ok',
      'task.hosts': '{n} hosts',
      'task.duration': '{ms} ms',
      'settings.runtime': 'Runtime',
      'settings.interval': 'Fast interval',
      'settings.slowInterval': 'Hardware interval',
      'settings.backend': 'Storage backend',
      'settings.keep': 'History kept',
      'settings.howto': 'These live in the plugin database and override the same keys in the DSH plugin config. Saving applies them immediately; Restore defaults clears every override.',
      'settings.sweep': 'Last sweep',
      'settings.state': 'Sweeping',
      'settings.running': 'Running',
      'settings.stopped': 'Stopped',
      'settings.adjust': 'Adjustable',
      'settings.save': 'Save',
      'settings.restore': 'Restore defaults',
      'settings.saved': 'Saved. Applied immediately.',
      'settings.restored': 'Restored to the values in the DSH plugin config.',
      'settings.saveFailed': 'Could not save',
      'settings.unchanged': 'Nothing changed.',
      'settings.pinned': 'overridden',
      'settings.on': 'yes',
      'settings.off': 'no',
      'settings.key.intervalMs': 'Fast interval (ms)',
      'settings.key.slowIntervalMs': 'Hardware interval (ms)',
      'settings.key.slowTimeoutMs': 'Hardware timeout (ms)',
      'settings.key.execTimeoutMs': 'Command timeout (ms)',
      'settings.key.connectTimeoutMs': 'Connect timeout (ms)',
      'settings.key.concurrency': 'Hosts in parallel',
      'settings.key.keep': 'Samples kept per host',
      'settings.key.cpuAlertPct': 'CPU alert threshold (%)',
      'settings.key.memAlertPct': 'Memory alert threshold (%)',
      'settings.key.diskAlertPct': 'Disk alert threshold (%)',
      'settings.key.announceToAgent': 'Announce tools to the model',
      'settings.key.excludeAliases': 'Excluded hosts (comma separated)',
      'settings.key.fsRoots': 'File browser roots (comma separated)',
      'settings.key.maxDownloadBytes': 'Download limit (bytes)',
      'settings.key.maxUploadBytes': 'Upload limit (bytes)',
      'meta.title': 'Display',
      'meta.displayName': 'Display name',
      'meta.group': 'Group',
      'meta.tags': 'Tags',
      'meta.note': 'Note',
      'meta.expireAt': 'Expires',
      'meta.price': 'Price',
      'meta.bandwidth': 'Bandwidth (GB)',
      'meta.hidden': 'Hidden',
      'meta.hiddenHint': 'Collapse in the list',
      'meta.edit': 'Display info',
      'services.add': 'Add probe',
      'services.edit': 'Edit probe',
      'services.note': 'Probes run from this host, so an internal address is fine',
      'services.emptyTitle': 'No service probes yet',
      'services.emptyBody': 'Add an HTTP, TCP or ICMP probe to watch availability and latency.',
      'services.never': 'Never run',
      'services.up': 'Up',
      'services.down': 'Down',
      'services.cert': 'cert {days}d',
      'services.noData': 'No data',
      'services.type1': 'HTTP',
      'services.type2': 'TCP',
      'services.type3': 'ICMP',
      'form.name': 'Name',
      'form.type': 'Type',
      'form.target': 'Target',
      'form.interval': 'Interval (s)',
      'form.timeout': 'Timeout (ms)',
      'form.expectStatus': 'Expected status',
      'form.expectKeyword': 'Expected keyword',
      'form.enabled': 'Enabled',
      'form.metric': 'Metric',
      'form.threshold': 'Threshold',
      'form.op': 'Direction',
      'form.opGt': 'Above threshold',
      'form.opLt': 'Below threshold',
      'form.duration': 'For (seconds)',
      'form.cooldown': 'Cooldown (seconds)',
      'form.group': 'Notify group',
      'form.scope': 'Scope',
      'form.scopeAll': 'Every host',
      'form.scopeInclude': 'Only these hosts',
      'form.scopeExclude': 'Every host except',
      'form.aliases': 'Aliases (comma separated)',
      'metric.cpu': 'CPU',
      'metric.memory': 'Memory',
      'metric.swap': 'Swap',
      'metric.disk': 'Disk',
      'metric.load1': 'Load 1m',
      'metric.load5': 'Load 5m',
      'metric.load15': 'Load 15m',
      'metric.temperature_max': 'Hottest sensor',
      'metric.gpu': 'GPU utilisation',
      'metric.net_in_speed': 'Inbound rate',
      'metric.net_out_speed': 'Outbound rate',
      'metric.net_all_speed': 'Total rate',
      'metric.tcp_conn_count': 'TCP connections',
      'metric.udp_conn_count': 'UDP connections',
      'metric.process_count': 'Processes',
      'metric.offline': 'Offline',
      'metric.transfer_in': 'Inbound this month',
      'metric.transfer_out': 'Outbound this month',
      'metric.transfer_all': 'Total this month',
      'alerts.add': 'Add rule',
      'alerts.newRule': 'New alert rule',
      'alerts.editRule': 'Edit alert rule',
      'alerts.rules': 'Alert rules',
      'alerts.events': 'Recent events',
      'alerts.noEvents': 'Nothing has fired yet.',
      'alerts.emptyTitle': 'No alert rules yet',
      'alerts.emptyBody': 'Rules are evaluated on every sweep: a breach has to last the whole duration, and a recovery sends its own message.',
      'alerts.rounds': 'rounds',
      'alerts.cooldown': 'cooldown',
      'alerts.silence': 'Silence 1h',
      'alerts.firing': 'Firing',
      'alerts.resolved': 'Recovered',
      'alerts.off': 'Disabled',
      'alerts.noGroup': 'No notification',
      'alerts.hint': 'Rules are evaluated on every sweep and stored in the local database',
      'notify.title': 'Notification channels',
      'notify.add': 'Add channel',
      'notify.newChannel': 'New notification channel',
      'notify.emptyTitle': 'No channels yet',
      'notify.emptyBody': 'Point a generic HTTP template at Bark, Telegram, Lark, WeCom, or anything that accepts a POST.',
      'notify.url': 'URL',
      'notify.method': 'Method',
      'notify.bodyType': 'Body type',
      'notify.headers': 'Headers (JSON)',
      'notify.body': 'Body template',
      'notify.verifyTls': 'Verify TLS certificate',
      'notify.test': 'Send test',
      'notify.testOk': 'Sent',
      'notify.testFail': 'Send failed',
      'notify.group': 'Group',
      'notify.presets': 'Preset',
      'notify.placeholders': 'Placeholders',
      'error.nameRequired': 'A name is required',
      'error.thresholdRequired': 'A numeric threshold is required',
      'error.channelRequired': 'A name and a URL are required',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Collecting…',
      'action.add': 'Add host',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.cancel': 'Cancel',
      'action.test': 'Test',
      'action.testing': 'Testing…',
      'action.close': 'Close',
      'action.confirmDelete': 'Confirm delete',
      'action.retry': 'Retry',
      'stat.total': 'Hosts',
      'stat.online': 'Online',
      'stat.alerting': 'Alerting',
      'stat.offline': 'Offline',
      'filter.all': 'All',
      'filter.online': 'Online',
      'filter.alerting': 'Alerting',
      'filter.offline': 'Offline',
      'filter.owned': 'Added here',
      'search.placeholder': 'Search alias, address, OS, tags…',
      'sort.alias': 'Alias',
      'sort.cpu': 'CPU',
      'sort.mem': 'Memory',
      'sort.disk': 'Disk',
      'sort.latency': 'Latency',
      'sort.status': 'Status',
      'view.table': 'Table',
      'view.cards': 'Cards',
      'group.all': 'All groups',
      'group.none': 'Ungrouped',
      'col.alias': 'Host',
      'col.status': 'Status',
      'col.os': 'OS',
      'col.cpu': 'CPU',
      'col.mem': 'Memory',
      'col.disk': 'Disk',
      'col.net': 'Net ↓/↑',
      'col.load': 'Load',
      'col.latency': 'Latency',
      'col.uptime': 'Uptime',
      'col.tags': 'Tags',
      'col.actions': 'Actions',
      'status.online': 'online',
      'status.offline': 'offline',
      'status.skipped': 'skipped',
      'status.unknown': 'unknown',
      'source.panel': 'panel',
      'source.manual': 'settings',
      'source.dsh-ssh': 'dsh-ssh',
      'source.ssh-config': 'ssh_config',
      'empty.title': 'No hosts yet',
      'empty.body': 'Hosts already configured in dsh-ssh or ~/.ssh/config appear here automatically. You can also add one by hand.',
      'empty.action': 'Add the first host',
      'empty.filtered': 'No host matches this filter',
      'files.open': 'Files',
      'files.hide': 'Hide files',
      'files.newDir': 'New folder',
      'files.upload': 'Upload',
      'files.download': 'Download',
      'files.rename': 'Rename',
      'files.renameTo': 'Rename to',
      'files.loading': 'Reading…',
      'files.empty': 'This folder is empty',
      'files.hint': 'Runs over SFTP on the connection the monitor already holds. Deleting a folder takes its contents with it; there is no recycle bin.',
      'form.add': 'Add host',
      'form.edit': 'Edit host',
      'form.alias': 'Alias',
      'form.alias.hint': 'Defaults to user@host:port',
      'form.host': 'Address',
      'form.port': 'Port',
      'form.user': 'User',
      'form.auth': 'Auth',
      'form.auth.key': 'Key',
      'form.auth.password': 'Password',
      'form.auth.agent': 'ssh-agent',
      'form.keyPath': 'Private key',
      'form.keyPath.hint': 'e.g. ~/.ssh/id_ed25519',
      'form.passphrase': 'Key passphrase',
      'form.password': 'Password',
      'form.group': 'Group',
      'form.tags': 'Tags',
      'form.tags.hint': 'comma separated',
      'form.note': 'Note',
      'form.required': 'required',
      'test.ok': 'Connected',
      'test.fail': 'Connection failed',
      'test.running': 'Testing…',
      'error.host': 'Address is required',
      'error.port': 'Port must be 1-65535',
      'error.keyPath': 'Key auth needs a private key path',
      'error.password': 'Password auth needs a password',
      'error.load': 'Load failed',
      'error.loadBody': 'The API did not answer. The host half may not be loaded yet — quit and reopen DSH.',
      'detail.title': 'Host detail',
      'detail.system': 'System',
      'detail.kernel': 'Kernel',
      'detail.cores': 'Cores',
      'detail.model': 'CPU model',
      'detail.swap': 'Swap',
      'detail.conn': 'TCP / UDP',
      'detail.procs': 'Processes',
      'detail.error': 'Last error',
      'detail.history': 'Last hour',
      'detail.nothing': 'No samples yet — waiting for the next sweep.',
      'detail.cpu': 'CPU',
      'detail.mem': 'Memory',
      'detail.net': 'Network KB/s',
      'detail.hardware': 'Hardware',
      'terminal.open': 'Terminal',
      'terminal.hide': 'Hide terminal',
      'terminal.end': 'End session',
      'terminal.failed': 'Terminal connection failed',
      'terminal.hint': 'Interactive shell. For full-screen programs (top, vim, htop) use the dsh-ssh terminal instead.',
      'detail.temp': 'Temperature',
      'detail.gpu': 'GPU',
      'detail.ports': 'Listening ports',
      'detail.hw_none': 'none',
      'detail.hw_pending': 'Waiting for the first hardware sweep (about 5 minutes)',
      'detail.hw_failed': 'Hardware sweep failed',
      'detail.sensor_count': '{count} sensors',
      'footer.updated': 'Last sweep',
      'footer.backend': 'Store',
      'footer.took': 'Took',
      'footer.problems': 'Sweep problems',
      'imported.title': 'Imported hosts',
      'imported.hint': 'from dsh-ssh / ~/.ssh/config, read-only',
      'host.saved': 'Saved',
      'host.removed': 'Deleted',
      'never': 'never',
    }

    /** Fallback translator; overwritten by `ctx.locale.bind` when available. */
    let translate = (key) => zh[key] ?? key

    /**
     * Translate with `{name}` substitution.
     * @param key - dictionary key.
     * @param values - substitution table.
     */
    function t(key, values) {
      const raw = translate(key)
      if (values === undefined) return raw
      return String(raw).replace(/\{(\w+)\}/g, (match, name) => (
        values[name] === undefined ? match : String(values[name])
      ))
    }

    // ── formatting ─────────────────────────────────────────────────────────

    /** 1536 → "1.5 KB" (1024-based, one decimal under 100). */
    function fmtBytes(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—'
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
      let size = Math.abs(value)
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      const sign = value < 0 ? '-' : ''
      return `${sign}${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    /** Bytes/second in the unit a person reads. */
    function fmtRate(value) {
      return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${fmtBytes(value)}/s`
    }

    /** A percentage with one decimal, or an em dash. */
    function fmtPct(value) {
      return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`
    }

    /** Seconds → "12 天 3 小时" style compact uptime. */
    function fmtUptime(seconds) {
      if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      return `${minutes}m`
    }

    /** Milliseconds → "820 ms". */
    function fmtMs(value) {
      return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)} ms`
    }

    /** Epoch ms → local clock time. */
    function fmtTime(value) {
      if (value === null || value === undefined || !Number.isFinite(value)) return t('never')
      try {
        return new Date(value).toLocaleTimeString()
      } catch {
        return '—'
      }
    }

    /** The label of one hour cell: the hour it starts, local time. */
    function fmtHour(fromMs, index) {
      if (!Number.isFinite(fromMs)) return '—'
      try {
        const date = new Date(fromMs + index * 3_600_000)
        return `${String(date.getHours()).padStart(2, '0')}:00`
      } catch {
        return '—'
      }
    }

    /** Colour for a utilisation percentage: green, amber, red. */
    function utilColor(pct) {
      if (pct === null || pct === undefined || !Number.isFinite(pct)) return 'var(--fm-muted)'
      if (pct >= 90) return '#ef4444'
      if (pct >= 75) return '#f59e0b'
      return '#22c55e'
    }

    /** Colour for a node status. */
    function statusColor(status) {
      if (status === 'online') return '#22c55e'
      if (status === 'offline') return '#ef4444'
      if (status === 'skipped') return '#94a3b8'
      return '#94a3b8'
    }

    // ── api ────────────────────────────────────────────────────────────────

    /**
     * Fetch JSON, turning every failure into a thrown Error with a readable body.
     * @param path - path under the plugin's API base.
     * @param init - fetch options.
     */
    async function api(path, init) {
      const response = await fetch(`${API_BASE}${path}`, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const message = body !== null && typeof body.error === 'string'
          ? body.error
          : `HTTP ${response.status}`
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      return body
    }

    // ── hooks ──────────────────────────────────────────────────────────────

    /**
     * Live fleet snapshot.
     *
     * The stream carries every sweep, and an `error` on it falls back to polling:
     * `EventSource` does reconnect by itself, but its backoff can be half a
     * minute, and a panel that silently freezes during that window is worse than
     * a panel that polls.
     */
    function useFleet() {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [refreshing, setRefreshing] = useState(false)
      const pollRef = useRef(null)

      const load = useCallback(async () => {
        try {
          const body = await api('/overview')
          setSnapshot(body)
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => {
        let stream = null
        let stopped = false
        const startPolling = () => {
          if (pollRef.current !== null) return
          pollRef.current = setInterval(() => { void load() }, 30_000)
        }
        const stopPolling = () => {
          if (pollRef.current === null) return
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        void load()
        try {
          stream = new EventSource(`${API_BASE}/events`)
          stream.onmessage = (event) => {
            try {
              setSnapshot(JSON.parse(event.data))
              setError(null)
            } catch {
              // A malformed frame is not worth tearing the stream down for.
            }
          }
          stream.onerror = () => {
            if (!stopped) startPolling()
          }
        } catch {
          startPolling()
        }
        return () => {
          stopped = true
          stopPolling()
          if (stream !== null) stream.close()
        }
      }, [load])

      const refresh = useCallback(async () => {
        setRefreshing(true)
        try {
          const body = await api('/refresh', { method: 'POST', body: '{}' })
          setSnapshot(body)
          setError(null)
        } catch (failure) {
          setError(failure)
        } finally {
          setRefreshing(false)
        }
      }, [])

      return { snapshot, error, refreshing, refresh, reload: load }
    }

    /** Hosts this plugin owns, plus the read-only imported ones. */
    function useHosts() {
      const [hosts, setHosts] = useState([])
      const [imported, setImported] = useState([])
      const [error, setError] = useState(null)

      const reload = useCallback(async () => {
        try {
          const body = await api('/hosts')
          setHosts(Array.isArray(body?.hosts) ? body.hosts : [])
          setImported(Array.isArray(body?.imported) ? body.imported : [])
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async (input) => {
        await api('/hosts', { method: 'POST', body: JSON.stringify(input) })
        await reload()
      }, [reload])

      const remove = useCallback(async (alias) => {
        await api(`/hosts?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      const test = useCallback(async (input) => {
        return await api('/test', { method: 'POST', body: JSON.stringify(input) })
      }, [])

      return { hosts, imported, error, reload, save, remove, test }
    }

    /**
     * Panel-owned metadata: the names, groups, tags and notes that belong to the
     * operator rather than to the machine.
     *
     * Keyed by alias, because that is the join key everywhere else — renaming an
     * alias would orphan that host's entire history, so naming lives here.
     */
    function useMeta() {
      const [records, setRecords] = useState([])
      const [error, setError] = useState(null)

      const reload = useCallback(async () => {
        try {
          const body = await api('/meta')
          setRecords(Array.isArray(body?.meta) ? body.meta : [])
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async (record) => {
        await api('/meta', { method: 'POST', body: JSON.stringify(record) })
        await reload()
      }, [reload])

      const remove = useCallback(async (alias) => {
        await api(`/meta?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      const byAlias = useMemo(() => new Map(records.map((record) => [record.alias, record])), [records])

      return { records, byAlias, error, reload, save, remove }
    }

    /**
     * Service probes: the list the server schedules, not a client-side timer.
     *
     * The panel only reads and edits definitions; running them is the host's job,
     * so closing the page does not stop a probe and two open panels do not probe
     * the same endpoint twice.
     */
    function useProbes() {
      const [probes, setProbes] = useState([])
      const [error, setError] = useState(null)

      const reload = useCallback(async () => {
        try {
          const body = await api('/services')
          setProbes(Array.isArray(body?.probes) ? body.probes : [])
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async (probe) => {
        await api('/services', { method: 'POST', body: JSON.stringify(probe) })
        await reload()
      }, [reload])

      const remove = useCallback(async (id) => {
        await api(`/services?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      return { probes, error, reload, save, remove }
    }

    /**
     * Alert rules plus the events they produced.
     *
     * The server sends `intervalMs` along with the rules: a rule says "for 180
     * seconds", and the operator needs to know how many sweeps that actually is
     * before deciding whether the rule is trigger-happy.
     */
    function useAlerts() {
      const [rules, setRules] = useState([])
      const [events, setEvents] = useState([])
      const [intervalMs, setIntervalMs] = useState(30_000)
      const [error, setError] = useState(null)

      const reload = useCallback(async () => {
        try {
          const body = await api('/alerts')
          setRules(Array.isArray(body?.rules) ? body.rules : [])
          setEvents(Array.isArray(body?.events) ? body.events : [])
          if (Number.isFinite(body?.intervalMs)) setIntervalMs(body.intervalMs)
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async (rule) => {
        await api('/alerts', { method: 'POST', body: JSON.stringify(rule) })
        await reload()
      }, [reload])

      const remove = useCallback(async (id) => {
        await api(`/alerts?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      const silence = useCallback(async (target) => {
        await api('/alerts/silence', { method: 'POST', body: JSON.stringify(target) })
        await reload()
      }, [reload])

      return { rules, events, intervalMs, error, reload, save, remove, silence }
    }

    /**
     * Notification channels and the groups that bundle them.
     *
     * Presets and the placeholder list come from the server so the form can
     * offer what the renderer actually understands, not a copy that rots.
     */
    function useNotifications() {
      const [channels, setChannels] = useState([])
      const [groups, setGroups] = useState([])
      const [presets, setPresets] = useState({})
      const [placeholders, setPlaceholders] = useState([])
      const [error, setError] = useState(null)

      const reload = useCallback(async () => {
        try {
          const body = await api('/notifications')
          setChannels(Array.isArray(body?.channels) ? body.channels : [])
          setGroups(Array.isArray(body?.groups) ? body.groups : [])
          setPresets(Array.isArray(body?.presets) ? body.presets : [])
          setPlaceholders(Array.isArray(body?.placeholders) ? body.placeholders : [])
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const saveChannel = useCallback(async (channel) => {
        await api('/notifications', { method: 'POST', body: JSON.stringify(channel) })
        await reload()
      }, [reload])

      const removeChannel = useCallback(async (id) => {
        await api(`/notifications?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      const saveGroup = useCallback(async (group) => {
        await api('/notifications/groups', { method: 'POST', body: JSON.stringify(group) })
        await reload()
      }, [reload])

      const removeGroup = useCallback(async (id) => {
        await api(`/notifications/groups?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      const test = useCallback(async (channel) => {
        return api('/notifications/test', { method: 'POST', body: JSON.stringify({ channel }) })
      }, [])

      return { channels, groups, presets, placeholders, error, reload, saveChannel, removeChannel, saveGroup, removeGroup, test }
    }

    /**
     * One host's history.
     * @param alias - host alias, or null when the detail is closed.
     * @param open - whether the detail panel is showing.
     */
    function useHistory(alias, open) {
      const [points, setPoints] = useState([])
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!open || alias === null) {
          setPoints([])
          return
        }
        let cancelled = false
        const load = async () => {
          try {
            const from = Date.now() - 3_600_000
            const body = await api(`/history?alias=${encodeURIComponent(alias)}&from=${from}&limit=720`)
            if (!cancelled) {
              setPoints(Array.isArray(body?.points) ? body.points : [])
              setError(null)
            }
          } catch (failure) {
            if (!cancelled) setError(failure)
          }
        }
        void load()
        const timer = setInterval(() => { void load() }, 30_000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [alias, open])

      return { points, error }
    }

    /**
     * The hardware snapshot for one host: temperature, GPU, listening ports,
     * partitions and NIC counters.
     *
     * Deliberately not folded into `useHistory`: the slow sweep runs every five
     * minutes, so refetching it on every fast tick would be pure noise.
     */
    function useDetail(alias, open) {
      const [detail, setDetail] = useState(null)

      useEffect(() => {
        if (!open || alias === null) {
          setDetail(null)
          return
        }
        let cancelled = false
        void (async () => {
          try {
            const body = await api(`/detail?alias=${encodeURIComponent(alias)}`)
            if (!cancelled) setDetail(body)
          } catch {
            // A missing detail row is not an error worth a banner: the host may
            // simply not have had its first hardware sweep yet.
            if (!cancelled) setDetail(null)
          }
        })()
        return () => { cancelled = true }
      }, [alias, open])

      return detail
    }

    // ── styles ─────────────────────────────────────────────────────────────

    const STYLE_ID = 'dsh-fleet-monitor-style'

    /** One injected stylesheet: pseudo-classes and media queries need real CSS. */
    const CSS = `
.fm-root { --fm-border: color-mix(in oklab, currentColor 14%, transparent);
  --fm-soft: color-mix(in oklab, currentColor 6%, transparent);
  --fm-muted: color-mix(in oklab, currentColor 55%, transparent);
  display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 22px;
  width: 100%; min-width: 0; height: 100%; min-height: 0; flex: 1 1 auto;
  overflow: auto; box-sizing: border-box; font-size: 13px; color: inherit; }
.fm-root > * { min-width: 0; }
.fm-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; flex: none; min-width: 0; }
.fm-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--fm-border); margin: 2px 0 4px; overflow-x: auto; flex: none; }
.fm-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--fm-muted); font: inherit; font-size: 12px; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
.fm-tab:hover { color: inherit; }
.fm-tab.on { color: inherit; border-bottom-color: currentColor; }
.fm-title { font-size: 17px; font-weight: 600; margin: 0; }
.fm-sub { color: var(--fm-muted); font-size: 12px; margin: 2px 0 0; }
.fm-spacer { flex: 1 1 auto; }
.fm-btn { appearance: none; border: 1px solid var(--fm-border); background: transparent; color: inherit;
  border-radius: 7px; padding: 5px 11px; font-size: 12px; cursor: pointer; line-height: 1.6;
  transition: background 120ms ease, border-color 120ms ease; white-space: nowrap; }
.fm-btn:hover:not(:disabled) { background: var(--fm-soft); }
.fm-btn:disabled { opacity: .5; cursor: default; }
.fm-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.fm-btn.primary:hover:not(:disabled) { background: #1d4ed8; }
.fm-btn.danger { border-color: #ef4444; color: #ef4444; }
.fm-btn.danger:hover:not(:disabled) { background: color-mix(in oklab, #ef4444 12%, transparent); }
.fm-btn.tiny { padding: 2px 7px; font-size: 11px; }
.fm-input, .fm-select { appearance: none; border: 1px solid var(--fm-border); background: transparent;
  color: inherit; border-radius: 7px; padding: 5px 9px; font-size: 12px; min-width: 0; }
.fm-input:focus, .fm-select:focus { outline: 2px solid color-mix(in oklab, #2563eb 45%, transparent); outline-offset: -1px; }
.fm-input::placeholder { color: var(--fm-muted); }
.fm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; }
.fm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; flex: none; }
.fm-stat { border: 1px solid var(--fm-border); border-radius: 10px; padding: 9px 11px; cursor: pointer;
  background: transparent; text-align: left; color: inherit; transition: background 120ms ease, border-color 120ms ease; }
.fm-stat:hover { background: var(--fm-soft); }
.fm-stat.on { border-color: #2563eb; background: color-mix(in oklab, #2563eb 10%, transparent); }
.fm-stat-label { font-size: 11px; color: var(--fm-muted); display: block; }
.fm-stat-value { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
.fm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.fm-table th { text-align: left; font-weight: 500; color: var(--fm-muted); padding: 7px 9px;
  border-bottom: 1px solid var(--fm-border); white-space: nowrap; position: sticky; top: 0; z-index: 1;
  background: var(--fm-bg, Canvas); backdrop-filter: blur(6px); }
.fm-table td { padding: 7px 9px; border-bottom: 1px solid var(--fm-border); vertical-align: middle; }
.fm-row { cursor: pointer; }
.fm-row:hover td { background: var(--fm-soft); }
.fm-row.offline td:first-child { box-shadow: inset 3px 0 0 #ef4444; }
.fm-row.selected td { background: color-mix(in oklab, #2563eb 9%, transparent); }
.fm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.fm-dim { color: var(--fm-muted); }
.fm-num { font-variant-numeric: tabular-nums; }
.fm-meter { display: flex; align-items: center; gap: 6px; min-width: 92px; }
.fm-meter-bar { flex: 1 1 auto; height: 4px; border-radius: 3px;
  background: color-mix(in oklab, currentColor 12%, transparent); overflow: hidden; }
.fm-meter-fill { height: 100%; border-radius: 3px; transition: width 300ms ease; }
.fm-pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 7px;
  font-size: 11px; line-height: 1.7; border: 1px solid transparent; white-space: nowrap; }
.fm-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.fm-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 10px; }
.fm-card { border: 1px solid var(--fm-border); border-radius: 11px; padding: 11px 12px; cursor: pointer;
  display: flex; flex-direction: column; gap: 8px; transition: background 120ms ease, border-color 120ms ease; }
.fm-card:hover { background: var(--fm-soft); }
.fm-card.offline { border-left: 3px solid #ef4444; }
.fm-card.selected { border-color: #2563eb; background: color-mix(in oklab, #2563eb 8%, transparent); }
.fm-card-head { display: flex; align-items: center; gap: 7px; }
.fm-card-name { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-card-metrics { display: flex; flex-direction: column; gap: 5px; }
.fm-empty { border: 1px dashed var(--fm-border); border-radius: 12px; padding: 34px 20px; text-align: center;
  display: flex; flex-direction: column; gap: 9px; align-items: center; }
.fm-empty h3 { margin: 0; font-size: 14px; }
.fm-empty p { margin: 0; color: var(--fm-muted); font-size: 12px; max-width: 430px; line-height: 1.7; }
.fm-detail { border: 1px solid var(--fm-border); border-radius: 12px; padding: 13px 14px;
  display: flex; flex-direction: column; gap: 11px; }
.fm-detail-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; min-width: 0; }
.fm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 9px 16px; }
.fm-field { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.fm-field-label { font-size: 11px; color: var(--fm-muted); }
.fm-field-value { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.fm-chart { display: flex; flex-direction: column; gap: 3px; }
.fm-chart-label { font-size: 11px; color: var(--fm-muted); }
.fm-uptime-row { display: grid; grid-template-columns: 160px 1fr 52px; align-items: center;
  gap: 9px; padding: 2px 0; }
.fm-uptime-name { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.fm-uptime-pct { font-size: 11px; text-align: right; color: var(--fm-muted);
  font-variant-numeric: tabular-nums; }
.fm-uptime { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; }
.fm-uptime-cell { height: 13px; border-radius: 2px; background: var(--fm-soft); }
.fm-uptime-cell.ok { background: #22c55e; }
.fm-uptime-cell.warn { background: #f59e0b; }
.fm-uptime-cell.bad { background: #ef4444; }
.fm-uptime-cell.none { background: transparent; box-shadow: inset 0 0 0 1px var(--fm-border); }
.fm-uptime-cell.now { opacity: .55; }
.fm-hw { display: flex; flex-direction: column; gap: 7px; margin-top: 4px;
  padding-top: 11px; border-top: 1px solid var(--fm-border); }
.fm-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.fm-kv-list { display: flex; flex-direction: column; gap: 2px; }
.fm-kv-row { display: flex; justify-content: space-between; gap: 12px; font-size: 11.5px;
  padding: 2px 0; }
.fm-kv-row > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fm-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 8px 0 12px; }
@media (max-width: 760px) { .fm-settings-grid { grid-template-columns: 1fr; } }
.fm-probes { display: flex; flex-direction: column; gap: 1px; }
.fm-probe { display: grid; grid-template-columns: minmax(0, 1.6fr) auto; gap: 8px 14px;
  padding: 10px 12px; border-bottom: 1px solid var(--fm-border); align-items: center; }
.fm-probe-id { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.fm-probe-name { font-weight: 600; font-size: 12.5px; }
.fm-probe-target { color: var(--fm-muted); font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-probe-every { color: var(--fm-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.fm-probe-state { display: flex; align-items: center; gap: 9px; justify-content: flex-end; }
.fm-probe-latency { font-size: 11.5px; font-variant-numeric: tabular-nums; min-width: 52px;
  text-align: right; }
.fm-probe-cert { font-size: 11px; color: var(--fm-muted); font-variant-numeric: tabular-nums; }
.fm-grid30 { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(30, 1fr); gap: 2px; }
.fm-cell { height: 16px; border-radius: 2px; background: color-mix(in oklab, currentColor 10%, transparent); }
.fm-cell.ok { background: #22c55e; }
.fm-cell.bad { background: #ef4444; }
.fm-row-btn { background: none; border: 1px solid transparent; color: var(--fm-muted);
  border-radius: 6px; padding: 2px 7px; font-size: 11px; cursor: pointer; }
.fm-row-btn:hover { border-color: var(--fm-border); color: #ef4444; }
.fm-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fm-check { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 4px 0; }
.fm-note { color: var(--fm-muted); font-size: 11.5px; }
.fm-panel { display: flex; flex-direction: column; gap: 10px; }
.fm-textarea { resize: vertical; min-height: 64px; font-family: inherit; line-height: 1.5; }
.fm-tasks { display: flex; flex-direction: column; gap: 8px; }
.fm-task { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--fm-border); border-radius: 8px; }
.fm-task-off { opacity: 0.6; }
.fm-task-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.fm-task-name { font-weight: 600; font-size: 13px; }
.fm-task-expr { font-size: 11.5px; color: var(--fm-muted); font-variant-numeric: tabular-nums; }
.fm-task-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.fm-task-runs { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px dashed var(--fm-border); }
.fm-task-run { display: flex; flex-direction: column; gap: 4px; }
.fm-run-output { margin: 0; padding: 8px; border-radius: 6px; background: color-mix(in oklab, currentColor 5%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow: auto; }
.fm-rules, .fm-events { display: flex; flex-direction: column; gap: 6px; }
.fm-rule { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  border: 1px solid var(--fm-border); border-radius: 8px; padding: 9px 11px; }
.fm-rule-off { opacity: .55; }
.fm-rule-main { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; min-width: 0; }
.fm-rule-name { font-size: 12.5px; font-weight: 600; }
.fm-rule-expr { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; color: var(--fm-muted); }
.fm-rule-side { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.fm-event { display: grid; grid-template-columns: 74px 130px 1fr auto; gap: 10px; align-items: baseline;
  font-size: 12px; padding: 5px 2px; border-bottom: 1px solid var(--fm-border); }
.fm-event-alias { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
.fm-event-message { color: var(--fm-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-event-time { color: var(--fm-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.fm-pill-danger { color: #ef4444; border-color: color-mix(in oklab, #ef4444 45%, transparent); }
.fm-pill-ok { color: #22c55e; border-color: color-mix(in oklab, #22c55e 45%, transparent); }
.fm-danger { color: #ef4444; }
.fm-error-text { color: #ef4444; font-size: 11.5px; margin: 4px 0 0; }
.fm-ok-text { color: #22c55e; font-size: 11.5px; }
.fm-term { margin-top: 12px; border-top: 1px solid var(--fm-border); padding-top: 10px; }
.fm-term-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 11.5px;
  color: var(--fm-muted); }
.fm-term-screen { margin: 0; padding: 10px 12px; max-height: 340px; overflow: auto; outline: none;
  background: rgba(0,0,0,.32); border: 1px solid var(--fm-border); border-radius: 6px;
  font-family: ui-monospace, Menlo, Consolas, "Cascadia Mono", monospace; font-size: 11.5px;
  line-height: 1.5; white-space: pre; tab-size: 4; }
.fm-term-screen:focus { border-color: color-mix(in oklab, currentColor 34%, transparent); }
.fm-files { margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--fm-border);
  display: flex; flex-direction: column; gap: 9px; }
.fm-files-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11.5px;
  color: var(--fm-muted); }
.fm-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.fm-crumb { background: none; border: none; padding: 1px 4px; border-radius: 4px; cursor: pointer;
  color: inherit; font: inherit; font-family: ui-monospace, Menlo, Consolas, monospace; }
.fm-crumb:hover { background: var(--fm-soft); color: inherit; }
.fm-crumb + .fm-crumb::before { content: '/'; opacity: .45; margin-right: 3px; }
.fm-progress { position: relative; height: 16px; border-radius: 5px; background: var(--fm-soft);
  overflow: hidden; display: flex; align-items: center; }
.fm-progress-fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in oklab, #3b82f6 55%, transparent); }
.fm-progress > span { position: relative; font-size: 10.5px; padding-left: 7px;
  font-variant-numeric: tabular-nums; }
.fm-inline-form { display: flex; align-items: center; gap: 7px; font-size: 11.5px; }
.fm-file-list { display: flex; flex-direction: column; max-height: 300px; overflow: auto;
  border: 1px solid var(--fm-border); border-radius: 8px; }
.fm-file-row { display: grid; grid-template-columns: 1fr 84px 132px auto; align-items: center;
  gap: 8px; padding: 5px 9px; font-size: 11.5px; border-bottom: 1px solid var(--fm-border); }
.fm-file-row:last-child { border-bottom: none; }
.fm-file-row:hover { background: var(--fm-soft); }
.fm-file-name { background: none; border: none; padding: 0; cursor: pointer; text-align: left;
  color: inherit; font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-file-size, .fm-file-time { color: var(--fm-muted); font-variant-numeric: tabular-nums;
  font-size: 11px; }
.fm-file-actions { display: flex; gap: 4px; }
.fm-file-up .fm-file-name { color: var(--fm-muted); }
.fm-error { color: #ef4444; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px;
  word-break: break-all; line-height: 1.6; }
.fm-footer { display: flex; flex-wrap: wrap; gap: 12px; color: var(--fm-muted); font-size: 11px;
  border-top: 1px solid var(--fm-border); padding-top: 8px; }
.fm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex;
  align-items: center; justify-content: center; z-index: 60; padding: 18px; }
.fm-modal { background: var(--fm-bg, Canvas); color: inherit; border: 1px solid var(--fm-border);
  border-radius: 13px; width: min(560px, 100%); max-height: 90vh; overflow: auto;
  display: flex; flex-direction: column; box-shadow: 0 18px 50px rgba(0,0,0,.3); }
.fm-modal-head { display: flex; align-items: center; gap: 10px; padding: 13px 15px;
  border-bottom: 1px solid var(--fm-border); }
.fm-modal-body { padding: 14px 15px; display: flex; flex-direction: column; gap: 11px; }
.fm-modal-foot { display: flex; gap: 8px; align-items: center; padding: 12px 15px;
  border-top: 1px solid var(--fm-border); }
.fm-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fm-field-input { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.fm-field-input > label { font-size: 11.5px; color: var(--fm-muted); }
.fm-field-input > .fm-input, .fm-field-input > textarea, .fm-field-input > select { width: 100%; box-sizing: border-box; }
.fm-field-hint { font-size: 10.5px; color: var(--fm-muted); }
.fm-hint { font-size: 10.5px; color: var(--fm-muted); }
.fm-note { font-size: 11.5px; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--fm-border); }
.fm-note.ok { border-color: #22c55e; color: #16a34a; }
.fm-note.bad { border-color: #ef4444; color: #ef4444; }
.fm-alert { border: 1px solid #ef4444; border-radius: 10px; padding: 11px 13px;
  display: flex; flex-direction: column; gap: 6px; }
@media (max-width: 620px) {
  .fm-form-row { grid-template-columns: 1fr; }
  .fm-card-metrics { gap: 4px; }
}
`

    /** Inject the stylesheet once per document. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ── atoms ──────────────────────────────────────────────────────────────

    /** Segmented utilisation bar with its numeric value beside it. */
    function Meter(props) {
      const pct = props.pct
      const known = pct !== null && pct !== undefined && Number.isFinite(pct)
      const colour = utilColor(pct)
      return h('div', { className: 'fm-meter' },
        h('div', { className: 'fm-meter-bar' },
          h('div', {
            className: 'fm-meter-fill',
            style: { width: `${known ? Math.min(100, Math.max(0, pct)) : 0}%`, background: colour },
          })),
        h('span', { className: 'fm-num', style: { color: known ? colour : 'var(--fm-muted)', minWidth: 38 } },
          known ? `${pct.toFixed(0)}%` : '—'),
      )
    }

    /** A status dot plus its label. */
    function StatusPill(props) {
      const status = props.status
      return h('span', { className: 'fm-pill', style: { borderColor: 'var(--fm-border)' } },
        h('span', { className: 'fm-dot', style: { background: statusColor(status) } }),
        h('span', null, t(`status.${status}`)),
      )
    }

    /** Small tag chip. */
    function Tag(props) {
      return h('span', {
        className: 'fm-pill',
        style: {
          borderColor: 'var(--fm-border)',
          color: 'var(--fm-muted)',
          fontSize: 10.5,
        },
      }, props.children)
    }

    /**
     * Inline SVG line chart.
     * @param props.values - numeric series, oldest first; nulls break the line.
     * @param props.colour - stroke colour.
     * @param props.max - upper bound; defaults to the series maximum.
     */
    function Sparkline(props) {
      const values = Array.isArray(props.values) ? props.values : []
      const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(value))
      if (known.length < 2) {
        return h('div', {
          style: {
            height: props.height ?? 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--fm-muted)',
            fontSize: 10.5,
            border: '1px dashed var(--fm-border)',
            borderRadius: 7,
          },
        }, t('detail.nothing'))
      }
      const width = 240
      const height = props.height ?? 44
      const max = props.max ?? Math.max(...known) * 1.15
      const min = props.min ?? 0
      const span = max - min || 1
      const step = values.length > 1 ? width / (values.length - 1) : width
      let path = ''
      let area = ''
      let started = false
      values.forEach((value, index) => {
        if (value === null || value === undefined || !Number.isFinite(value)) {
          started = false
          return
        }
        const x = index * step
        const y = height - ((value - min) / span) * height
        path += `${started ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
        if (!started) area += `M${x.toFixed(1)} ${height}L${x.toFixed(1)} ${y.toFixed(1)}`
        else area += `L${x.toFixed(1)} ${y.toFixed(1)}`
        started = true
      })
      area += `L${width} ${height}Z`
      const colour = props.colour ?? '#2563eb'
      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        width: '100%',
        height,
        preserveAspectRatio: 'none',
        style: { display: 'block', overflow: 'visible' },
      },
      h('path', { d: area, fill: colour, opacity: 0.13 }),
      h('path', { d: path, fill: 'none', stroke: colour, strokeWidth: 1.6, strokeLinejoin: 'round' }))
    }

    /** A labelled value. */
    /**
     * A labelled field. Pass children and it becomes a form row; leave them out
     * and it is a read-only fact in the detail grid.
     *
     * Both shapes share one name because every dialog used this thinking it took
     * children — it did not, so the text boxes were silently dropped and the
     * dialogs rendered as a title and a Save button. The children branch below is
     * what makes every form in this panel actually appear.
     */
    function Field(props) {
      const editor = props.children
      if (editor !== undefined && editor !== null) {
        return h('div', { className: 'fm-field-input' },
          h('label', null, props.label),
          editor,
          props.hint === undefined || props.hint === null || props.hint === ''
            ? null
            : h('span', { className: 'fm-field-hint' }, props.hint))
      }
      return h('div', { className: 'fm-field' },
        h('span', { className: 'fm-field-label' }, props.label),
        h('span', {
          className: props.mono === true ? 'fm-field-value fm-mono' : 'fm-field-value',
          title: typeof props.value === 'string' ? props.value : undefined,
        }, props.value ?? '—'))
    }

    // ── host form ──────────────────────────────────────────────────────────

    /** The empty form state. */
    function blankHost() {
      return {
        alias: '',
        host: '',
        port: 22,
        user: 'root',
        authKind: 'key',
        keyPath: '',
        passphrase: '',
        password: '',
        groupName: '',
        tags: '',
        note: '',
      }
    }

    /** Turn a stored record back into form state. */
    function toFormState(record) {
      return {
        alias: record.alias ?? '',
        host: record.host ?? '',
        port: record.port ?? 22,
        user: record.user ?? 'root',
        authKind: record.authKind ?? 'key',
        keyPath: record.keyPath ?? '',
        // The stored secret never comes back from the API; the operator re-enters
        // it deliberately (or leaves it, which keeps the saved one on the host).
        passphrase: '',
        password: '',
        groupName: record.groupName ?? '',
        tags: Array.isArray(record.tags) ? record.tags.join(', ') : '',
        note: record.note ?? '',
      }
    }

    /** Validate the form before it reaches the network. */
    function validate(form) {
      if (form.host.trim() === '') return t('error.host')
      const port = Number(form.port)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return t('error.port')
      if (form.authKind === 'key' && form.keyPath.trim() === '') return t('error.keyPath')
      if (form.authKind === 'password' && form.password === '') return t('error.password')
      return null
    }

    /**
     * Add / edit dialog.
     * @param props.open - whether it is showing.
     * @param props.record - the host being edited, or null for a new one.
     * @param props.onClose - dismiss.
     * @param props.onSubmit - save the payload.
     * @param props.onTest - probe without saving.
     */
    function HostForm(props) {
      const [form, setForm] = useState(blankHost)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [test, setTest] = useState(null)
      const [testing, setTesting] = useState(false)

      useEffect(() => {
        if (!props.open) return
        setForm(props.record === null || props.record === undefined ? blankHost() : toFormState(props.record))
        setError(null)
        setTest(null)
        setTesting(false)
      }, [props.open, props.record])

      if (!props.open) return null

      const set = (key) => (event) => {
        setForm((prev) => ({ ...prev, [key]: event.target.value }))
      }

      const payload = () => ({
        alias: form.alias.trim() === '' ? undefined : form.alias.trim(),
        host: form.host.trim(),
        port: Number(form.port),
        user: form.user.trim() === '' ? 'root' : form.user.trim(),
        authKind: form.authKind,
        keyPath: form.keyPath.trim(),
        passphrase: form.passphrase,
        password: form.password,
        groupName: form.groupName.trim(),
        note: form.note.trim(),
        tags: form.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
      })

      const submit = async () => {
        const problem = validate(form)
        if (problem !== null) {
          setError(problem)
          return
        }
        setBusy(true)
        setError(null)
        try {
          await props.onSubmit(payload())
          props.onClose()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const probe = async () => {
        const problem = validate(form)
        if (problem !== null) {
          setError(problem)
          return
        }
        setTesting(true)
        setTest(null)
        try {
          setTest(await props.onTest(payload()))
        } catch (failure) {
          setTest({ ok: false, error: failure instanceof Error ? failure.message : String(failure) })
        } finally {
          setTesting(false)
        }
      }

      const field = (label, key, options) => h('div', { className: 'fm-field-input' },
        h('label', null, label, options?.required === true ? ` (${t('form.required')})` : ''),
        h('input', {
          className: 'fm-input',
          value: form[key],
          placeholder: options?.placeholder,
          type: options?.type ?? 'text',
          onChange: set(key),
          onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
        }),
        options?.hint === undefined ? null : h('span', { className: 'fm-hint' }, options.hint))

      return h('div', {
        className: 'fm-overlay',
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose() },
      },
      h('div', { className: 'fm-modal' },
        h('div', { className: 'fm-modal-head' },
          h('strong', null, props.record === null || props.record === undefined ? t('form.add') : t('form.edit')),
          h('span', { className: 'fm-spacer' }),
          h('button', { className: 'fm-btn tiny', onClick: props.onClose }, t('action.close'))),

        h('div', { className: 'fm-modal-body' },
          h('div', { className: 'fm-form-row' },
            field(t('form.host'), 'host', { required: true, placeholder: '10.0.0.1 或 example.com' }),
            field(t('form.port'), 'port', { type: 'number' })),
          h('div', { className: 'fm-form-row' },
            field(t('form.user'), 'user', { placeholder: 'root' }),
            field(t('form.alias'), 'alias', { hint: t('form.alias.hint') })),

          h('div', { className: 'fm-field-input' },
            h('label', null, t('form.auth')),
            h('select', {
              className: 'fm-select',
              value: form.authKind,
              onChange: set('authKind'),
            },
            h('option', { value: 'key' }, t('form.auth.key')),
            h('option', { value: 'password' }, t('form.auth.password')),
            h('option', { value: 'agent' }, t('form.auth.agent')))),

          form.authKind === 'key'
            ? h('div', null,
              field(t('form.keyPath'), 'keyPath', { required: true, placeholder: '~/.ssh/id_ed25519' }),
              field(t('form.passphrase'), 'passphrase', { type: 'password', hint: t('form.alias.hint') }))
            : null,

          form.authKind === 'password'
            ? field(t('form.password'), 'password', { type: 'password', required: true })
            : null,

          h('div', { className: 'fm-form-row' },
            field(t('form.group'), 'groupName', { placeholder: '生产 / 测试' }),
            field(t('form.tags'), 'tags', { hint: t('form.tags.hint') })),

          field(t('form.note'), 'note'),

          error === null ? null : h('div', { className: 'fm-note bad' }, error),
          test === null ? null : h('div', { className: `fm-note ${test.ok === true ? 'ok' : 'bad'}` },
            test.ok === true
              ? `${t('test.ok')} · ${fmtMs(test.latencyMs)}${test.os === undefined || test.os === null || test.os === '' ? '' : ` · ${test.os}`}${test.memPct === undefined || test.memPct === null ? '' : ` · ${t('detail.mem')} ${fmtPct(test.memPct)}`}`
              : `${t('test.fail')} · ${test.stage ?? ''} ${test.error ?? ''}`)),

        h('div', { className: 'fm-modal-foot' },
          h('button', { className: 'fm-btn', onClick: () => { void probe() }, disabled: testing },
            testing ? t('action.testing') : t('action.test')),
          h('span', { className: 'fm-spacer' }),
          h('button', { className: 'fm-btn', onClick: props.onClose, disabled: busy }, t('action.cancel')),
          h('button', { className: 'fm-btn primary', onClick: () => { void submit() }, disabled: busy },
            busy ? t('action.saving') : t('action.save')))))
    }

    /**
     * Editor for the operator-owned metadata of one host.
     *
     * Kept apart from HostForm on purpose: HostForm edits how to reach a machine,
     * this edits what to call it. The alias never changes here because it is the
     * join key for the collected history.
     */
    function MetaForm(props) {
      const record = props.record ?? {}
      const [displayName, setDisplayName] = useState(record.displayName ?? '')
      const [groupName, setGroupName] = useState(record.groupName ?? '')
      const [tags, setTags] = useState((record.tags ?? []).join(', '))
      const [note, setNote] = useState(record.note ?? '')
      const [hidden, setHidden] = useState(record.hidden === true)
      const [expireAt, setExpireAt] = useState(
        record.expireAt === null || record.expireAt === undefined
          ? ''
          : new Date(record.expireAt).toISOString().slice(0, 10),
      )
      const [price, setPrice] = useState(record.price === null || record.price === undefined ? '' : String(record.price))
      const [bandwidth, setBandwidth] = useState(
        record.bandwidthGb === null || record.bandwidthGb === undefined ? '' : String(record.bandwidthGb),
      )
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      if (props.open !== true) return null

      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          await props.onSubmit({
            alias: props.alias,
            displayName: displayName.trim() === '' ? null : displayName.trim(),
            groupName: groupName.trim() === '' ? null : groupName.trim(),
            tags: tags.split(',').map((item) => item.trim()).filter((item) => item !== ''),
            note: note.trim() === '' ? null : note.trim(),
            hidden,
            expireAt: expireAt === '' ? null : Date.parse(`${expireAt}T00:00:00`),
            price: price === '' ? null : Number(price),
            bandwidthGb: bandwidth === '' ? null : Number(bandwidth),
          })
          props.onClose()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const line = (label, value, onChange, options) => h('div', { className: 'fm-field-input' },
        h('label', null, label),
        h('input', {
          className: 'fm-input',
          value,
          type: options?.type ?? 'text',
          placeholder: options?.placeholder,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
        }))

      return h('div', {
        className: 'fm-overlay',
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose() },
      },
      h('div', { className: 'fm-modal' },
        h('div', { className: 'fm-modal-head' },
          h('strong', null, t('meta.title')),
          h('span', { className: 'fm-spacer' }),
          h('button', { className: 'fm-btn tiny', onClick: props.onClose }, t('action.close'))),

        h('div', { className: 'fm-modal-body' },
          h('div', { className: 'fm-form-row' },
            line(t('meta.displayName'), displayName, setDisplayName, { placeholder: props.alias }),
            line(t('meta.group'), groupName, setGroupName, { placeholder: '生产 / 测试' })),
          line(t('meta.tags'), tags, setTags, { placeholder: 'prod, 上海' }),
          line(t('meta.note'), note, setNote),
          h('div', { className: 'fm-form-row' },
            line(t('meta.expireAt'), expireAt, setExpireAt, { type: 'date' }),
            line(t('meta.price'), price, setPrice, { type: 'number' })),
          h('div', { className: 'fm-form-row' },
            line(t('meta.bandwidth'), bandwidth, setBandwidth, { type: 'number' }),
            h('div', { className: 'fm-field-input' },
              h('label', null, t('meta.hidden')),
              h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, minHeight: 28 } },
                h('input', {
                  type: 'checkbox',
                  checked: hidden,
                  onChange: (event) => setHidden(event.target.checked),
                }),
                t('meta.hiddenHint')))),
          error === null ? null : h('div', { className: 'fm-note bad' }, error)),

        h('div', { className: 'fm-modal-foot' },
          h('span', { className: 'fm-mono fm-dim', style: { fontSize: 11.5 } }, props.alias),
          h('span', { className: 'fm-spacer' }),
          h('button', { className: 'fm-btn', onClick: props.onClose, disabled: busy }, t('action.cancel')),
          h('button', { className: 'fm-btn primary', onClick: () => { void submit() }, disabled: busy },
            busy ? t('action.saving') : t('action.save')))))
    }

    /**
     * The expanded host view: identity, live figures, and an hour of history.
     * @param props.node - the snapshot entry.
     * @param props.onClose - collapse.
     */
    /**
     * The hardware section of the detail panel.
     *
     * Every field here is optional by nature: a container has no thermal zone, a
     * cloud VM has no GPU, and a non-Linux host returns nothing at all. All three
     * must read as "not applicable" instead of as zero, and a failed sweep keeps
     * its error visible so a stale number never passes for a live one.
     */
    function HardwareBlock(props) {
      const hardware = props.hardware
      if (hardware === null || hardware === undefined) {
        return h('div', { className: 'fm-field' },
          h('span', { className: 'fm-field-label' }, t('detail.hardware')),
          h('span', { className: 'fm-dim' }, t('detail.hw_pending')))
      }
      const sensors = Array.isArray(hardware.sensors) ? hardware.sensors : []
      const ports = Array.isArray(hardware.listenList) ? hardware.listenList : []
      const parts = Array.isArray(hardware.partitions) ? hardware.partitions : []
      const nics = Array.isArray(hardware.nics) ? hardware.nics : []
      const gpu = hardware.gpu
      const temp = hardware.tempMax === null || hardware.tempMax === undefined
        ? (sensors.length === 0 ? t('detail.hw_none') : '—')
        : `${hardware.tempMax.toFixed(1)} °C${sensors.length > 1 ? ` · ${t('detail.sensor_count', { count: sensors.length })}` : ''}`
      return h('div', { className: 'fm-hw' },
        h('div', { className: 'fm-chart-label' }, t('detail.hardware')),
        h('div', { className: 'fm-grid' },
          h(Field, { label: t('detail.temp'), value: temp }),
          h(Field, {
            label: t('detail.gpu'),
            value: gpu === null || gpu === undefined
              ? t('detail.hw_none')
              : `${gpu.util}% · ${fmtBytes(gpu.memUsed * 1024 ** 2)} / ${fmtBytes(gpu.memTotal * 1024 ** 2)}${gpu.name ? ` · ${gpu.name}` : ''}`,
          }),
          h(Field, {
            label: t('detail.ports'),
            value: ports.length === 0 ? t('detail.hw_none') : String(ports.length),
          })),
        ports.length === 0
          ? null
          : h('div', { className: 'fm-chips' },
            ports.slice(0, 24).map(port => h(Tag, { key: port }, String(port))),
            ports.length > 24 ? h('span', { className: 'fm-dim' }, `+${ports.length - 24}`) : null),
        parts.length === 0
          ? null
          : h('div', { className: 'fm-kv-list' }, parts.map(part => h('div', { className: 'fm-kv-row', key: part.mount },
            h('span', { className: 'fm-mono' }, part.mount),
            h('span', { className: 'fm-dim' }, `${fmtBytes(part.used)} / ${fmtBytes(part.total)}`)))),
        nics.length === 0
          ? null
          : h('div', { className: 'fm-kv-list' }, nics.map(nic => h('div', { className: 'fm-kv-row', key: nic.name },
            h('span', { className: 'fm-mono' }, nic.name),
            h('span', { className: 'fm-dim' }, `↓ ${fmtBytes(nic.rxBytes)} · ↑ ${fmtBytes(nic.txBytes)}`)))),
        hardware.error === null || hardware.error === undefined
          ? null
          : h('div', { className: 'fm-error' }, `${t('detail.hw_failed')}: ${hardware.error}`))
    }

    /**
     * Drop the escape sequences this panel does not render.
     *
     * Colours, cursor movement and title bars are removed rather than printed as
     * gibberish: the text is what this view is for, and full-screen programs are
     * explicitly out of scope (dsh-ssh's terminal remains the place for those).
     */
    function stripAnsi(text) {
      return String(text)
        .replace(/\u001b\][^\u0007]*\u0007/g, '')
        .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\u001b[()][A-Za-z0-9]/g, '')
        .replace(/\r\n/g, '\n')
    }

    /**
     * A line buffer with a cursor, which is all the terminal view needs.
     *
     * `\r` returns to column zero (progress bars and prompts redraw that way),
     * `\b` steps back, and a write past the end of a line pads with spaces.
     * Wide characters are counted as one cell, so a Chinese path shifts the rest
     * of its line by a column; with a monospace font the text still reads.
     */
    function makeScreen() {
      const lines = ['']
      let row = 0
      let column = 0
      const ensure = () => {
        while (lines.length <= row) lines.push('')
      }
      return {
        lines,
        write(chunk) {
          for (const character of stripAnsi(chunk)) {
            if (character === '\n') { row += 1; column = 0; ensure(); continue }
            if (character === '\r') { column = 0; continue }
            if (character === '\b') { column = Math.max(0, column - 1); continue }
            if (character === '\u0007') continue
            ensure()
            const line = lines[row]
            lines[row] = line.length >= column
              ? `${line.slice(0, column)}${character}${line.slice(column + 1)}`
              : `${line.padEnd(column, ' ')}${character}`
            column += 1
          }
          // A runaway command (`yes`, a log tail) must not grow the tab forever.
          if (lines.length > 4000) lines.splice(0, lines.length - 4000)
        },
      }
    }

    /** An interactive shell for one host, over the plugin's own WebSocket. */
    /**
     * Where the WebSocket should dial, as `host:port`.
     *
     * `location.origin` is the obvious answer and the wrong one under the
     * Electron shell, which serves this panel from `dsh-app://` — a scheme
     * WebSocket cannot speak and which carries no port. The HTTP routes still
     * arrive over a real loopback port and the host half reports it, so ask for
     * it instead of guessing from the page's own address.
     */
    async function resolveSocketBase() {
      const origin = typeof window !== 'undefined' && window.location !== undefined
        ? String(window.location.origin ?? '')
        : ''
      if (/^https?:\/\//.test(origin)) {
        return { host: origin.replace(/^https?:\/\//, ''), secure: origin.startsWith('https') }
      }
      try {
        const status = await fetch(`${API_BASE}/status`, { cache: 'no-store' }).then((response) => response.json())
        if (Number.isInteger(status?.port)) return { host: `127.0.0.1:${status.port}`, secure: false }
      } catch {}
      // Nothing to fall back on: `location.host` here is the bare authority of a
      // custom scheme (`dsh-app://app` gives `app`), and dialling `ws://app/…`
      // only trades a clear failure for a confusing one.
      return null
    }

    function TerminalView(props) {
      const screenRef = useRef(null)
      if (screenRef.current === null) screenRef.current = makeScreen()
      const socketRef = useRef(null)
      const preRef = useRef(null)
      const [, redraw] = useState(0)
      const [status, setStatus] = useState('connecting')
      const [error, setError] = useState(null)

      useEffect(() => {
        let cancelled = false
        let socket = null

        const attach = (base, secure) => {
          const url = `${secure ? 'wss' : 'ws'}://${base}${API_BASE}/terminal?alias=${encodeURIComponent(props.alias)}&cols=100&rows=30`
          let opened = null
          try {
            opened = new WebSocket(url)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
            setStatus('closed')
            return
          }
          socket = opened
          socketRef.current = opened
          opened.addEventListener('open', () => setStatus('open'))
          opened.addEventListener('message', (event) => {
            let frame = null
            try { frame = JSON.parse(event.data) } catch { return }
            if (frame.type === 'output') {
              screenRef.current.write(frame.data)
              redraw((tick) => tick + 1)
              return
            }
            if (frame.type === 'ready') { setStatus('ready'); return }
            if (frame.type === 'exit') {
              setStatus('closed')
              if (frame.error !== undefined && frame.error !== null) setError(frame.error)
            }
          })
          opened.addEventListener('close', (event) => {
            setStatus('closed')
            // 1006 is "closed abnormally", which is what a refused handshake
            // looks like from inside the page. Say so instead of leaving the
            // operator with a silent black box.
            if (event.code === 1006 && cancelled === false) setError(`${t('terminal.failed')} (1006 ${url})`)
          })
          opened.addEventListener('error', () => setError(t('terminal.failed')))
        }

        resolveSocketBase().then((target) => {
          if (cancelled) return
          if (target === null) {
            setStatus('closed')
            setError(t('terminal.failed'))
            return
          }
          attach(target.host, target.secure)
        })

        return () => {
          cancelled = true
          // Closing the socket detaches the shell rather than killing it, so a
          // reload reattaches; the explicit "结束会话" button sends `close`.
          try { if (socket !== null) socket.close() } catch {}
        }
      }, [props.alias])

      useEffect(() => {
        // Take the keyboard on open. Without this the click that opened the
        // terminal leaves focus on its own button, and the first Enter the
        // operator types re-toggles the panel instead of reaching the shell.
        const pre = preRef.current
        if (pre !== null && pre !== undefined) pre.focus()
      }, [])

      useEffect(() => {
        const pre = preRef.current
        if (pre !== null && pre !== undefined) pre.scrollTop = pre.scrollHeight
      })

      const send = (frame) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(frame))
      }

      const keyMap = {
        Enter: '\r',
        Backspace: '\u007f',
        Tab: '\t',
        Escape: '\u001b',
        ArrowUp: '\u001b[A',
        ArrowDown: '\u001b[B',
        ArrowRight: '\u001b[C',
        ArrowLeft: '\u001b[D',
        Home: '\u001b[H',
        End: '\u001b[F',
        Delete: '\u001b[3~',
      }

      const onKeyDown = (event) => {
        if (keyMap[event.key] !== undefined) {
          send({ type: 'input', data: keyMap[event.key] })
          event.preventDefault()
          return
        }
        if (event.ctrlKey && event.key.length === 1) {
          const code = event.key.toUpperCase().charCodeAt(0) - 64
          if (code >= 1 && code <= 26) {
            send({ type: 'input', data: String.fromCharCode(code) })
            event.preventDefault()
          }
          return
        }
        if (event.key.length === 1) {
          send({ type: 'input', data: event.key })
          event.preventDefault()
        }
      }

      const onPaste = (event) => {
        const text = event.clipboardData?.getData('text') ?? ''
        if (text !== '') {
          send({ type: 'input', data: text })
          event.preventDefault()
        }
      }

      return h('div', { className: 'fm-term' }, [
        h('div', { className: 'fm-term-bar' }, [
          h('span', { className: 'fm-mono' }, `${props.alias} · ${status}`),
          h('span', { className: 'fm-spacer' }),
          h('button', {
            className: 'fm-btn tiny',
            onClick: () => { send({ type: 'close' }); props.onClose() },
          }, t('terminal.end')),
          h('button', { className: 'fm-btn tiny', onClick: props.onClose }, t('action.close')),
        ]),
        error === null ? null : h('p', { className: 'fm-error-text' }, error),
        h('pre', {
          className: 'fm-term-screen',
          ref: preRef,
          tabIndex: 0,
          onKeyDown,
          onPaste,
        }, screenRef.current.lines.join('\n')),
        h('p', { className: 'fm-dim', style: { fontSize: 11 } }, t('terminal.hint')),
      ])
    }

    /**
     * One directory, plus the navigation that moves between them.
     *
     * The listing is reloaded whenever the requested path changes, so `path` is
     * the only piece of state a caller has to reason about.
     */
    function useFiles(alias, open) {
      const [path, setPath] = React.useState('/')
      const [state, setState] = React.useState({ entries: [], parent: '/', loading: false, error: null })
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        if (open !== true) return undefined
        let cancelled = false
        setState((previous) => ({ ...previous, loading: true, error: null }))
        api(`/fs/ls?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(path)}`)
          .then((data) => {
            if (cancelled) return
            setState({ entries: Array.isArray(data?.entries) ? data.entries : [], parent: data?.parent ?? '/', loading: false, error: null })
          })
          .catch((error) => {
            if (cancelled) return
            setState({ entries: [], parent: '/', loading: false, error: error.message })
          })
        return () => { cancelled = true }
        // `tick` is how a reload of the same directory is requested.
      }, [alias, open, path, tick])

      return {
        path,
        entries: state.entries,
        parent: state.parent,
        loading: state.loading,
        error: state.error,
        go: (next) => setPath(next === '' ? '/' : next),
        reload: () => setTick((value) => value + 1),
      }
    }

    /**
     * Upload one file and follow its NDJSON progress.
     *
     * `fetch` streams the body as the file is read, and the response carries one
     * JSON object per line, so a 400 MB upload shows movement instead of a
     * spinner that might be a hang.
     */
    async function uploadFile(alias, path, file, onProgress) {
      const response = await fetch(
        `${API_BASE}/fs/upload?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(path)}`,
        { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size) }, body: file, cache: 'no-store' },
      )
      if (response.body === null) return { ok: response.ok }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result = null
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n')
        while (cut !== -1) {
          const line = buffer.slice(0, cut).trim()
          buffer = buffer.slice(cut + 1)
          cut = buffer.indexOf('\n')
          if (line === '') continue
          try {
            const frame = JSON.parse(line)
            if (frame.type === 'progress') onProgress(frame.received, frame.total ?? file.size)
            if (frame.type === 'result') result = frame
          } catch {}
        }
      }
      return result ?? { ok: false, error: 'the upload ended without a result frame' }
    }

    /** Directory browser for one host: navigate, upload, download, rename, delete. */
    function FilePanel(props) {
      const files = useFiles(props.alias, props.open === true)
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [editing, setEditing] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [progress, setProgress] = React.useState(null)
      const input = React.useRef(null)

      if (props.open !== true) return null

      const handle = async (run, label) => {
        setBusy(label)
        setError(null)
        try {
          await run()
          files.reload()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(null)
        }
      }

      const pick = (event) => {
        const file = event.target.files?.[0]
        if (file === undefined) return
        const target = files.path === '/' ? `/${file.name}` : `${files.path}/${file.name}`
        setProgress({ received: 0, total: file.size })
        handle(async () => {
          const result = await uploadFile(props.alias, target, file, (received, total) => setProgress({ received, total }))
          if (result?.ok !== true) throw new Error(result?.error ?? 'upload failed')
        }, 'upload').finally(() => {
          setProgress(null)
          if (input.current !== null) input.current.value = ''
        })
      }

      const crumbs = files.path === '/'
        ? [{ label: '/', path: '/' }]
        : [{ label: '/', path: '/' }].concat(
          files.path.split('/').filter(Boolean).map((part, index, all) => ({
            label: part,
            path: `/${all.slice(0, index + 1).join('/')}`,
          })),
        )

      return h('div', { className: 'fm-files' },
        h('div', { className: 'fm-files-bar' },
          h('div', { className: 'fm-crumbs' }, crumbs.map((crumb) => h('button', {
            key: crumb.path,
            className: 'fm-crumb',
            onClick: () => files.go(crumb.path),
          }, crumb.label))),
          h('span', { className: 'fm-spacer' }),
          busy === null ? null : h('span', { className: 'fm-dim' }, `${busy}…`),
          h('button', { className: 'fm-btn tiny', onClick: files.reload }, t('action.refresh')),
          h('button', {
            className: 'fm-btn tiny',
            onClick: () => { setEditing({ kind: 'dir', path: files.path }); setDraft('') },
          }, t('files.newDir')),
          h('button', { className: 'fm-btn tiny', onClick: () => input.current?.click() }, t('files.upload')),
          h('button', { className: 'fm-btn tiny', onClick: props.onClose }, t('action.close')),
          h('input', { ref: input, type: 'file', style: { display: 'none' }, onChange: pick })),

        progress === null ? null : h('div', { className: 'fm-progress' },
          h('div', {
            className: 'fm-progress-fill',
            style: { width: `${progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0}%` },
          }),
          h('span', null, `${fmtBytes(progress.received)} / ${fmtBytes(progress.total)}`)),

        error === null ? null : h('div', { className: 'fm-error' }, error),

        editing === null ? null : h('div', { className: 'fm-inline-form' },
          h('span', { className: 'fm-dim' }, editing.kind === 'dir' ? t('files.newDir') : t('files.renameTo')),
          h('input', {
            className: 'fm-input',
            value: draft,
            autoFocus: true,
            placeholder: editing.kind === 'dir' ? 'logs' : posixName(editing.path),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') { setEditing(null); return }
              if (event.key !== 'Enter') return
              const name = draft.trim()
              if (name === '') return
              const base = editing.path === '/' ? '' : editing.path
              handle(async () => {
                if (editing.kind === 'dir') {
                  await api('/fs/mkdir', { method: 'POST', body: JSON.stringify({ alias: props.alias, path: `${base}/${name}` }) })
                } else {
                  await api('/fs/rename', { method: 'POST', body: JSON.stringify({ alias: props.alias, from: editing.path, to: `${files.path === '/' ? '' : files.path}/${name}` }) })
                }
              }, editing.kind).then(() => setEditing(null))
            },
          }),
          h('button', {
            className: 'fm-btn tiny',
            onClick: () => setEditing(null),
          }, t('action.cancel'))),

        h('div', { className: 'fm-file-list' },
          files.path === '/' ? null : h('button', {
            className: 'fm-file-row fm-file-up',
            onClick: () => files.go(files.parent),
          }, h('span', { className: 'fm-file-name' }, '..')),
          files.entries.length === 0
            ? h('div', { className: 'fm-empty' }, files.loading ? t('files.loading') : t('files.empty'))
            : files.entries.map((entry) => h('div', { key: entry.path, className: 'fm-file-row' },
              h('button', {
                className: 'fm-file-name',
                onClick: () => { if (entry.isDirectory) files.go(entry.path) },
              }, `${entry.isDirectory ? '📁' : '📄'} ${entry.name}`),
              h('span', { className: 'fm-file-size' }, entry.isDirectory ? '—' : fmtBytes(entry.size)),
              h('span', { className: 'fm-file-time' }, entry.mtime === null ? '—' : fmtTime(entry.mtime)),
              h('span', { className: 'fm-file-actions' },
                entry.isDirectory ? null : h('a', {
                  className: 'fm-btn tiny',
                  href: `${API_BASE}/fs/download?alias=${encodeURIComponent(props.alias)}&path=${encodeURIComponent(entry.path)}`,
                }, t('files.download')),
                h('button', {
                  className: 'fm-btn tiny',
                  onClick: () => { setEditing({ kind: 'rename', path: entry.path }); setDraft(entry.name) },
                }, t('files.rename')),
                h('button', {
                  className: 'fm-btn tiny fm-danger',
                  onClick: () => handle(async () => {
                    await api('/fs/delete', {
                      method: 'POST',
                      body: JSON.stringify({ alias: props.alias, path: entry.path, recursive: entry.isDirectory }),
                    })
                  }, 'delete'),
                }, t('action.delete')))))),

        h('p', { className: 'fm-dim', style: { fontSize: 11 } }, t('files.hint')),
      )
    }

    /** The last segment of a path, for a rename placeholder. */
    function posixName(path) {
      const cut = String(path).lastIndexOf('/')
      return cut === -1 ? String(path) : String(path).slice(cut + 1)
    }

    function HostDetail(props) {
      const node = props.node
      const history = useHistory(node.alias, true)
      const detail = useDetail(node.alias, true)
      // The open/closed state of the terminal lives in the page, not here: the
      // snapshot arrives over SSE every 30 seconds, and a component that owned
      // this state would lose the session on every refresh.
      const terminalOpen = props.terminalOpen === true
      const filesOpen = props.filesOpen === true
      const hardware = detail?.hardware ?? null
      const points = history.points
      const series = (pick) => points.map((point) => pick(point)).reverse()
      const memPct = points.map((point) => (
        point.memUsed !== null && point.memTotal ? (point.memUsed / point.memTotal) * 100 : null
      )).reverse()
      return h('div', { className: 'fm-detail' },
        h('div', { className: 'fm-detail-head' },
          h('StatusPill', { status: node.status }),
          h('strong', null, node.displayName ?? node.alias),
          node.displayName === null || node.displayName === undefined
            ? null
            : h('span', { className: 'fm-mono fm-dim' }, node.alias),
          h('span', { className: 'fm-mono fm-dim' }, `${node.user}@${node.host}:${node.port}`),
          node.source === 'panel' ? null : h(Tag, null, t(`source.${node.source}`)),
          node.expireAt === null || node.expireAt === undefined
            ? null
            : h(Tag, null, `${t('meta.expireAt')} ${fmtTime(node.expireAt)}`),
          h('span', { className: 'fm-spacer' }),
          h('button', {
            className: 'fm-btn tiny',
            onClick: props.onToggleTerminal,
          }, terminalOpen ? t('terminal.hide') : t('terminal.open')),
          h('button', {
            className: 'fm-btn tiny',
            onClick: props.onToggleFiles,
          }, filesOpen ? t('files.hide') : t('files.open')),
          h('button', {
            className: 'fm-btn tiny',
            onClick: () => props.onEditMeta(node.alias),
          }, t('meta.edit')),
          h('button', { className: 'fm-btn tiny', onClick: props.onClose }, t('action.close'))),

        h('div', { className: 'fm-grid' },
          h(Field, { label: t('detail.system'), value: node.os?.name ?? '—' }),
          h(Field, { label: t('detail.kernel'), value: node.os?.kernel ?? '—', mono: true }),
          h(Field, { label: t('detail.cores'), value: node.cores ?? '—' }),
          h(Field, { label: t('detail.model'), value: node.cpuModel ?? '—' }),
          h(Field, { label: t('col.latency'), value: fmtMs(node.latencyMs) }),
          h(Field, { label: t('col.uptime'), value: fmtUptime(node.uptimeSec) }),
          h(Field, {
            label: t('detail.swap'),
            value: node.swap?.total ? `${fmtBytes(node.swap.used)} / ${fmtBytes(node.swap.total)}` : '—',
          }),
          h(Field, {
            label: t('detail.conn'),
            value: `${node.conn?.tcp ?? '—'} / ${node.conn?.udp ?? '—'}`,
          }),
          h(Field, { label: t('detail.procs'), value: node.procs ?? '—' }),
          h(Field, {
            label: t('col.tags'),
            value: Array.isArray(node.tags) && node.tags.length > 0 ? node.tags.join(', ') : '—',
          })),

        node.lastError === null || node.lastError === undefined
          ? null
          : h('div', { className: 'fm-field' },
            h('span', { className: 'fm-field-label' }, t('detail.error')),
            h('span', { className: 'fm-error' }, node.lastError)),

        h(HardwareBlock, { hardware }),

        h('div', { className: 'fm-chart-label' }, t('detail.history')),
        h('div', { className: 'fm-charts' },
          h('div', { className: 'fm-chart' },
            h('span', { className: 'fm-chart-label' }, t('detail.cpu')),
            h(Sparkline, { values: series((point) => point.cpuPct), max: 100, colour: utilColor(node.cpuPct) })),
          h('div', { className: 'fm-chart' },
            h('span', { className: 'fm-chart-label' }, t('detail.mem')),
            h(Sparkline, { values: memPct, max: 100, colour: '#8b5cf6' })),
          h('div', { className: 'fm-chart' },
            h('span', { className: 'fm-chart-label' }, t('detail.net')),
            h(Sparkline, {
              values: series((point) => (point.rxBps === null || point.rxBps === undefined ? null : point.rxBps / 1024)),
              colour: '#0ea5e9',
            }))),

        history.error === null
          ? null
          : h('span', { className: 'fm-error' }, history.error.message),

        terminalOpen
          ? h(TerminalView, { alias: node.alias, onClose: props.onToggleTerminal })
          : null,

        filesOpen
          ? h(FilePanel, { alias: node.alias, open: true, onClose: props.onToggleFiles })
          : null)
    }

    // ── rows ───────────────────────────────────────────────────────────────

    /**
     * One table row.
     * @param props.node - snapshot entry.
     * @param props.onOpen - select this host.
     * @param props.selected - whether the detail is showing for it.
     * @param props.onEdit - edit a panel-owned host.
     * @param props.onDelete - delete a panel-owned host.
     */
    function HostRow(props) {
      const node = props.node
      const owned = node.source === 'panel'
      return h('tr', {
        className: `fm-row ${node.status === 'offline' ? 'offline' : ''} ${props.selected ? 'selected' : ''}`,
        onClick: () => props.onOpen(node.alias),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onOpen(node.alias)
          }
        },
        tabIndex: 0,
      },
      h('td', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 500 } }, node.displayName ?? node.alias),
          node.alerts.includes('cpu') || node.alerts.includes('mem') || node.alerts.includes('disk')
            ? h('span', { className: 'fm-dot', style: { background: '#f59e0b' }, title: node.alerts.join(', ') })
            : null),
        h('div', { className: 'fm-mono fm-dim' }, node.displayName === null || node.displayName === undefined
          ? `${node.host}:${node.port}`
          : `${node.alias} · ${node.host}:${node.port}`)),
      h('td', null, h(StatusPill, { status: node.status })),
      h('td', { className: 'fm-dim', style: { maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        node.os?.name ?? '—'),
      h('td', null, h(Meter, { pct: node.cpuPct })),
      h('td', null, h(Meter, { pct: node.mem?.pct })),
      h('td', null, h(Meter, { pct: node.disk?.pct })),
      h('td', { className: 'fm-num fm-dim', style: { whiteSpace: 'nowrap' } },
        `${fmtBytes(node.net?.rxBps)}/s ↓`),
      h('td', { className: 'fm-num fm-dim' },
        node.load[0] === null ? '—' : node.load[0].toFixed(2)),
      h('td', { className: 'fm-num fm-dim' }, fmtMs(node.latencyMs)),
      h('td', { className: 'fm-num fm-dim' }, fmtUptime(node.uptimeSec)),
      h('td', null, owned
        ? h('div', { style: { display: 'flex', gap: 4 } },
          h('button', {
            className: 'fm-btn tiny',
            onClick: (event) => { event.stopPropagation(); props.onEdit(node.alias) },
          }, t('action.edit')),
          h('button', {
            className: 'fm-btn tiny danger',
            onClick: (event) => { event.stopPropagation(); props.onDelete(node.alias) },
          }, t('action.delete')))
        : h('span', { className: 'fm-dim', style: { fontSize: 11 } }, t(`source.${node.source}`))))
    }

    /** One card in the card view. */
    function HostCard(props) {
      const node = props.node
      return h('div', {
        className: `fm-card ${node.status === 'offline' ? 'offline' : ''} ${props.selected ? 'selected' : ''}`,
        onClick: () => props.onOpen(node.alias),
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onOpen(node.alias)
          }
        },
      },
      h('div', { className: 'fm-card-head' },
        h('span', { className: 'fm-dot', style: { background: statusColor(node.status) } }),
        h('span', { className: 'fm-card-name', title: node.alias }, node.displayName ?? node.alias),
        h('span', { className: 'fm-spacer' }),
        node.source === 'panel'
          ? h('button', {
            className: 'fm-btn tiny',
            onClick: (event) => { event.stopPropagation(); props.onEdit(node.alias) },
          }, t('action.edit'))
          : null),
      h('div', { className: 'fm-mono fm-dim' }, `${node.host}:${node.port}`),
      h('div', { className: 'fm-card-metrics' },
        h(Meter, { pct: node.cpuPct }),
        h(Meter, { pct: node.mem?.pct }),
        h(Meter, { pct: node.disk?.pct })),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--fm-muted)' } },
        h('span', null, node.os?.name ?? '—'),
        h('span', null, '·'),
        h('span', null, fmtMs(node.latencyMs)),
        h('span', null, '·'),
        h('span', null, fmtUptime(node.uptimeSec))))
    }

    // ── page ───────────────────────────────────────────────────────────────

    /** The panel itself. */
    // ── sections ───────────────────────────────────────────────────────────

    /** The views inside the panel, in navigation order. */
    const SECTIONS = ['overview', 'servers', 'services', 'alerts', 'tasks', 'settings']

    /**
     * The active section, kept in the URL hash.
     *
     * Hash routing rather than component state: the panel occupies one slot, so a
     * reload has to land the reader back on the view they were reading.
     */
    function useSection() {
      const read = () => {
        if (typeof window === 'undefined') return 'overview'
        const raw = String(window.location.hash ?? '').replace(/^#\/?/, '')
        return SECTIONS.includes(raw) ? raw : 'overview'
      }
      const [section, setSection] = useState(read)
      useEffect(() => {
        const onHash = () => setSection(read())
        window.addEventListener('hashchange', onHash)
        return () => window.removeEventListener('hashchange', onHash)
      }, [])
      const go = (next) => {
        if (typeof window !== 'undefined') window.location.hash = `#/${next}`
        setSection(next)
      }
      return [section, go]
    }

    /** One "not wired up yet" view, so a tab never looks broken. */
    function SectionPending(props) {
      return h('div', { className: 'fm-empty' },
        h('h3', null, t('pending.title')),
        h('p', null, `${t(`nav.${props.section}`)} — ${t('pending.body')}`))
    }

    /**
     * The fixed 30-cell strip, oldest on the left and newest on the right.
     *
     * Short histories are padded on the left rather than stretched, so a probe
     * that started ten minutes ago does not look like it has been up all day.
     */
    function ProbeGrid(props) {
      const cells = Array.isArray(props.cells) ? props.cells : []
      const offset = 30 - cells.length
      const slots = []
      for (let index = 0; index < 30; index += 1) {
        const cell = index < offset ? null : cells[index - offset]
        let title = t('services.noData')
        let tone = ''
        if (cell !== null && cell !== undefined) {
          tone = cell.ok ? 'ok' : 'bad'
          title = `${fmtTime(cell.ts)} · ${cell.ok
            ? (cell.latencyMs === null || cell.latencyMs === undefined ? t('services.up') : `${cell.latencyMs} ms`)
            : (cell.error ?? t('services.down'))}`
        }
        slots.push(h('span', { key: index, className: `fm-cell ${tone}`.trim(), title }))
      }
      return h('span', { className: 'fm-grid30' }, slots)
    }

    /** One probe: definition on the left, verdict and strip on the right. */
    function ProbeRow(props) {
      const probe = props.probe
      const latest = probe.latest ?? null
      const latency = latest === null || latest.latencyMs === null || latest.latencyMs === undefined
        ? '—'
        : `${latest.latencyMs} ms`
      return h('div', { className: 'fm-probe' },
        h('div', { className: 'fm-probe-id' },
          h('span', { className: 'fm-probe-name' }, probe.name),
          h('span', { className: 'fm-tag' }, t(`services.type${probe.type}`)),
          h('span', { className: 'fm-probe-target' }, probe.target),
          h('span', { className: 'fm-probe-every' }, `${probe.intervalSec}s`)),
        h('div', { className: 'fm-probe-state' },
          h('span', { className: `fm-pill ${latest === null ? 'neutral' : latest.ok ? 'ok' : 'danger'}` },
            latest === null ? t('services.never') : latest.ok ? t('services.up') : t('services.down')),
          h('span', { className: 'fm-probe-latency' }, latency),
          latest !== null && latest.certDays !== null && latest.certDays !== undefined
            ? h('span', { className: 'fm-probe-cert' }, t('services.cert', { days: latest.certDays }))
            : null,
          h('button', {
            type: 'button',
            className: 'fm-row-btn',
            onClick: () => props.onDelete(probe),
          }, t('action.delete'))),
        h(ProbeGrid, { cells: probe.grid }),
        latest !== null && latest.error ? h('div', { className: 'fm-error' }, latest.error) : null)
    }

    /** Add or edit one probe. */
    function ProbeForm(props) {
      const record = props.record ?? {}
      const [name, setName] = useState(record.name ?? '')
      const [type, setType] = useState(String(record.type ?? 1))
      const [target, setTarget] = useState(record.target ?? '')
      const [intervalSec, setIntervalSec] = useState(String(record.intervalSec ?? 60))
      const [timeoutMs, setTimeoutMs] = useState(String(record.timeoutMs ?? 5000))
      const [expectStatus, setExpectStatus] = useState(record.expectStatus ?? '')
      const [expectKeyword, setExpectKeyword] = useState(record.expectKeyword ?? '')
      const [enabled, setEnabled] = useState(record.enabled !== false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      if (!props.open) return null

      const submit = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        setError(null)
        setBusy(true)
        try {
          await props.onSubmit({
            ...(record.id === undefined ? {} : { id: record.id }),
            name: name.trim(),
            type: Number(type),
            target: target.trim(),
            intervalSec: Number(intervalSec),
            timeoutMs: Number(timeoutMs),
            expectStatus: expectStatus.trim(),
            expectKeyword: expectKeyword.trim(),
            enabled,
          })
          props.onClose()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const line = (label, control) => h('label', { className: 'fm-field' },
        h('span', null, label), control)
      const text = (value, onChange, placeholder) => h('input', {
        type: 'text',
        value,
        placeholder,
        onChange: event => onChange(event.target.value),
      })

      return h('div', { className: 'fm-overlay', onClick: event => { if (event.target === event.currentTarget) props.onClose() } },
        h('form', { className: 'fm-modal', onSubmit: submit },
          h('h3', null, props.record === null ? t('services.add') : t('services.edit')),
          line(t('form.name'), text(name, setName, 'api-health')),
          line(t('form.type'), h('select', { value: type, onChange: event => setType(event.target.value) },
            h('option', { value: '1' }, t('services.type1')),
            h('option', { value: '2' }, t('services.type2')),
            h('option', { value: '3' }, t('services.type3')))),
          line(t('form.target'), text(target, setTarget, Number(type) === 1 ? 'https://example.com/health' : Number(type) === 2 ? 'db.internal:5432' : '10.0.0.1')),
          h('div', { className: 'fm-row2' },
            line(t('form.interval'), h('input', { type: 'number', min: '10', value: intervalSec, onChange: event => setIntervalSec(event.target.value) })),
            line(t('form.timeout'), h('input', { type: 'number', min: '500', step: '100', value: timeoutMs, onChange: event => setTimeoutMs(event.target.value) }))),
          Number(type) === 1
            ? h('div', null,
              line(t('form.expectStatus'), text(expectStatus, setExpectStatus, '2xx')),
              line(t('form.expectKeyword'), text(expectKeyword, setExpectKeyword, 'healthy')))
            : null,
          h('label', { className: 'fm-check' },
            h('input', { type: 'checkbox', checked: enabled, onChange: event => setEnabled(event.target.checked) }),
            h('span', null, t('form.enabled'))),
          error === null ? null : h('div', { className: 'fm-error' }, error),
          h('div', { className: 'fm-modal-actions' },
            h('button', { type: 'button', className: 'fm-btn', onClick: props.onClose, disabled: busy }, t('action.cancel')),
            h('button', { type: 'submit', className: 'fm-btn primary', disabled: busy }, t('action.save')))))
    }

    /** Service monitoring: the probes the host runs, with their 30-cell history. */
    function ServicesSection(props) {
      const { probes, error, onAdd, onDelete } = props
      return h('div', { className: 'fm-panel' },
        h('div', { className: 'fm-toolbar' },
          h('span', { className: 'fm-note' }, t('services.note')),
          h('button', { type: 'button', className: 'fm-btn primary', onClick: onAdd }, t('services.add'))),
        error === null || error === undefined ? null : h('div', { className: 'fm-error' }, error.message ?? String(error)),
        probes.length === 0
          ? h('div', { className: 'fm-empty' },
            h('h3', null, t('services.emptyTitle')),
            h('p', null, t('services.emptyBody')))
          : h('div', { className: 'fm-probes' },
            probes.map(probe => h(ProbeRow, { key: probe.id, probe, onDelete }))))
    }

    /** The overview: counts, what is alerting, and what is down. */
    /**
     * One 24 hour availability strip.
     *
     * A `null` cell is drawn hollow: it means nobody was collecting, not that the
     * host was down. The current hour is tinted because it is still filling.
     */
    function UptimeStrip(props) {
      const cells = Array.isArray(props.cells) ? props.cells : []
      return h('div', { className: 'fm-uptime' }, cells.map((cell, index) =>
        h('span', {
          key: index,
          className: 'fm-uptime-cell' + (
            cell === null ? ' none' : cell < 0.5 ? ' bad' : cell < 0.9 ? ' warn' : ' ok'
          ) + (props.currentIndex === index ? ' now' : ''),
          title: `${fmtHour(props.from, index)} · ${cell === null ? t('overview.noSamples') : fmtPct(cell * 100)}`,
        })))
    }

    function uptimeAverage(cells) {
      const values = (cells ?? []).filter((cell) => cell !== null)
      if (values.length === 0) return null
      return values.reduce((sum, value) => sum + value, 0) / values.length
    }

    function OverviewSection(props) {
      const nodes = props.nodes
      const counts = props.counts
      const uptime = props.uptime ?? {}
      const alerting = nodes.filter((node) => node.alerts.some((alert) => alert !== 'offline'))
      const offline = nodes.filter((node) => node.status === 'offline')
      const memTotal = nodes.reduce((sum, node) => sum + (node.mem?.total ?? 0), 0)
      const diskTotal = nodes.reduce((sum, node) => sum + (node.disk?.total ?? 0), 0)
      const onlinePct = counts.total === 0 ? null : (counts.online / counts.total) * 100
      const fleet = uptimeAverage(uptime.fleet)
      const currentIndex = Number.isInteger(uptime.currentHour) && Number.isInteger(uptime.from)
        ? Math.floor((uptime.currentHour - uptime.from) / 3_600_000)
        : -1
      const tracked = nodes
        .filter((node) => (node.uptime24 ?? []).some((cell) => cell !== null))
        .sort((a, b) => (uptimeAverage(a.uptime24) ?? 1) - (uptimeAverage(b.uptime24) ?? 1))
        .slice(0, 12)
      const cards = (list) => h('div', { className: 'fm-cards' }, list.map((node) => h(HostCard, {
        key: node.alias,
        node,
        selected: false,
        onOpen: props.onOpen,
        onEdit: props.onEdit,
      })))
      return [
        h('div', { className: 'fm-stats' },
          [
            ['stat.total', counts.total],
            ['stat.online', counts.online],
            ['stat.alerting', counts.alerting],
            ['stat.offline', counts.offline],
          ].map(([key, value]) => h('div', { key, className: 'fm-stat' },
            h('span', { className: 'fm-stat-label' }, t(key)),
            h('span', { className: 'fm-stat-value' }, value)))),
        h('div', { className: 'fm-grid' },
          h(Field, { label: t('overview.uptimeHead'), value: onlinePct === null ? '—' : fmtPct(onlinePct) }),
          h(Field, { label: t('overview.fleetHead'), value: fleet === null ? '—' : fmtPct(fleet * 100) }),
          h(Field, { label: t('overview.memTotal'), value: fmtBytes(memTotal) }),
          h(Field, { label: t('overview.diskTotal'), value: fmtBytes(diskTotal) }),
          h(Field, { label: t('settings.sweep'), value: fmtTime(props.lastRunAt) })),
        h('div', { className: 'fm-chart-label' }, `${t('overview.fleet24')} (${uptime.measuredHosts ?? 0})`),
        fleet === null
          ? h('div', { className: 'fm-empty' }, h('p', null, t('overview.noSamples')))
          : [
            h('div', { className: 'fm-uptime-row' },
              h('span', { className: 'fm-uptime-name' }, t('overview.fleetHead')),
              h(UptimeStrip, { cells: uptime.fleet, from: uptime.from, currentIndex }),
              h('span', { className: 'fm-uptime-pct' }, fmtPct(fleet * 100))),
            ...tracked.map((node) => h('div', { key: node.alias, className: 'fm-uptime-row' },
              h('span', { className: 'fm-uptime-name' }, node.displayName ?? node.alias),
              h(UptimeStrip, { cells: node.uptime24, from: uptime.from, currentIndex }),
              h('span', { className: 'fm-uptime-pct' }, fmtPct((uptimeAverage(node.uptime24) ?? 0) * 100)))),
          ],
        h('div', { className: 'fm-chart-label' }, `${t('overview.alerts')} (${alerting.length})`),
        alerting.length === 0
          ? h('div', { className: 'fm-empty' }, h('p', null, t('overview.quiet')))
          : cards(alerting),
        h('div', { className: 'fm-chart-label' }, `${t('overview.offline')} (${offline.length})`),
        offline.length === 0 ? null : cards(offline),
      ]
    }

    /**
     * The plugin's own settings: values the panel may change at runtime.
     *
     * These are stored in the plugin's database and merged over the host config,
     * because a volatile() config field belongs to the host loader and a plugin
     * can read it but never write it. Saving here re-arms the collector, so a new
     * cadence applies immediately rather than on the next restart.
     */
    function useSettings() {
      const [state, setState] = useState({ values: {}, overridden: [], editable: [], error: null, loaded: false })

      const reload = useCallback(async () => {
        try {
          const body = await api('/settings')
          setState({
            values: body?.values ?? {},
            overridden: Array.isArray(body?.overridden) ? body.overridden : [],
            editable: Array.isArray(body?.editable) ? body.editable : [],
            error: null,
            loaded: true,
          })
        } catch (failure) {
          setState((previous) => ({ ...previous, error: failure, loaded: true }))
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async (values) => {
        const body = await api('/settings', { method: 'POST', body: JSON.stringify({ values }) })
        setState((previous) => ({
          ...previous,
          values: body?.values ?? previous.values,
          overridden: Array.isArray(body?.overridden) ? body.overridden : previous.overridden,
          error: null,
        }))
      }, [])

      const reset = useCallback(async () => {
        const body = await api('/settings', { method: 'DELETE' })
        setState((previous) => ({
          ...previous,
          values: body?.values ?? previous.values,
          overridden: [],
          error: null,
        }))
      }, [])

      return { ...state, reload, save, reset }
    }

    /** Settings: the runtime facts, then the values this panel is allowed to change. */
    function SettingsSection(props) {
      const snapshot = props.snapshot ?? {}
      const settings = props.settings ?? { values: {}, overridden: [], editable: [], error: null }
      const [draft, setDraft] = useState({})
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      // A fresh read wins over an abandoned edit, so the form never shows values
      // that are no longer in force.
      useEffect(() => {
        setDraft({})
        setNotice(null)
      }, [settings.values, settings.overridden])

      const valueOf = (key) => {
        if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
        const current = settings.values[key]
        if (Array.isArray(current)) return current.join(', ')
        return current === undefined || current === null ? '' : String(current)
      }

      const edit = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }))

      const collect = () => {
        const out = {}
        for (const field of settings.editable) {
          const raw = valueOf(field.key)
          const current = settings.values[field.key]
          if (field.kind === 'number') {
            const number = Number(raw)
            if (!Number.isFinite(number)) continue
            // Only what actually changed is sent: pinning every field would mean
            // the plugin stops following the host config for values nobody edited.
            if (typeof current === 'number' && current === number) continue
            out[field.key] = number
          } else if (field.kind === 'boolean') {
            const flag = raw === true || raw === 'true'
            if (current === flag) continue
            out[field.key] = flag
          } else {
            const list = String(raw).split(',').map((item) => item.trim()).filter((item) => item !== '')
            if (Array.isArray(current) && current.join(',') === list.join(',')) continue
            out[field.key] = list
          }
        }
        return out
      }

      const submit = async () => {
        const changes = collect()
        if (Object.keys(changes).length === 0) {
          // Nothing to send: an empty body is refused by the route on purpose, so
          // asking would only produce an error message for a no-op.
          setDraft({})
          setNotice(t('settings.unchanged'))
          return
        }
        setBusy(true)
        setNotice(null)
        try {
          await props.onSave(changes)
          setDraft({})
          setNotice(t('settings.saved'))
        } catch (failure) {
          setNotice(`${t('settings.saveFailed')}: ${failure.message}`)
        } finally {
          setBusy(false)
        }
      }

      const restore = async () => {
        setBusy(true)
        setNotice(null)
        try {
          await props.onReset()
          setDraft({})
          setNotice(t('settings.restored'))
        } catch (failure) {
          setNotice(`${t('settings.saveFailed')}: ${failure.message}`)
        } finally {
          setBusy(false)
        }
      }

      const rows = settings.editable.map((field) => {
        const pinned = settings.overridden.includes(field.key)
        const label = t(`settings.key.${field.key}`)
        const name = label === `settings.key.${field.key}` ? field.key : label
        const control = field.kind === 'boolean'
          ? h('select', {
            className: 'fm-input',
            value: valueOf(field.key),
            onChange: (event) => edit(field.key, event.target.value),
          }, [
            h('option', { key: 'on', value: 'true' }, t('settings.on')),
            h('option', { key: 'off', value: 'false' }, t('settings.off')),
          ])
          : h('input', {
            className: 'fm-input',
            type: field.kind === 'number' ? 'number' : 'text',
            min: field.min,
            max: field.max,
            value: valueOf(field.key),
            onChange: (event) => edit(field.key, event.target.value),
          })
        return h(Field, {
          key: field.key,
          label: pinned ? `${name} · ${t('settings.pinned')}` : name,
          hint: field.kind === 'number' ? `${field.min} ~ ${field.max}` : undefined,
        }, control)
      })

      return h('div', { className: 'fm-panel' }, [
        h('div', { className: 'fm-chart-label' }, t('settings.runtime')),
        h('div', { className: 'fm-grid' },
          h(Field, { label: t('settings.state'), value: snapshot.running === true ? t('settings.running') : t('settings.stopped') }),
          h(Field, { label: t('settings.backend'), value: snapshot.backend ?? '—' }),
          h(Field, { label: t('settings.sweep'), value: fmtTime(snapshot.lastRunAt) }),
          h(Field, {
            label: t('footer.took'),
            value: snapshot.lastRunMs === undefined || snapshot.lastRunMs === null
              ? '—'
              : `${Math.round(snapshot.lastRunMs)} ms`,
          })),

        h('div', { className: 'fm-chart-label', style: { marginTop: 16 } }, t('settings.adjust')),
        settings.error === null
          ? null
          : h('p', { className: 'fm-error-text' }, settings.error.message),
        h('div', { className: 'fm-settings-grid' }, rows),
        notice === null ? null : h('p', { className: 'fm-dim', style: { fontSize: 11.5 } }, notice),
        h('div', { className: 'fm-form-actions', style: { justifyContent: 'flex-start' } },
          h('button', { className: 'fm-btn fm-primary', disabled: busy, onClick: () => { void submit() } }, t('settings.save')),
          h('button', { className: 'fm-btn', disabled: busy, onClick: () => { void restore() } }, t('settings.restore'))),
        h('p', { className: 'fm-dim', style: { fontSize: 11 }} , t('settings.howto')),
      ])
    }

    /** The 19 metrics the engine can read, in the order an operator scans them. */
    const METRIC_ORDER = [
      'cpu', 'memory', 'swap', 'disk', 'load1', 'load5', 'load15',
      'temperature_max', 'gpu', 'net_in_speed', 'net_out_speed', 'net_all_speed',
      'tcp_conn_count', 'udp_conn_count', 'process_count', 'offline',
      'transfer_in', 'transfer_out', 'transfer_all',
    ]

    function metricLabel(metric) {
      const key = `metric.${metric}`
      const label = t(key)
      return label === key ? metric : label
    }

    /** One row of the rule list. */
    function RuleRow(props) {
      const rule = props.rule
      const rounds = Math.max(1, Math.round((rule.durationSec * 1000) / props.intervalMs))
      const group = props.groups.find((item) => item.id === rule.notifyGroupId)
      const scope = rule.scope ?? { mode: 'all', aliases: [] }
      const scopeText = scope.mode === 'all'
        ? t('form.scopeAll')
        : `${t(scope.mode === 'include' ? 'form.scopeInclude' : 'form.scopeExclude')} ${scope.aliases.join(', ')}`
      return h('div', { className: `fm-rule${rule.enabled === false ? ' fm-rule-off' : ''}` },
        h('div', { className: 'fm-rule-main' },
          h('span', { className: 'fm-rule-name' }, rule.name),
          h('span', { className: 'fm-rule-expr' }, `${metricLabel(rule.metric)} ${rule.op === 'lt' ? '<' : '>'} ${rule.threshold}`),
          h('span', { className: 'fm-probe-every' }, `${rule.durationSec}s · ${rounds} ${t('alerts.rounds')} · ${t('alerts.cooldown')} ${rule.cooldownSec}s`),
          h('span', { className: 'fm-dim', style: { fontSize: 11.5 } }, scopeText)),
        h('div', { className: 'fm-rule-side' },
          group === undefined ? null : h(Tag, null, group.name),
          rule.enabled === false ? h('span', { className: 'fm-pill' }, t('alerts.off')) : null,
          h('button', { className: 'fm-row-btn', onClick: () => props.onEdit(rule) }, t('action.edit')),
          h('button', { className: 'fm-row-btn', onClick: () => props.onSilence(rule) }, t('alerts.silence')),
          h('button', { className: 'fm-row-btn fm-danger', onClick: () => props.onDelete(rule) }, t('action.delete'))))
    }

    /** Create or edit one rule. */
    function RuleForm(props) {
      const rule = props.rule
      const [name, setName] = useState(rule?.name ?? '')
      const [metric, setMetric] = useState(rule?.metric ?? 'cpu')
      const [op, setOp] = useState(rule?.op ?? 'gt')
      const [threshold, setThreshold] = useState(rule === null || rule === undefined ? '85' : String(rule.threshold))
      const [durationSec, setDurationSec] = useState(String(rule?.durationSec ?? 180))
      const [cooldownSec, setCooldownSec] = useState(String(rule?.cooldownSec ?? 1800))
      const [notifyGroupId, setNotifyGroupId] = useState(String(rule?.notifyGroupId ?? ''))
      const [mode, setMode] = useState(rule?.scope?.mode ?? 'all')
      const [aliases, setAliases] = useState((rule?.scope?.aliases ?? []).join(', '))
      const [enabled, setEnabled] = useState(rule?.enabled !== false)
      const [problem, setProblem] = useState(null)
      const [busy, setBusy] = useState(false)

      if (!props.open) return null

      const submit = async () => {
        const parsedThreshold = Number(threshold)
        if (name.trim() === '') { setProblem(t('error.nameRequired')); return }
        if (!Number.isFinite(parsedThreshold)) { setProblem(t('error.thresholdRequired')); return }
        setProblem(null)
        setBusy(true)
        try {
          await props.onSubmit({
            id: rule?.id,
            name: name.trim(),
            metric,
            op,
            threshold: parsedThreshold,
            durationSec: Number(durationSec) || 180,
            cooldownSec: Number(cooldownSec) || 0,
            notifyGroupId: notifyGroupId === '' ? null : Number(notifyGroupId),
            enabled,
            scope: {
              mode,
              aliases: mode === 'all' ? [] : aliases.split(',').map((item) => item.trim()).filter((item) => item !== ''),
            },
          })
          props.onClose()
        } catch (failure) {
          setProblem(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const line = (label, control) => h('div', { className: 'fm-field' }, h('span', null, label), control)
      const onEnter = (event) => { if (event.key === 'Enter') void submit() }
      const select = (value, onChange, options) => h('select', { value, onChange }, options)

      const fields = [
        h('h3', null, rule === null || rule === undefined ? t('alerts.newRule') : t('alerts.editRule')),
        line(t('form.name'), h('input', { value: name, placeholder: 'CPU 持续偏高', onChange: (event) => setName(event.target.value) })),
        line(t('form.metric'), select(metric, (event) => setMetric(event.target.value),
          METRIC_ORDER.map((item) => h('option', { key: item, value: item }, metricLabel(item))))),
        line(t('form.threshold'), h('input', { type: 'number', step: '0.1', value: threshold, onChange: (event) => setThreshold(event.target.value) })),
        line(t('form.op'), select(op, (event) => setOp(event.target.value), [
          h('option', { key: 'gt', value: 'gt' }, t('form.opGt')),
          h('option', { key: 'lt', value: 'lt' }, t('form.opLt')),
        ])),
        line(t('form.duration'), h('input', { type: 'number', min: '1', value: durationSec, onChange: (event) => setDurationSec(event.target.value) })),
        line(t('form.cooldown'), h('input', { type: 'number', min: '0', value: cooldownSec, onChange: (event) => setCooldownSec(event.target.value) })),
        line(t('form.group'), select(notifyGroupId, (event) => setNotifyGroupId(event.target.value), [
          h('option', { key: 'none', value: '' }, t('alerts.noGroup')),
          ...props.groups.map((item) => h('option', { key: String(item.id), value: String(item.id) }, item.name)),
        ])),
        line(t('form.scope'), select(mode, (event) => setMode(event.target.value), [
          h('option', { key: 'all', value: 'all' }, t('form.scopeAll')),
          h('option', { key: 'include', value: 'include' }, t('form.scopeInclude')),
          h('option', { key: 'exclude', value: 'exclude' }, t('form.scopeExclude')),
        ])),
        mode === 'all'
          ? null
          : line(t('form.aliases'), h('input', { value: aliases, placeholder: 'web-01, web-02', onChange: (event) => setAliases(event.target.value) })),
        h('label', { className: 'fm-check' },
          h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
          t('form.enabled')),
        problem === null ? null : h('p', { className: 'fm-error-text' }, problem),
        h('div', { className: 'fm-form-actions' },
          h('button', { className: 'fm-btn', onClick: props.onClose }, t('action.cancel')),
          h('button', { className: 'fm-btn fm-primary', disabled: busy, onClick: submit }, t('action.save'))),
      ]

      return h('div', { className: 'fm-overlay', onClick: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { className: 'fm-modal', onKeyDown: onEnter }, fields))
    }

    /** One notification channel row, with the send test. */
    function ChannelRow(props) {
      const channel = props.channel
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const send = async () => {
        setBusy(true)
        try {
          await props.onTest(channel)
          setResult({ ok: true })
        } catch (failure) {
          setResult({ ok: false, text: failure.message })
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'fm-rule' },
        h('div', { className: 'fm-rule-main' },
          h('span', { className: 'fm-rule-name' }, channel.name),
          h('span', { className: 'fm-probe-target' }, `${channel.method} ${channel.url}`),
          result === null
            ? null
            : h('span', { className: result.ok ? 'fm-ok-text' : 'fm-error-text' },
              result.ok ? t('notify.testOk') : `${t('notify.testFail')} ${result.text}`)),
        h('div', { className: 'fm-rule-side' },
          channel.enabled === false ? h('span', { className: 'fm-pill' }, t('alerts.off')) : null,
          h('button', { className: 'fm-row-btn', disabled: busy, onClick: send }, t('notify.test')),
          h('button', { className: 'fm-row-btn fm-danger', onClick: () => props.onDelete(channel) }, t('action.delete'))))
    }

    /** Create one notification channel, or prefill it from a preset. */
    function ChannelForm(props) {
      const [preset, setPreset] = useState('')
      const [name, setName] = useState('')
      const [url, setUrl] = useState('')
      const [method, setMethod] = useState('POST')
      const [bodyType, setBodyType] = useState('json')
      const [headers, setHeaders] = useState('{}')
      const [body, setBody] = useState('')
      const [verifyTls, setVerifyTls] = useState(true)
      const [problem, setProblem] = useState(null)
      const [busy, setBusy] = useState(false)

      if (!props.open) return null

      const applyPreset = (key) => {
        setPreset(key)
        const found = presetList.find((item) => item.id === key)
        if (found === undefined) return
        setName(found.name ?? key)
        setUrl(found.url ?? '')
        setMethod(found.method ?? 'POST')
        setBodyType(found.bodyType ?? 'json')
        setHeaders(found.headers ?? '{}')
        setBody(found.body ?? '')
      }

      const submit = async () => {
        if (name.trim() === '' || url.trim() === '') { setProblem(t('error.channelRequired')); return }
        setProblem(null)
        setBusy(true)
        try {
          await props.onSubmit({ name: name.trim(), url: url.trim(), method, bodyType, headers, body, verifyTls })
          props.onClose()
        } catch (failure) {
          setProblem(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const line = (label, control) => h('div', { className: 'fm-field' }, h('span', null, label), control)
      // The server ships presets as a list of `{ id, label, url, ... }`, so the
      // selector shows the label while the value stays the stable id.
      const presetList = Array.isArray(props.presets) ? props.presets : []
      const select = (value, onChange, options) => h('select', { value, onChange }, options)

      const fields = [
        h('h3', null, t('notify.newChannel')),
        presetList.length === 0
          ? null
          : line(t('notify.presets'), select(preset, (event) => applyPreset(event.target.value), [
            h('option', { key: 'none', value: '' }, '—'),
            ...presetList.map((item) => h('option', { key: item.id, value: item.id }, item.label ?? item.id)),
          ])),
        line(t('form.name'), h('input', { value: name, onChange: (event) => setName(event.target.value) })),
        line(t('notify.url'), h('input', { value: url, placeholder: 'https://…', onChange: (event) => setUrl(event.target.value) })),
        line(t('notify.method'), select(method, (event) => setMethod(event.target.value),
          ['POST', 'GET', 'PUT', 'PATCH'].map((item) => h('option', { key: item, value: item }, item)))),
        line(t('notify.bodyType'), select(bodyType, (event) => setBodyType(event.target.value), [
          h('option', { key: 'json', value: 'json' }, 'json'),
          h('option', { key: 'form', value: 'form' }, 'form'),
        ])),
        line(t('notify.headers'), h('textarea', { rows: 2, value: headers, onChange: (event) => setHeaders(event.target.value) })),
        line(t('notify.body'), h('textarea', { rows: 5, value: body, onChange: (event) => setBody(event.target.value) })),
        h('label', { className: 'fm-check' },
          h('input', { type: 'checkbox', checked: verifyTls, onChange: (event) => setVerifyTls(event.target.checked) }),
          t('notify.verifyTls')),
        props.placeholders.length === 0
          ? null
          : h('p', { className: 'fm-note' }, `${t('notify.placeholders')}: ${props.placeholders.join(' ')}`),
        problem === null ? null : h('p', { className: 'fm-error-text' }, problem),
        h('div', { className: 'fm-form-actions' },
          h('button', { className: 'fm-btn', onClick: props.onClose }, t('action.cancel')),
          h('button', { className: 'fm-btn fm-primary', disabled: busy, onClick: submit }, t('action.save'))),
      ]

      return h('div', { className: 'fm-overlay', onClick: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { className: 'fm-modal' }, fields))
    }

    /**
     * Scheduled commands.
     *
     * The list carries `nextRunAt` and the last run's summary, so the table answers
     * "did last night's backup actually run" without a request per row; run history
     * is fetched only for the row the operator opened.
     */
    function useTasks() {
      const [tasks, setTasks] = useState([])
      const [error, setError] = useState(null)

      const reload = useCallback(async () => {
        try {
          const body = await api('/tasks')
          setTasks(Array.isArray(body?.tasks) ? body.tasks : [])
          setError(null)
        } catch (failure) {
          setError(failure)
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const save = useCallback(async (task) => {
        await api('/tasks', { method: 'POST', body: JSON.stringify(task) })
        await reload()
      }, [reload])

      const remove = useCallback(async (id) => {
        await api(`/tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        await reload()
      }, [reload])

      const run = useCallback(async (id) => {
        const body = await api('/tasks/run', { method: 'POST', body: JSON.stringify({ id }) })
        await reload()
        return body
      }, [reload])

      const loadRuns = useCallback(async (id) => {
        try {
          const body = await api(`/tasks/runs?id=${encodeURIComponent(id)}&limit=20`)
          return Array.isArray(body?.runs) ? body.runs : []
        } catch {
          return []
        }
      }, [])

      return { tasks, error, reload, save, remove, run, loadRuns }
    }

    /**
     * A five-field expression rendered as the shortest true sentence.
     *
     * Only the shapes that can be said without lying are translated; everything
     * else is shown exactly as typed, because a confident wrong sentence is worse
     * than the expression itself.
     */
    function describeSchedule(expr) {
      const parts = String(expr ?? '').trim().split(/\s+/)
      if (parts.length !== 5) return String(expr ?? '')
      const [minute, hour, day, month, weekday] = parts
      const rest = day === '*' && month === '*' && weekday === '*'
      if (rest && minute === '*' && hour === '*') return t('task.everyMinute')
      if (rest && /^\*\/\d+$/.test(minute) && hour === '*') return t('task.everyNMinutes', { n: minute.slice(2) })
      if (rest && minute === '0' && hour === '*') return t('task.hourly')
      if (rest && /^\d+$/.test(minute) && hour === '*') return t('task.hourlyAt', { m: minute })
      if (rest && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
        return t('task.dailyAt', { time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` })
      }
      return String(expr ?? '')
    }

    /** Scheduled commands: what runs, when, and what the last run said. */
    function TaskRow(props) {
      const task = props.task
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)
      const [open, setOpen] = useState(false)

      const runNow = async () => {
        setBusy(true)
        setProblem(null)
        try {
          await props.onRun(task.id)
          setOpen(true)
        } catch (failure) {
          setProblem(failure.status === 409 ? t('task.busy') : failure.message)
        } finally {
          setBusy(false)
        }
      }

      const last = task.lastRun
      const state = last === null || last === undefined
        ? null
        : h('span', { className: `fm-pill ${last.ok ? 'fm-pill-ok' : 'fm-pill-danger'}` },
          last.ok ? t('task.ok') : t('task.failed'))

      return h('div', { className: `fm-task${task.enabled ? '' : ' fm-task-off'}` }, [
        h('div', { className: 'fm-task-main' }, [
          h('div', { className: 'fm-task-name' }, task.name),
          h('div', { className: 'fm-task-expr' },
            `${describeSchedule(task.schedule)} · ${task.schedule} · ${t('task.hosts', { n: (task.cover?.aliases ?? []).length || '—' })}`),
        ]),
        h('div', { className: 'fm-task-side' }, [
          state,
          h('span', { className: 'fm-dim' }, last === null || last === undefined
            ? t('task.never')
            : `${fmtAgo(last.ts)} · ${t('task.duration', { ms: last.durationMs ?? 0 })}`),
          h('span', { className: 'fm-dim' }, task.nextRunAt === null || task.nextRunAt === undefined
            ? '—'
            : `${t('task.nextRun')} ${fmtTime(task.nextRunAt)}`),
          h('button', { className: 'fm-btn fm-row-btn', disabled: busy, onClick: () => { void runNow() } },
            busy ? t('task.running') : t('task.runNow')),
          h('button', { className: 'fm-btn fm-row-btn', onClick: () => { setOpen(!open); if (!open) void props.onHistory(task.id) } },
            t('task.history')),
          h('button', { className: 'fm-btn fm-row-btn', onClick: () => props.onEdit(task) }, t('action.edit')),
          h('button', { className: 'fm-btn fm-row-btn fm-danger', onClick: () => props.onRemove(task.id) }, t('action.delete')),
        ]),
        problem === null ? null : h('p', { className: 'fm-error-text' }, problem),
        open ? h(TaskRuns, { runs: props.runs }) : null,
      ])
    }

    /** The stored tail of each run, newest first. */
    function TaskRuns(props) {
      const runs = Array.isArray(props.runs) ? props.runs : []
      if (runs.length === 0) return h('div', { className: 'fm-task-runs' }, h('span', { className: 'fm-dim' }, t('task.noHistory')))
      return h('div', { className: 'fm-task-runs' }, runs.map((run) => h('div', { key: run.id, className: 'fm-task-run' },
        h('span', { className: `fm-pill ${run.ok ? 'fm-pill-ok' : 'fm-pill-danger'}` },
          run.ok ? t('task.ok') : t('task.failed')),
        h('span', { className: 'fm-dim' }, `${fmtTime(run.ts)} · ${t('task.hosts', { n: run.total })} · ${t('task.duration', { ms: run.durationMs ?? 0 })}`),
        h('pre', { className: 'fm-run-output' }, run.output ?? ''))))
    }

    function TaskForm(props) {
      const task = props.task
      const [name, setName] = useState(task?.name ?? '')
      const [schedule, setSchedule] = useState(task?.schedule ?? '0 4 * * *')
      const [command, setCommand] = useState(task?.command ?? '')
      const [mode, setMode] = useState(task?.cover?.mode ?? 'all')
      const [aliases, setAliases] = useState((task?.cover?.aliases ?? []).join(', '))
      const [timeoutMs, setTimeoutMs] = useState(String(task?.timeoutMs ?? 60_000))
      const [enabled, setEnabled] = useState(task?.enabled !== false)
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      // Seeded once above, then refilled whenever the dialog opens for another
      // task. The guard sits after every hook: skipping hooks on a closed dialog
      // would change the hook count and crash the page the moment it opens.
      useEffect(() => {
        if (props.open !== true) return
        const editing = props.task
        setName(editing?.name ?? '')
        setSchedule(editing?.schedule ?? '0 4 * * *')
        setCommand(editing?.command ?? '')
        setMode(editing?.cover?.mode ?? 'all')
        setAliases((editing?.cover?.aliases ?? []).join(', '))
        setTimeoutMs(String(editing?.timeoutMs ?? 60_000))
        setEnabled(editing?.enabled !== false)
        setProblem(null)
        setBusy(false)
      }, [props.open, props.task])

      if (props.open !== true) return null

      const submit = async () => {
        if (name.trim() === '') { setProblem(t('error.nameRequired')); return }
        if (command.trim() === '') { setProblem(t('error.commandRequired')); return }
        if (schedule.trim() === '') { setProblem(t('error.scheduleRequired')); return }
        const list = aliases.split(',').map((item) => item.trim()).filter((item) => item !== '')
        if (mode === 'include' && list.length === 0) { setProblem(t('error.aliasesRequired')); return }
        setBusy(true)
        setProblem(null)
        try {
          await props.onSubmit({
            id: task?.id,
            name: name.trim(),
            schedule: schedule.trim(),
            command,
            cover: { mode, aliases: mode === 'all' ? [] : list },
            timeoutMs: Number(timeoutMs) || 60_000,
            enabled,
          })
          props.onClose()
        } catch (failure) {
          setProblem(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const fields = [
        h('h3', null, task === null || task === undefined ? t('task.newTask') : t('task.editTask')),
        h(Field, { label: t('form.name') },
          h('input', { className: 'fm-input', value: name, onChange: (event) => setName(event.target.value) })),
        h(Field, { label: t('task.schedule'), hint: describeSchedule(schedule) },
          h('input', { className: 'fm-input', value: schedule, placeholder: '0 4 * * *', onChange: (event) => setSchedule(event.target.value) })),
        h(Field, { label: t('task.command'), hint: t('task.commandHint') },
          h('textarea', { className: 'fm-input fm-textarea', rows: 3, value: command, onChange: (event) => setCommand(event.target.value) })),
        h(Field, { label: t('task.cover') },
          h('div', { className: 'fm-row2' },
            h('select', { className: 'fm-input', value: mode, onChange: (event) => setMode(event.target.value) }, [
              h('option', { key: 'all', value: 'all' }, t('task.scopeAll')),
              h('option', { key: 'include', value: 'include' }, t('task.scopeInclude')),
              h('option', { key: 'exclude', value: 'exclude' }, t('task.scopeExclude')),
            ]),
            h('input', {
              className: 'fm-input',
              value: aliases,
              disabled: mode === 'all',
              placeholder: 'web-01, db-01',
              onChange: (event) => setAliases(event.target.value),
            }))),
        h(Field, { label: t('task.timeout') },
          h('input', { className: 'fm-input', type: 'number', min: 1000, value: timeoutMs, onChange: (event) => setTimeoutMs(event.target.value) })),
        h('label', { className: 'fm-check' },
          h('input', { type: 'checkbox', checked: enabled, onChange: (event) => setEnabled(event.target.checked) }),
          h('span', null, t('task.enabled'))),
        problem === null ? null : h('p', { className: 'fm-error-text' }, problem),
        h('div', { className: 'fm-form-actions' },
          h('button', { className: 'fm-btn', onClick: props.onClose }, t('action.cancel')),
          h('button', { className: 'fm-btn fm-primary', disabled: busy, onClick: () => { void submit() } }, t('action.save'))),
      ]

      return h('div', { className: 'fm-overlay', onClick: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { className: 'fm-modal' }, fields))
    }

    /** Tasks: the schedule table plus the run history of the row that is open. */
    function TasksSection(props) {
      const tasks = props.tasks
      return h('div', { className: 'fm-panel' }, [
        h('div', { className: 'fm-toolbar' },
          h('span', { className: 'fm-dim', style: { fontSize: 12 } }, t('task.emptyBody')),
          h('div', { className: 'fm-toolbar-right' },
            h('button', { className: 'fm-btn fm-primary', onClick: props.onAdd }, t('task.add')))),
        tasks.error === null ? null : h('p', { className: 'fm-error-text' }, tasks.error.message),
        tasks.tasks.length === 0
          ? h('div', { className: 'fm-empty' }, h('p', null, t('task.emptyTitle')))
          : h('div', { className: 'fm-tasks' }, tasks.tasks.map((task) => h(TaskRow, {
            key: task.id,
            task,
            runs: props.runsFor(task.id),
            onRun: props.onRun,
            onHistory: props.onHistory,
            onEdit: props.onEdit,
            onRemove: props.onRemove,
          }))),
      ])
    }

    /** Alerts: the rules, the notifications they route to, and the recent events. */
    function AlertsSection(props) {
      const alerts = props.alerts
      const notify = props.notify
      const events = alerts.events.slice(0, 12)
      return h('div', { className: 'fm-panel' }, [
        h('div', { className: 'fm-toolbar' },
          h('span', { className: 'fm-dim', style: { fontSize: 12 } }, t('alerts.hint')),
          h('div', { className: 'fm-toolbar-right' },
            h('button', { className: 'fm-btn', onClick: props.onAddChannel }, t('notify.add')),
            h('button', { className: 'fm-btn fm-primary', onClick: props.onAddRule }, t('alerts.add')))),
        alerts.error === null ? null : h('p', { className: 'fm-error-text' }, alerts.error.message),

        h('div', { className: 'fm-chart-label' }, `${t('alerts.events')} (${alerts.events.length})`),
        events.length === 0
          ? h('div', { className: 'fm-empty' }, h('p', null, t('alerts.noEvents')))
          : h('div', { className: 'fm-events' }, events.map((event) => h('div', { key: event.id, className: 'fm-event' },
            h('span', { className: `fm-pill ${event.state === 'firing' ? 'fm-pill-danger' : 'fm-pill-ok'}` },
              event.state === 'firing' ? t('alerts.firing') : t('alerts.resolved')),
            h('span', { className: 'fm-event-alias' }, event.alias),
            h('span', { className: 'fm-event-message' }, event.message ?? ''),
            h('span', { className: 'fm-event-time' }, fmtTime(event.startedAt))))),

        h('div', { className: 'fm-chart-label' }, `${t('alerts.rules')} (${alerts.rules.length})`),
        alerts.rules.length === 0
          ? h('div', { className: 'fm-empty' }, h('p', null, t('alerts.emptyTitle')), h('p', { className: 'fm-dim' }, t('alerts.emptyBody')))
          : h('div', { className: 'fm-rules' }, alerts.rules.map((rule) => h(RuleRow, {
            key: rule.id,
            rule,
            groups: notify.groups,
            intervalMs: alerts.intervalMs,
            onEdit: props.onEditRule,
            onDelete: props.onDeleteRule,
            onSilence: props.onSilence,
          }))),

        h('div', { className: 'fm-chart-label' }, `${t('notify.title')} (${notify.channels.length})`),
        notify.channels.length === 0
          ? h('div', { className: 'fm-empty' }, h('p', null, t('notify.emptyTitle')), h('p', { className: 'fm-dim' }, t('notify.emptyBody')))
          : h('div', { className: 'fm-rules' }, notify.channels.map((channel) => h(ChannelRow, {
            key: channel.id,
            channel,
            onTest: notify.test,
            onDelete: props.onDeleteChannel,
          }))),

        notify.groups.length === 0 ? null : h('div', { className: 'fm-grid' }, notify.groups.map((group) => h(Field, {
          key: group.id,
          label: `${t('notify.group')} · ${group.name}`,
          value: group.channelIds.length === 0 ? '—' : String(group.channelIds.length),
        }))),
      ])
    }

    function FleetMonitorPage() {
      const fleet = useFleet()
      const hostsApi = useHosts()
      const metaApi = useMeta()
      const [filter, setFilter] = useState('all')
      const [sort, setSort] = useState('alias')
      const [view, setView] = useState('table')
      const [query, setQuery] = useState('')
      const [group, setGroup] = useState('')
      const [selected, setSelected] = useState(null)
      const [terminalAlias, setTerminalAlias] = useState(null)
      const [filesAlias, setFilesAlias] = useState(null)
      const [formOpen, setFormOpen] = useState(false)
      const [editing, setEditing] = useState(null)
      const [pendingDelete, setPendingDelete] = useState(null)
      const [section, go] = useSection()
      const [metaOpen, setMetaOpen] = useState(null)
      // `null` closes the form, `'new'` opens it blank, an id opens it filled.
      const [probeOpen, setProbeOpen] = useState(null)
      const probeApi = useProbes()
      const alertApi = useAlerts()
      const notifyApi = useNotifications()
      const settingsApi = useSettings()
      // `null` closes the dialog, `'new'` opens it blank, an id opens it filled.
      const [ruleOpen, setRuleOpen] = useState(null)
      const [channelOpen, setChannelOpen] = useState(false)
      const taskApi = useTasks()
      // `null` closes the dialog, `'new'` opens it blank, a task opens it filled.
      const [taskOpen, setTaskOpen] = useState(null)
      // Run history is loaded per task and kept keyed, so opening a second row
      // does not blank the first one's log.
      const [runsByTask, setRunsByTask] = useState({})

      useEffect(() => { ensureStyle() }, [])

      const nodes = Array.isArray(fleet.snapshot?.nodes) ? fleet.snapshot.nodes : []
      const managed = hostsApi.hosts
      const metaByAlias = metaApi.byAlias

      /**
       * Merge the live node with its panel record and its display metadata.
       *
       * `host_meta` wins over the connection record: the record is what the
       * operator typed when adding the host, the metadata is what they decided to
       * call it later, and the later decision should stick.
       */
      const decorated = useMemo(() => {
        const byAlias = new Map(managed.map((record) => [record.alias, record]))
        return nodes.map((node) => {
          const record = byAlias.get(node.alias)
          const meta = metaByAlias.get(node.alias)
          return {
            ...node,
            displayName: meta?.displayName ?? null,
            tags: meta?.tags ?? record?.tags ?? [],
            groupName: meta?.groupName ?? record?.groupName ?? null,
            note: meta?.note ?? record?.note ?? null,
            hidden: meta?.hidden === true,
            expireAt: meta?.expireAt ?? null,
            price: meta?.price ?? null,
            bandwidthGb: meta?.bandwidthGb ?? null,
          }
        })
      }, [nodes, managed, metaByAlias])

      const counts = useMemo(() => ({
        total: decorated.length,
        online: decorated.filter((node) => node.status === 'online').length,
        alerting: decorated.filter((node) => node.alerts.some((alert) => alert !== 'offline')).length,
        offline: decorated.filter((node) => node.status === 'offline').length,
      }), [decorated])

      const groups = useMemo(() => {
        const seen = new Set()
        for (const node of decorated) if (node.groupName !== null && node.groupName !== '') seen.add(node.groupName)
        return [...seen].sort()
      }, [decorated])

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        let list = decorated.filter((node) => {
          if (filter === 'online' && node.status !== 'online') return false
          if (filter === 'offline' && node.status !== 'offline') return false
          if (filter === 'alerting' && !node.alerts.some((alert) => alert !== 'offline')) return false
          if (filter === 'owned' && node.source !== 'panel') return false
          if (group !== '' && (node.groupName ?? '') !== group) return false
          if (needle === '') return true
          const haystack = [
            node.alias,
            node.displayName ?? '',
            node.host,
            node.user,
            node.os?.name ?? '',
            (node.tags ?? []).join(' '),
            node.groupName ?? '',
            node.note ?? '',
          ].join(' ').toLowerCase()
          return haystack.includes(needle)
        })
        const key = {
          alias: (node) => node.alias.toLowerCase(),
          cpu: (node) => node.cpuPct ?? -1,
          mem: (node) => node.mem?.pct ?? -1,
          disk: (node) => node.disk?.pct ?? -1,
          latency: (node) => node.latencyMs ?? Number.MAX_SAFE_INTEGER,
          status: (node) => node.status,
        }[sort] ?? ((node) => node.alias.toLowerCase())
        list = [...list].sort((a, b) => {
          const left = key(a)
          const right = key(b)
          if (left < right) return -1
          if (left > right) return 1
          return 0
        })
        return list
      }, [decorated, filter, group, query, sort])

      const selectedNode = selected === null ? null : (decorated.find((node) => node.alias === selected) ?? null)
      const editingRecord = editing === null ? null : (managed.find((record) => record.alias === editing) ?? null)

      const openAdd = () => { setEditing(null); setFormOpen(true) }
      const openEdit = (alias) => { setEditing(alias); setFormOpen(true) }

      const doDelete = async (alias) => {
        try {
          await hostsApi.remove(alias)
          if (selected === alias) setSelected(null)
          setPendingDelete(null)
          await fleet.reload()
        } catch {
          setPendingDelete(null)
        }
      }

      const failing = fleet.error !== null
      const importedOnly = hostsApi.imported

      return h('div', { className: 'fm-root', 'data-fleet-panel': '' },
        h('div', { className: 'fm-head' },
          h('div', null,
            h('h2', { className: 'fm-title' }, t('page.title')),
            h('p', { className: 'fm-sub' }, t('page.subtitle'))),
          h('span', { className: 'fm-spacer' }),
          h('button', {
            className: 'fm-btn',
            onClick: () => { void fleet.refresh() },
            disabled: fleet.refreshing,
          }, fleet.refreshing ? t('action.refreshing') : t('action.refresh')),
          h('button', { className: 'fm-btn primary', onClick: openAdd }, `+ ${t('action.add')}`)),

        h('div', { className: 'fm-tabs' }, SECTIONS.map((id) => h('button', {
          key: id,
          className: `fm-tab ${section === id ? 'on' : ''}`,
          onClick: () => go(id),
        }, t(`nav.${id}`)))),

        failing
          ? h('div', { className: 'fm-alert' },
            h('strong', null, t('error.load')),
            h('span', { className: 'fm-dim' }, t('error.loadBody')),
            h('span', { className: 'fm-error' }, `${fleet.error.status ?? ''} ${fleet.error.message}`.trim()),
            h('div', null,
              h('button', { className: 'fm-btn', onClick: () => { void fleet.reload() } }, t('action.retry'))))
          : null,

        section !== 'servers' ? null : h('div', { className: 'fm-stats' },
          [
            ['all', 'stat.total', counts.total],
            ['online', 'stat.online', counts.online],
            ['alerting', 'stat.alerting', counts.alerting],
            ['offline', 'stat.offline', counts.offline],
            ['owned', 'filter.owned', managed.length],
          ].map(([key, labelKey, value]) => h('button', {
            key,
            className: `fm-stat ${filter === key ? 'on' : ''}`,
            onClick: () => setFilter(filter === key ? 'all' : key),
          },
          h('span', { className: 'fm-stat-label' }, t(labelKey)),
          h('span', { className: 'fm-stat-value' }, value)))),

        section !== 'servers' ? null : h('div', { className: 'fm-toolbar' },
          h('input', {
            className: 'fm-input',
            style: { flex: '1 1 190px', maxWidth: 300 },
            placeholder: t('search.placeholder'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          groups.length === 0 ? null : h('select', {
            className: 'fm-select',
            value: group,
            onChange: (event) => setGroup(event.target.value),
          },
          h('option', { value: '' }, t('group.all')),
          groups.map((name) => h('option', { key: name, value: name }, name))),
          h('select', {
            className: 'fm-select',
            value: sort,
            onChange: (event) => setSort(event.target.value),
          },
          ['alias', 'cpu', 'mem', 'disk', 'latency', 'status'].map((key) => (
            h('option', { key, value: key }, t(`sort.${key}`))
          ))),
          h('span', { className: 'fm-spacer' }),
          h('button', {
            className: 'fm-btn',
            onClick: () => setView(view === 'table' ? 'cards' : 'table'),
          }, view === 'table' ? t('view.cards') : t('view.table'))),

        section !== 'servers' ? null : visible.length === 0
          ? h('div', { className: 'fm-empty' },
            h('h3', null, nodes.length === 0 ? t('empty.title') : t('empty.filtered')),
            h('p', null, nodes.length === 0 ? t('empty.body') : ''),
            nodes.length === 0
              ? h('button', { className: 'fm-btn primary', onClick: openAdd }, t('empty.action'))
              : null)
          : (view === 'table'
            ? h('div', { style: { overflowX: 'auto' } },
              h('table', { className: 'fm-table' },
                h('thead', null, h('tr', null,
                  ['alias', 'status', 'os', 'cpu', 'mem', 'disk', 'net', 'load', 'latency', 'uptime', 'actions']
                    .map((column) => h('th', { key: column }, t(`col.${column}`))))),
                h('tbody', null, visible.map((node) => h(HostRow, {
                  key: node.alias,
                  node,
                  selected: selected === node.alias,
                  onOpen: (alias) => setSelected(selected === alias ? null : alias),
                  onEdit: openEdit,
                  onDelete: (alias) => setPendingDelete(alias),
                })))))
            : h('div', { className: 'fm-cards' }, visible.map((node) => h(HostCard, {
              key: node.alias,
              node,
              selected: selected === node.alias,
              onOpen: (alias) => setSelected(selected === alias ? null : alias),
              onEdit: openEdit,
            })))),

        pendingDelete === null
          ? null
          : h('div', { className: 'fm-note bad', style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, `${pendingDelete} — ${t('action.delete')}?`),
            h('span', { className: 'fm-spacer' }),
            h('button', { className: 'fm-btn tiny', onClick: () => setPendingDelete(null) }, t('action.cancel')),
            h('button', { className: 'fm-btn tiny danger', onClick: () => { void doDelete(pendingDelete) } },
              t('action.confirmDelete'))),

        selectedNode === null ? null : h(HostDetail, {
          node: selectedNode,
          onClose: () => { setTerminalAlias(null); setFilesAlias(null); setSelected(null) },
          onEditMeta: (alias) => setMetaOpen(alias),
          terminalOpen: terminalAlias === selectedNode.alias,
          onToggleTerminal: () => setTerminalAlias(terminalAlias === selectedNode.alias ? null : selectedNode.alias),
          filesOpen: filesAlias === selectedNode.alias,
          onToggleFiles: () => setFilesAlias(filesAlias === selectedNode.alias ? null : selectedNode.alias),
        }),

        h(MetaForm, {
          open: metaOpen !== null,
          alias: metaOpen ?? '',
          record: metaOpen === null ? null : (metaByAlias.get(metaOpen) ?? null),
          onClose: () => setMetaOpen(null),
          onSubmit: async (record) => { await metaApi.save(record) },
        }),

        section === 'overview' ? h(OverviewSection, {
          nodes: decorated,
          counts,
          uptime: fleet.snapshot?.uptime ?? null,
          lastRunAt: fleet.snapshot?.lastRunAt,
          onOpen: (alias) => setSelected(selected === alias ? null : alias),
          onEdit: openEdit,
        }) : null,

        section === 'services' ? h(ServicesSection, {
          probes: probeApi.probes,
          error: probeApi.error,
          onAdd: () => setProbeOpen('new'),
          onDelete: async (probe) => { await probeApi.remove(probe.id) },
        }) : null,

        h(ProbeForm, {
          open: probeOpen !== null,
          record: probeOpen === null || probeOpen === 'new'
            ? null
            : (probeApi.probes.find(probe => probe.id === probeOpen) ?? null),
          onClose: () => setProbeOpen(null),
          onSubmit: async (probe) => { await probeApi.save(probe) },
        }),

        section === 'settings' ? h(SettingsSection, {
          snapshot: fleet.snapshot,
          settings: settingsApi,
          onSave: settingsApi.save,
          onReset: settingsApi.reset,
        }) : null,

        section === 'alerts' ? h(AlertsSection, {
          alerts: alertApi,
          notify: notifyApi,
          onAddRule: () => setRuleOpen('new'),
          onEditRule: (rule) => setRuleOpen(rule.id),
          onDeleteRule: async (rule) => { await alertApi.remove(rule.id) },
          onSilence: async (rule) => { await alertApi.silence({ ruleId: rule.id, minutes: 60 }) },
          onAddChannel: () => setChannelOpen(true),
          onDeleteChannel: async (channel) => { await notifyApi.removeChannel(channel.id) },
        }) : null,

        h(RuleForm, {
          open: ruleOpen !== null,
          rule: ruleOpen === null || ruleOpen === 'new'
            ? null
            : (alertApi.rules.find(rule => rule.id === ruleOpen) ?? null),
          groups: notifyApi.groups,
          onClose: () => setRuleOpen(null),
          onSubmit: async (rule) => { await alertApi.save(rule) },
        }),

        h(ChannelForm, {
          open: channelOpen,
          presets: notifyApi.presets,
          placeholders: notifyApi.placeholders,
          onClose: () => setChannelOpen(false),
          onSubmit: async (channel) => { await notifyApi.saveChannel(channel) },
        }),

        section === 'tasks' ? h(TasksSection, {
          tasks: taskApi,
          runsFor: (id) => runsByTask[id] ?? [],
          onAdd: () => setTaskOpen('new'),
          onEdit: (task) => setTaskOpen(task.id),
          onRemove: async (id) => { await taskApi.remove(id) },
          onRun: async (id) => { await taskApi.run(id) },
          onHistory: async (id) => {
            const rows = await taskApi.loadRuns(id)
            setRunsByTask((previous) => ({ ...previous, [id]: rows }))
          },
        }) : null,

        h(TaskForm, {
          open: taskOpen !== null,
          task: taskOpen === null || taskOpen === 'new'
            ? null
            : (taskApi.tasks.find(task => task.id === taskOpen) ?? null),
          onClose: () => setTaskOpen(null),
          onSubmit: async (task) => { await taskApi.save(task) },
        }),

        section !== 'servers' ? null : importedOnly.length === 0 ? null : h('details', null,
          h('summary', { style: { cursor: 'pointer', fontSize: 11.5, color: 'var(--fm-muted)' } },
            `${t('imported.title')} (${importedOnly.length}) — ${t('imported.hint')}`),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
            importedOnly.map((entry) => h(Tag, { key: entry.alias }, `${entry.alias} · ${t(`source.${entry.source}`)}`)))),

        h('div', { className: 'fm-footer' },
          h('span', null, `${t('footer.updated')}: ${fmtTime(fleet.snapshot?.lastRunAt)}`),
          h('span', null, `${t('footer.took')}: ${fleet.snapshot?.lastRunMs === undefined || fleet.snapshot?.lastRunMs === null ? '—' : `${Math.round(fleet.snapshot.lastRunMs)} ms`}`),
          h('span', null, `${t('footer.backend')}: ${fleet.snapshot?.backend ?? '—'}`),
          fleet.snapshot?.problems !== undefined && fleet.snapshot.problems.length > 0
            ? h('span', { title: fleet.snapshot.problems.join('\n') },
              `${t('footer.problems')}: ${fleet.snapshot.problems.length}`)
            : null),

        h(HostForm, {
          open: formOpen,
          record: editingRecord,
          onClose: () => { setFormOpen(false); setEditing(null) },
          onSubmit: async (payload) => {
            await hostsApi.save(payload)
            await fleet.reload()
          },
          onTest: hostsApi.test,
        }))
    }

    /** Sidebar entry icon. */
    function FleetMonitorIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'data-dsh-panel-entry': 'fleet-monitor',
        'aria-hidden': 'true',
      },
      h('rect', { x: 3, y: 4, width: 18, height: 6, rx: 1.6 }),
      h('rect', { x: 3, y: 14, width: 18, height: 6, rx: 1.6 }),
      h('path', { d: 'M6.5 7h.01M6.5 17h.01' }))
    }

    // ── mount ──────────────────────────────────────────────────────────────

    const inject = ['slots', 'locale']

    /**
     * Register the dictionary and both slots.
     *
     * Every registration is try/caught on purpose: a host build whose locale or
     * slot service disagrees must still leave a working page, and the failure has
     * to be visible in the console rather than swallowed.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyle()

      ctx.effect(() => {
        try {
          const dispose = ctx.locale.register(NS, { zh, en })
          try {
            const bound = ctx.locale.bind(NS)
            if (typeof bound === 'function') translate = bound
          } catch {
            // The dictionary itself is registered; the bound reader is a nicety.
          }
          return typeof dispose === 'function' ? dispose : () => {}
        } catch (error) {
          console.warn(`[${NS}] locale registration failed:`, error)
          return () => {}
        }
      }, `${NS}: locale`)

      ctx.effect(() => {
        const disposers = []
        try {
          disposers.push(ctx.slots.inject('sidebar.panellist', () => (
            ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => t('entry.label'),
            }, FleetMonitorIcon)
          )))
        } catch (error) {
          console.warn(`[${NS}] panel registration failed:`, error)
        }
        try {
          disposers.push(ctx.slots.inject('main', () => (
            ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              inject: () => ({}),
            }, FleetMonitorPage)
          )))
        } catch (error) {
          console.warn(`[${NS}] panel registration failed:`, error)
        }
        return () => {
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              // A disposer that already ran is not an error worth reporting.
            }
          }
        }
      }, `${NS}: panel`)

      ctx.effect(() => () => {
        if (typeof document === 'undefined') return
        const style = document.getElementById(STYLE_ID)
        if (style !== null) style.remove()
      }, `${NS}: style`)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
