/**
 * dsh-fleet-monitor — host half.
 *
 * Registers one route family, three agent tools, and one system-prompt section
 * that together expose the live health of the SSH fleet already configured for
 * `dsh-ssh` (or `~/.ssh/config`). The plugin owns no host list of its own: it
 * reads whatever the operator already has, which is what makes it installable by
 * anyone rather than only by its author.
 *
 * Nothing here is compiled. `lib/*.js` is the shipped artifact.
 *
 * @module dsh-fleet-monitor
 */

import Schema from '@deepseek-ai/schemastery'

import { AlertEngine } from './alerts.js'
import { Collector } from './collector.js'
import { FileBrowser } from './fs.js'
import { resolveDshHome } from './hosts.js'
import { mountOnce } from './mount-once.js'
import { API, makeRoutes } from './routes.js'
import { ServiceMonitor } from './services.js'
import { OVERRIDABLE, sanitiseOverrides } from './settings.js'
import { TaskRunner } from './tasks.js'
import { TerminalRegistry } from './terminal.js'
import { WebSocketServer } from './ws.js'
import { isLoopbackRequest } from './loopback.js'
import { sendToChannels } from './notify.js'
import { openStore } from './store.js'
import { makeTools } from './tools.js'

/** Plugin id, used as the mount-once key and the route prefix owner. */
export const name = 'dsh-fleet-monitor'

/**
 * Services this plugin needs before it can mount anything.
 *
 * Plain string array, the shape the host's plugin loader understands. Without
 * it the loader never resolves `ctx.webServer`, `ctx.tools` or
 * `ctx.systemPrompt`, so `apply` would throw on the first `ctx.effect` and the
 * host would silently keep the browser half mounted against a host half that
 * never registered a route — which is exactly a panel that renders 401 on every
 * API call.
 */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Order of the system-prompt section relative to other plugins'. */
const SECTION_ORDER = 620

/** Live config. Volatile so an interval change applies without a host restart. */
export const Config = Schema.object({
  intervalMs: Schema.number()
    .default(30_000)
    .description('Collection interval in milliseconds. One SSH round-trip per host per tick.')
    .volatile(),
  concurrency: Schema.number()
    .default(6)
    .description('How many hosts to poll in parallel.')
    .volatile(),
  execTimeoutMs: Schema.number()
    .default(12_000)
    .description('Per-host probe timeout in milliseconds.')
    .volatile(),
  connectTimeoutMs: Schema.number()
    .default(15_000)
    .description('Per-host SSH connect timeout in milliseconds.')
    .volatile(),
  slowIntervalMs: Schema.number()
    .default(300_000)
    .description('Hardware sweep interval in milliseconds (temperature, GPU, ports, partitions). Runs on its own timer.')
    .volatile(),
  slowTimeoutMs: Schema.number()
    .default(20_000)
    .description('Per-host timeout for the hardware sweep in milliseconds.')
    .volatile(),
  dshHome: Schema.string()
    .default('')
    .description('Override the DSH home directory. Empty means $DSH_HOME, then ~/.dsh.')
    .volatile(),
  sshDir: Schema.string()
    .default('')
    .description('Override the OpenSSH directory read for ~/.ssh/config and keys. Empty means ~/.ssh.')
    .volatile(),
  agentSocket: Schema.string()
    .default('')
    .description('Explicit ssh-agent socket. Empty means the agent is only used when SSH_AUTH_SOCK is set.')
    .volatile(),
  includeTag: Schema.string()
    .default('')
    .description('Only monitor hosts carrying this tag. Empty means every discovered host.')
    .volatile(),
  excludeAliases: Schema.array(Schema.string())
    .default([])
    .description('Aliases to skip entirely.')
    .volatile(),
  cpuAlertPct: Schema.number()
    .default(85)
    .description('CPU percentage at or above which a node is flagged.')
    .volatile(),
  memAlertPct: Schema.number()
    .default(90)
    .description('Memory percentage at or above which a node is flagged.')
    .volatile(),
  diskAlertPct: Schema.number()
    .default(90)
    .description('Disk percentage at or above which a node is flagged.')
    .volatile(),
  keep: Schema.number()
    .default(2880)
    .description('Samples retained per host. At the default interval this is 24 hours.')
    .volatile(),
  announceToAgent: Schema.boolean()
    .default(true)
    .description('Add a system-prompt section telling the agent these tools exist.')
    .volatile(),
  fsRoots: Schema.array(Schema.string())
    .default(['/'])
    .description('Absolute prefixes the file browser may reach. The SSH account is the real boundary; this only narrows it.')
    .volatile(),
  maxDownloadBytes: Schema.number()
    .default(268_435_456)
    .description('Largest file the browser will stream down, in bytes.')
    .volatile(),
  maxUploadBytes: Schema.number()
    .default(536_870_912)
    .description('Largest file the browser will accept on upload, in bytes.')
    .volatile(),
})

/** Module-level singletons: one collector, one store, one sweep per process. */
let collector = null
let store = null
let services = null
let alerts = null
let tasks = null
let terminal = null
let files = null
const terminalWss = new WebSocketServer()

/**
 * Read one config field.
 *
 * A `volatile()` field does not resolve to its value: the loader hands over a
 * stable reference object whose owner writes the live value in place, so the
 * running instance sees an edit without a remount. A hand-built context (tests,
 * scripts) still passes plain values, hence both shapes here.
 * @param field - the reference, the plain value, or undefined.
 * @param fallback - used when the field is absent or has no value yet.
 * @returns the current value.
 */
function readField(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined || value === null ? fallback : value
  }
  return field
}

/** Coerce the resolved config (live references and plain values) into what the collector expects. */
function readConfig(config, dshHome) {
  const field = key => readField(config?.[key], undefined)
  const home = field('dshHome')
  const sshDir = field('sshDir')
  const agentSocket = field('agentSocket')
  const includeTag = field('includeTag')
  const excludeAliases = field('excludeAliases')
  const fsRoots = field('fsRoots')
  return {
    intervalMs: clampNumber(field('intervalMs'), 5_000, 3_600_000, 30_000),
    concurrency: clampNumber(field('concurrency'), 1, 32, 6),
    execTimeoutMs: clampNumber(field('execTimeoutMs'), 1_000, 120_000, 12_000),
    connectTimeoutMs: clampNumber(field('connectTimeoutMs'), 1_000, 120_000, 15_000),
    // The hardware sweep is deliberately much slower than the fast one: it reads
    // /sys and may shell out to nvidia-smi, and nothing it measures changes fast
    // enough to justify paying that cost every 30 seconds.
    slowIntervalMs: clampNumber(field('slowIntervalMs'), 60_000, 86_400_000, 300_000),
    slowTimeoutMs: clampNumber(field('slowTimeoutMs'), 2_000, 120_000, 20_000),
    dshHome: typeof home === 'string' && home !== '' ? home : dshHome,
    sshDir: typeof sshDir === 'string' ? sshDir : '',
    agentSocket: typeof agentSocket === 'string' ? agentSocket : '',
    includeTag: typeof includeTag === 'string' ? includeTag : '',
    excludeAliases: Array.isArray(excludeAliases) ? excludeAliases.filter(item => typeof item === 'string') : [],
    cpuAlertPct: clampNumber(field('cpuAlertPct'), 1, 100, 85),
    memAlertPct: clampNumber(field('memAlertPct'), 1, 100, 90),
    diskAlertPct: clampNumber(field('diskAlertPct'), 1, 100, 90),
    keep: clampNumber(field('keep'), 60, 100_000, 2880),
    announceToAgent: readField(config?.announceToAgent, true) !== false,
    fsRoots: Array.isArray(fsRoots) && fsRoots.length > 0
      ? fsRoots.filter(item => typeof item === 'string' && item.startsWith('/'))
      : ['/'],
    maxDownloadBytes: clampNumber(field('maxDownloadBytes'), 1024, 2_147_483_648, 268_435_456),
    maxUploadBytes: clampNumber(field('maxUploadBytes'), 1024, 2_147_483_648, 536_870_912),
  }
}

/** Clamp a numeric config value, falling back when it is not a finite number. */
function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** The real plugin body, guarded by mount-once. */
function applyImpl(ctx, config) {
  const dshHome = resolveDshHome(readField(config?.dshHome, ''))
  // Host config first, then the operator's overrides from the Settings tab. The
  // host owns a volatile() field and never lets a plugin write it, so the only
  // place a panel change can survive is our own database.
  const getConfig = () => ({
    ...readConfig(config, dshHome),
    ...sanitiseOverrides(store === null ? {} : store.readSettings()),
  })

  // One sweep per process. The store is opened once because reopening SQLite per
  // volatile update would drop the in-memory fallback's history each time.
  if (store === null) {
    store = openStore({ dshHome, keep: getConfig().keep })
  }
  if (collector === null) {
    collector = new Collector({ getConfig, store })
  }
  if (services === null) {
    // Probes run on this host, so their results are pushed to the same SSE
    // subscribers the SSH sweep feeds: the panel has one stream, not two.
    services = new ServiceMonitor({ store, emit: () => collector.emit() })
  }
  if (alerts === null) {
    // Rules live in the table, state lives in memory, and the engine is driven by
    // the sweep: it has no timer of its own, so it can never evaluate a snapshot
    // that is older than the round it is reacting to.
    alerts = new AlertEngine({ store, config: getConfig })
    collector.onSweep = (snapshot) => { void alerts.evaluate(snapshot.nodes).catch(() => {}) }
  }
  if (tasks === null) {
    // Scheduled commands reuse the collector's SSH pool, so a task never opens a
    // second connection to a host the sweep is already talking to.
    tasks = new TaskRunner({
      store,
      pool: collector.pool,
      collector,
      getConfig,
      notify: { sendToChannels },
      emit: () => collector.emit(),
    })
  }
  if (terminal === null) {
    // Shells share the same pool: the first terminal on a host reuses the
    // connection the sweep already authenticated.
    terminal = new TerminalRegistry({ pool: collector.pool, collector, getConfig })
  }
  if (files === null) {
    // SFTP rides the same pool for the same reason as the terminal.
    files = new FileBrowser({ pool: collector.pool, collector, getConfig })
  }

  // Routes: re-registered on a volatile update so a path change (never expected
  // here, but cheap) also refreshes the handler closures.
  ctx.effect(() => {
    const disposers = makeRoutes({ collector, store, getConfig, services, alerts, tasks, files, webServer: ctx.webServer }).map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-fleet-monitor: routes')

  // Terminal: one upgrade path, fenced here because the host's upgrade registry
  // performs no loopback or Origin check of its own.
  ctx.effect(() => {
    const dispose = ctx.webServer.registerUpgrade({
      path: API.terminal,
      handler: (request, socket, head) => {
        if (!isLoopbackRequest(request)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const url = new URL(request.url ?? '/', 'http://localhost')
        const alias = url.searchParams.get('alias')
        const sessionId = url.searchParams.get('session')
        if ((alias === null || alias === '') && (sessionId === null || sessionId === '')) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        const cols = Number.parseInt(url.searchParams.get('cols') ?? '80', 10)
        const rows = Number.parseInt(url.searchParams.get('rows') ?? '24', 10)
        const size = {
          cols: Number.isFinite(cols) ? Math.min(Math.max(cols, 20), 400) : 80,
          rows: Number.isFinite(rows) ? Math.min(Math.max(rows, 5), 200) : 24,
        }
        terminalWss.handleUpgrade(request, socket, head, (peer) => {
          const send = (frame) => peer.send(JSON.stringify(frame))
          const onGone = () => { try { peer.close(1000) } catch {} }
          const bind = (session) => {
            peer.on('message', (text) => {
              try {
                session.handle(JSON.parse(String(text)))
              } catch {
                // A malformed frame from our own panel is a bug, not a hostile
                // input; ignoring it keeps the shell alive.
              }
            })
            peer.on('close', () => {
              // Closing the view keeps the shell for a while; only an explicit
              // `close` frame ends it.
              session.handle({ type: 'detach' })
            })
          }
          if (sessionId !== null && sessionId !== '') {
            const session = terminal.reattach(sessionId, send, onGone)
            if (session === null) {
              send({ type: 'exit', code: null, error: 'terminal session expired' })
              onGone()
              return
            }
            bind(session)
            return
          }
          void terminal.open(alias, size, send, onGone).then((session) => {
            if (session !== null) bind(session)
          }).catch((error) => {
            send({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) })
            onGone()
          })
        })
      },
    })
    return () => {
      dispose()
      terminalWss.close()
    }
  }, 'dsh-fleet-monitor: terminal')

  // Tools: only when the host exposes the tools service.
  if (ctx.tools !== undefined) {
    ctx.effect(() => {
      const disposers = makeTools({ collector, store, services, alerts }).map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-fleet-monitor: tools')
  }

  // System prompt: name the tools so the model knows they exist.
  if (ctx.systemPrompt !== undefined) {
    ctx.effect(() => {
      if (!getConfig().announceToAgent) return () => {}
      return ctx.systemPrompt.section({
        name: 'plugin:dsh-fleet-monitor',
        order: SECTION_ORDER,
        text: '本机已安装 dsh-fleet-monitor 插件（DSH SSH 服务器监控）：侧边栏「服务器监控」入口。'
          + '它采集的是 dsh-ssh / ~/.ssh/config 里已配置主机的健康数据（CPU、负载、内存、磁盘、网络、TCP 连接数、运行时长），'
          + '每 intervalMs（默认 30 秒）一轮，每台主机一次 SSH 往返。'
          + '能力：fleet_snapshot 读取全机队当前状态（可按 alerts/offline 过滤）；'
          + 'fleet_history 读取单机历史样本以区分尖峰与趋势；'
          + 'fleet_refresh 立即执行一轮采集。'
          + '限制：只会读取已配置的主机，不会发现新主机；ProxyJump 跳板链暂不支持（标 skipped）；'
          + '每轮采集都消耗真实远程资源，不要在循环里反复调用 refresh。'
          + '用户提到「服务器负载 / 哪台机器挂了 / 磁盘快满了 / 监控面板」时即指本插件。',
      })
    }, 'dsh-fleet-monitor: prompt')
  }

  // Start after the surfaces exist, so the first snapshot has a subscriber.
  ctx.effect(() => {
    collector.start()
    services.start()
    alerts.start()
    tasks.start()
    terminal.start()
    // Unloading the plugin must release the SQLite handle and the pool's sockets.
    // On Windows an open handle keeps the database file locked, so a reload or a
    // reinstall would fail with EBUSY; the history itself lives in the file and
    // survives the reopen, and the memory fallback only loses what it could never
    // have kept across a process restart anyway.
    return () => {
      tasks.dispose()
      terminal.dispose()
      files.dispose()
      services.dispose()
      alerts.dispose()
      collector.dispose()
      store.close()
      tasks = null
      terminal = null
      files = null
      services = null
      alerts = null
      collector = null
      store = null
    }
  }, 'dsh-fleet-monitor: collector')

  // Volatile config change: re-derive the store retention and the pool limits.
  ctx.on('loader/volatile-update', () => {
    const next = getConfig()
    store.keep = next.keep
    collector.applyConfig()
    tasks.reload()
  })
}

/** Host-facing apply, deduped per process. */
export const apply = mountOnce(name, applyImpl)
