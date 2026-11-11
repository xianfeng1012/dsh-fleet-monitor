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

    // ── styles ─────────────────────────────────────────────────────────────

    const STYLE_ID = 'dsh-fleet-monitor-style'

    /** One injected stylesheet: pseudo-classes and media queries need real CSS. */
    const CSS = `
.fm-root { --fm-border: color-mix(in oklab, currentColor 14%, transparent);
  --fm-soft: color-mix(in oklab, currentColor 6%, transparent);
  --fm-muted: color-mix(in oklab, currentColor 55%, transparent);
  display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 22px; height: 100%;
  overflow: auto; box-sizing: border-box; font-size: 13px; color: inherit; }
.fm-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
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
.fm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.fm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
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
.fm-detail-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.fm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 9px 16px; }
.fm-field { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.fm-field-label { font-size: 11px; color: var(--fm-muted); }
.fm-field-value { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fm-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.fm-chart { display: flex; flex-direction: column; gap: 3px; }
.fm-chart-label { font-size: 11px; color: var(--fm-muted); }
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
.fm-field-input { display: flex; flex-direction: column; gap: 3px; }
.fm-field-input > label { font-size: 11.5px; color: var(--fm-muted); }
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
    function Field(props) {
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
              ? `${t('test.ok')} · ${fmtMs(test.latencyMs)}${test.os?.name === undefined || test.os?.name === null ? '' : ` · ${test.os.name}`}`
              : `${t('test.fail')} · ${test.stage ?? ''} ${test.error ?? ''}`)),

        h('div', { className: 'fm-modal-foot' },
          h('button', { className: 'fm-btn', onClick: () => { void probe() }, disabled: testing },
            testing ? t('action.testing') : t('action.test')),
          h('span', { className: 'fm-spacer' }),
          h('button', { className: 'fm-btn', onClick: props.onClose, disabled: busy }, t('action.cancel')),
          h('button', { className: 'fm-btn primary', onClick: () => { void submit() }, disabled: busy },
            busy ? t('action.saving') : t('action.save')))))
    }

    // ── detail ─────────────────────────────────────────────────────────────

    /**
     * The expanded host view: identity, live figures, and an hour of history.
     * @param props.node - the snapshot entry.
     * @param props.onClose - collapse.
     */
    function HostDetail(props) {
      const node = props.node
      const history = useHistory(node.alias, true)
      const points = history.points
      const series = (pick) => points.map((point) => pick(point)).reverse()
      const memPct = points.map((point) => (
        point.memUsed !== null && point.memTotal ? (point.memUsed / point.memTotal) * 100 : null
      )).reverse()
      return h('div', { className: 'fm-detail' },
        h('div', { className: 'fm-detail-head' },
          h('StatusPill', { status: node.status }),
          h('strong', null, node.alias),
          h('span', { className: 'fm-mono fm-dim' }, `${node.user}@${node.host}:${node.port}`),
          node.source === 'panel' ? null : h(Tag, null, t(`source.${node.source}`)),
          h('span', { className: 'fm-spacer' }),
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
          : h('span', { className: 'fm-error' }, history.error.message))
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
          h('span', { style: { fontWeight: 500 } }, node.alias),
          node.alerts.includes('cpu') || node.alerts.includes('mem') || node.alerts.includes('disk')
            ? h('span', { className: 'fm-dot', style: { background: '#f59e0b' }, title: node.alerts.join(', ') })
            : null),
        h('div', { className: 'fm-mono fm-dim' }, `${node.host}:${node.port}`)),
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
        h('span', { className: 'fm-card-name', title: node.alias }, node.alias),
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
    function FleetMonitorPage() {
      const fleet = useFleet()
      const hostsApi = useHosts()
      const [filter, setFilter] = useState('all')
      const [sort, setSort] = useState('alias')
      const [view, setView] = useState('table')
      const [query, setQuery] = useState('')
      const [group, setGroup] = useState('')
      const [selected, setSelected] = useState(null)
      const [formOpen, setFormOpen] = useState(false)
      const [editing, setEditing] = useState(null)
      const [pendingDelete, setPendingDelete] = useState(null)

      useEffect(() => { ensureStyle() }, [])

      const nodes = Array.isArray(fleet.snapshot?.nodes) ? fleet.snapshot.nodes : []
      const managed = hostsApi.hosts

      /** Merge the live node with its panel record so tags/groups survive edits. */
      const decorated = useMemo(() => {
        const byAlias = new Map(managed.map((record) => [record.alias, record]))
        return nodes.map((node) => {
          const record = byAlias.get(node.alias)
          return {
            ...node,
            tags: record?.tags ?? [],
            groupName: record?.groupName ?? null,
            note: record?.note ?? null,
          }
        })
      }, [nodes, managed])

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

        failing
          ? h('div', { className: 'fm-alert' },
            h('strong', null, t('error.load')),
            h('span', { className: 'fm-dim' }, t('error.loadBody')),
            h('span', { className: 'fm-error' }, `${fleet.error.status ?? ''} ${fleet.error.message}`.trim()),
            h('div', null,
              h('button', { className: 'fm-btn', onClick: () => { void fleet.reload() } }, t('action.retry'))))
          : null,

        h('div', { className: 'fm-stats' },
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

        h('div', { className: 'fm-toolbar' },
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

        visible.length === 0
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
          onClose: () => setSelected(null),
        }),

        importedOnly.length === 0 ? null : h('details', null,
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
