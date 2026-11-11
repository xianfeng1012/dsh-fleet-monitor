# dsh-fleet-monitor · Fleet Monitor

<p align="center">
  <b>English</b>
  &nbsp;·&nbsp;
  <a href="https://github.com/xianfeng1012/dsh-fleet-monitor/blob/main/README.zh.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/xianfeng1012/dsh-fleet-monitor">Source</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/dsh-fleet-monitor">npm</a>
</p>

A **multi-host SSH monitoring** panel for the DSH web GUI. It reuses the SSH credentials you already have, pulls every host from `dsh-ssh` and `~/.ssh/config` into one console, and shows online state, CPU, memory, disk, network, and process counts — with per-host history charts and add/edit/delete from the panel itself.

**Nothing to install on the monitored machines.** The collector is a POSIX `sh` script that runs once over an existing SSH connection. The plugin only reads credentials already on your machine: no network egress, no telemetry.

---

## Why another monitor

| | Usual approach | This plugin |
|---|---|---|
| Remote side | install an agent or exporter | **nothing** — sshd is the agent |
| Host inventory | maintain a second list | reuse `dsh-ssh.json` and `~/.ssh/config` |
| Credentials | store them again | reuse yours; only panel-added hosts go into local SQLite |
| Scope | usually "this machine" | **a fleet**, N hosts polled in parallel |
| Data | one snapshot in memory | SQLite history, 24 hours by default |

---

## Features

- **Sections** — six views behind hash routing (`#/overview` and friends) so a reload lands where it was: overview, servers, services, alerts, tasks, settings. The overview reduces the fleet to availability, memory and disk totals, what is alerting, and what is down; settings lays out the runtime facts unchanged.
- **Overview** — stat cards (all / online / alerting / offline / panel-owned) that double as filters; search, group filter, sort by alias, CPU, memory, disk, latency, or state; table and card views; offline rows carry a red edge.
- **Hosts** — add, edit, and delete from the panel. Fields: alias, address, port, user, auth (key / password / agent), key path, passphrase, password, group, tags, note. **Test connection** before saving reports `12 ms · Ubuntu 24.04`. Stored secrets are never sent back; leaving them blank on edit keeps the saved value.
- **Display metadata** — display name, group, tags, note, expiry, price, bandwidth live in their own table. The alias itself is immutable: it is the join key for every sample already collected, so renaming would orphan that host's history.
- **Detail** — OS, kernel, arch, cores, CPU model, latency, uptime, swap, TCP/UDP, process count, plus three charts: CPU %, memory %, network KB/s over the last hour at 30-second resolution.
- **Hardware** — a slower sweep (five minutes by default) adds temperature, GPU, listening ports, per-mount disk usage, and per-NIC transfer totals.
- **Service monitor** — HTTP, TCP and ICMP probes on independent timers, from 10 seconds up. HTTP takes an expected status (`200`, `2xx`, `200,204`, `/^2\d\d$/`) and a body keyword, and reads the certificate expiry off https targets six times a day. Each row shows a fixed 30-cell strip, padded on the left, so a probe added ten minutes ago does not look like a full day of uptime. Probes run from the DSH host, which is why they can watch a router with no SSH at all.
- **Alerts** — rules over 19 metrics with a direction, a threshold, a duration, a cooldown, and a scope (all / only these / all but these). The duration becomes consecutive rounds (`180s ÷ 30s = 6`), and offline needs at least two, because one missed sweep is a flaky network and two is a dead machine. A metric that reads `null` **freezes** the state instead of resolving it: one SSH timeout must not close an open incident and reopen it on the next round. The cooldown only gates re-entry into firing; a recovery always notifies. Events live in the local database, so a restart still knows what is on fire and does not open a duplicate.
- **Notifications** — a generic HTTP template, not a list of providers: URL, method, body type, headers, body. Fifteen placeholders such as `#SERVER.NAME#`, `#RULE.NAME#`, `#VALUE#`, `#MESSAGE#`; an unknown placeholder is left verbatim, because a typo should show up in the message rather than quietly become an empty string. Bark, Telegram, Lark and WeCom ship as presets with `{token}`-style placeholders. **Send test** answers 200 on success and 502 with the upstream message on failure. More than five notifications in one sweep collapse into a digest.
- **Scheduled tasks** — five-field cron (`*`, `a-b`, `a/n`, comma lists). The schedule is validated on save, including a refusal of dates that never arrive (`0 0 30 2 *`): a row that looks enabled and never fires is indistinguishable from a broken scheduler. Commands run over SSH on the covered hosts (all / only these / all but these), four at a time, with each host's own exit code and error kept; each host contributes up to 1 KB of output tail, the field is capped at 8 KB, and hosts that do not fit are named in the trailer instead of being dropped. Running a task while another is in flight answers 409 so the panel can say "busy" rather than "done". Each task keeps its last 500 runs, deleting the task deletes them, and a run that is more than an hour late is skipped rather than replayed.
- **Terminal** — an interactive shell opens from a host's detail view and reuses the monitor's own SSH connection, so opening it does not cost another authentication round. It rides a small hand-written RFC 6455 server instead of `ws`: the plugin directory resolves no `node_modules` of its own, and a hard `ws` import would roll back the whole plugin entry at load. The upgrade handler does its own loopback check, because the host's upgrade registry checks nothing and another browser tab can start a cross-site WebSocket handshake. The socket URL cannot be built from `location.origin`: the Electron shell serves the panel from the `dsh-app://` scheme, which cannot speak `ws://` and carries no port, so the view asks `/status` for its `port` (the HTTP request still lands on the real loopback port) and dials `ws://127.0.0.1:<port>/…`; the browser build keeps using `location.origin` and skips that round trip. Closing the tab detaches the session for five minutes rather than killing it; **End session** is the button that really closes it. This is not a VT100: escape sequences are stripped and `\r`/`\b` are honoured, which makes `ls`, `df` and `systemctl status` readable, while `top`, `vim` and `htop` belong in the dsh-ssh terminal — the panel says so under the view.
- **Files** — SFTP browse, upload, download, rename, mkdir and delete from the detail view, over the same pooled SSH connection. Every path is normalised and confined to `fsRoots` (default `['/']`); the real boundary is the SSH account, and that field only narrows it. A download is sized before the stream opens and answers 413 over `maxDownloadBytes` (256 MB default) rather than filling memory first. Uploads are a raw body plus NDJSON progress frames rather than a multipart form, so a few hundred megabytes shows movement instead of a spinner that might be a hang. Deleting a folder needs `recursive` and says "directory is not empty" without it; the root is never deleted, and recursion stops at 32 levels so a symlink loop ends. An idle SFTP channel is released after two minutes so it does not hold a slot on the remote sshd.
- **Live** — snapshots stream over `EventSource`; on error the panel falls back to 30-second polling so a reconnect backoff never freezes the view.
- **Agent tools** — `fleet_snapshot`, `fleet_history`, `fleet_refresh`, `fleet_host`, `fleet_services`, `fleet_alerts`, `fleet_tasks`. All read-only. `fleet_services` and `fleet_alerts` register only when the host actually provides the probe and alert engines: a tool that always answers "not available" is worse than an absent one, because the model reading it cannot tell the two apart.

---

## Install

A DSH plugin is a **bundle in a profile**, so three things have to line up.

1. Put this repository anywhere, e.g. `/opt/plugins/dsh-fleet-monitor`.

2. Link it into the profile's `node_modules` so Node can `import 'dsh-fleet-monitor'`:

   ```bash
   ln -s /opt/plugins/dsh-fleet-monitor ~/.dsh/profiles/desktop/node_modules/dsh-fleet-monitor
   ```

   Windows (no admin needed, a junction is enough):

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-fleet-monitor" `
     -Target "/opt/plugins/dsh-fleet-monitor"
   ```

   The plugin's own dependencies (`@deepseek-ai/schemastery`, `ssh2`) must also resolve from its real path. If it does not sit under the profile's `node_modules`, link those two packages as well, or run `pnpm install` inside the repository.

3. Append to `dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`:

   ```json
   "dsh-fleet-monitor"
   ```

4. Append to `~/.dsh/profiles/desktop/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: fleet-monitor
         name: dsh-fleet-monitor
   ```

   > The plugin node must be inserted from this layer. Inserting it from the plugin's own `cordis.patch.yml` queues the same id twice and the loader rejects the duplicate ("already queued"); the bundled patch only tightens entries the user layer already declared.

5. Quit DSH completely and start it again. **Fleet Monitor** appears in the sidebar.

---

## Configuration

Every field is `volatile()`, so edits apply without a restart.

| Field | Default | Meaning |
|---|---|---|
| `intervalMs` | `30000` | Poll interval, 5 s – 1 h |
| `slowIntervalMs` | `300000` | Hardware sweep interval (temperature, GPU, ports, partitions), 60 s – 24 h |
| `slowTimeoutMs` | `20000` | Hardware sweep timeout, 2 s – 120 s |
| `fsRoots` | `["/"]` | Absolute prefixes the file browser may reach. The SSH account is the real boundary; this only narrows it. |
| `maxDownloadBytes` | `268435456` | Largest single download, in bytes (256 MB). |
| `maxUploadBytes` | `536870912` | Largest single upload, in bytes (512 MB). |
| `concurrency` | `6` | Parallel SSH dials, 1 – 32 |
| `connectTimeoutMs` | `15000` | Connect + key exchange + auth timeout |
| `execTimeoutMs` | `12000` | Single collector run timeout |
| `dshHome` | empty = `$DSH_HOME` or `~/.dsh` | Where `dsh-ssh.json` lives |
| `sshDir` | empty = `~/.ssh` | Where `config` and keys live |
| `agentSocket` | empty = auto | `SSH_AUTH_SOCK` override |
| `includeTag` | empty | Only poll hosts carrying this tag |
| `excludeAliases` | `[]` | Aliases to skip entirely (shown as "skipped", never silently dropped) |
| `cpuAlertPct` / `memAlertPct` / `diskAlertPct` | `85` / `90` / `90` | Alert thresholds |
| `keep` | `2880` | Samples kept per host (30 s × 24 h) |
| `announceToAgent` | `true` | Add a system-prompt section describing the three tools |

---

## Security

- **Loopback only.** Every route passes a fence: a non-`127.0.0.1`/`::1` source, any request carrying `X-Forwarded-For` or `CF-Connecting-IP` (a proxy is in front), `sec-fetch-site: cross-site`, or an `Origin` from a non-loopback host gets 403.
  The `Origin` itself is judged by trust level, not by string equality: `localhost:59101` and `127.0.0.1:59101` are the same machine on the same port, and `null`/`file://` are equivalent to "no Origin" (a local file can read loopback without a browser at all). A literal comparison cannot work here — a WebSocket handshake *always* carries an `Origin` while a same-origin `fetch` usually does not, so it would turn away the terminal of the very GUI that serves the panel. Another local port is still refused: that is a different application.
- **Secrets stay local.** `GET /hosts` replaces passwords with `hasPassword: true`; plaintext never crosses the wire.
- **Credentials never enter the repo.** Keys, `dsh-ssh.json`, and exported CSVs are all in `.gitignore`; the repository contains no real host record.
- **No agent, no egress, no account.**

---

## Compatibility

| DSH | Status |
|---|---|
| `0.2.2-rc.1` | Verified on a real fleet: 37 hosts, concurrency 6, 31.9 s per sweep, `node:sqlite` backend |

The host API is still release-candidate, so the plugin adapts by **capability detection**: `webServer` is required, while `tools` and `systemPrompt` may be absent without breaking the rest.

Host contracts that cost real hours to discover, listed so they cost nobody else any:

1. `export const inject` must be a **plain string array**, not `{required, optional}`. The object shape reads as "no services", `ctx.webServer` stays `undefined`, and not one route registers — the browser half then sees 401 on every call.
2. `apply` must be **synchronous**. The loader does not await its return value, so a rejection inside an `async` apply becomes an unhandled rejection and is swallowed.
3. A `volatile()` field resolves to a **`{ get(): T }` reference**, not a value. Reading `config.x` directly yields an object, every clamp falls back to its default, and the settings page silently stops working.
4. One route per `path` — the route registry rejects duplicate `(kind, path)`, so CRUD dispatches on `method` inside a single handler.
5. Every tool must declare `output: { schema, render }`. **A tool missing it throws, and cordis rolls back every effect of that entry** — the routes registered before it disappear too, so the symptom is indistinguishable from "the routes were never written". This is the easiest one to misread: the unit suite stays green while every API answers 401 in the live host.
6. The host answers **401, not 404, for an `/api/*` path it has no route for**. A 401 therefore means "no route registered", not "bad credentials". To see the real load error, install the plugin into `--profile web` and start it from the CLI — stderr then prints `entry did not activate`.

---

## Development

Zero build: `lib/*.js` is the artifact. Restart DSH to reload the host half.

```bash
node --test "test/**/*.test.mjs"   # 51 tests, no external dependencies
```

Covered: collector parsing and rate derivation (including counter rollback), identical row shape across both storage backends, `~/.ssh/config` parsing, the loopback fence and CRUD validation on every route, mount/unmount/waiter replay, and the browser-half bundle contract.

---

## License

MIT.
