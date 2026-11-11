# dsh-fleet-monitor · Fleet Monitor

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

- **Overview** — stat cards (all / online / alerting / offline / panel-owned) that double as filters; search, group filter, sort by alias, CPU, memory, disk, latency, or state; table and card views; offline rows carry a red edge.
- **Hosts** — add, edit, and delete from the panel. Fields: alias, address, port, user, auth (key / password / agent), key path, passphrase, password, group, tags, note. **Test connection** before saving reports `12 ms · Ubuntu 24.04`. Stored secrets are never sent back; leaving them blank on edit keeps the saved value.
- **Detail** — OS, kernel, arch, cores, CPU model, latency, uptime, swap, TCP/UDP, process count, plus three charts: CPU %, memory %, network KB/s over the last hour at 30-second resolution.
- **Live** — snapshots stream over `EventSource`; on error the panel falls back to 30-second polling so a reconnect backoff never freezes the view.
- **Agent tools** — `fleet_snapshot`, `fleet_history`, `fleet_refresh`.

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

- **Loopback only.** Every route passes a fence: a non-`127.0.0.1`/`::1` source, any request carrying `X-Forwarded-For` or `CF-Connecting-IP` (a proxy is in front), `sec-fetch-site: cross-site`, or a cross-origin `Origin` gets 403.
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
