/**
 * Scheduled task execution.
 *
 * The two properties worth pinning are the ones that keep a fleet alive: a task
 * never overlaps another, and every covered host shows up in the stored output
 * (an operator's first question after a partial failure is "which ones worked").
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../lib/store.js'
import { resolveCover, summariseOutput, TaskRunner } from '../lib/tasks.js'

function makeStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fm-tasks-'))
  const store = openStore({ dshHome: dir, keep: 10 })
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

const host = (alias) => ({ alias, host: '10.0.0.11', port: 22, user: 'deploy', source: 'dsh-ssh', auth: { kind: 'agent' }, tags: [] })

function makeRunner(t, store, overrides = {}) {
  const calls = []
  const collector = { hosts: overrides.hosts ?? [host('web-01'), host('web-02')] }
  const runner = new TaskRunner({
    store,
    collector,
    getConfig: () => ({ connectTimeoutMs: 15_000, agentSocket: '' }),
    emit: () => {},
    pool: {
      run: overrides.run ?? (async (target, _config, command) => {
        calls.push({ alias: target.alias, command })
        return { code: 0, stdout: `${target.alias} ok`, stderr: '' }
      }),
    },
  })
  t.after(() => runner.dispose())
  return { runner, calls, collector }
}

test('a cover resolves to the hosts it names, in every mode', () => {
  const hosts = [host('a'), host('b'), host('c')]
  assert.deepEqual(resolveCover({ mode: 'all', aliases: [] }, hosts).map((item) => item.alias), ['a', 'b', 'c'])
  assert.deepEqual(resolveCover({ mode: 'include', aliases: ['b'] }, hosts).map((item) => item.alias), ['b'])
  assert.deepEqual(resolveCover({ mode: 'exclude', aliases: ['b'] }, hosts).map((item) => item.alias), ['a', 'c'])
  // A missing cover means "everything", which is also what the column defaults to.
  assert.equal(resolveCover(undefined, hosts).length, 3)
})

test('the stored output names every host, failing ones included', () => {
  const text = summariseOutput([
    { alias: 'web-01', ok: true, exitCode: 0, stdout: 'up 3 days', stderr: '' },
    { alias: 'web-02', ok: false, exitCode: 2, stdout: '', stderr: 'no such file' },
    { alias: 'db-01', ok: false, error: 'timed out', stdout: '', stderr: '' },
  ])
  assert.match(text, /--- web-01 \(exit 0\) ---/)
  assert.match(text, /up 3 days/)
  assert.match(text, /--- web-02 \(exit 2\) ---/)
  assert.match(text, /no such file/)
  assert.match(text, /--- db-01 \(timed out\) ---/)
})

test('a host that prints megabytes keeps only its tail, and the whole column is capped', () => {
  const noise = 'x'.repeat(50_000)
  const single = summariseOutput([{ alias: 'web-01', ok: true, exitCode: 0, stdout: noise, stderr: '' }])
  // One host is bounded on its own: the tail is where the error usually is.
  assert.ok(single.length < 1200, `one host produced ${single.length} bytes`)

  const many = Array.from({ length: 12 }, (_, index) => ({
    alias: `web-${index}`, ok: true, exitCode: 0, stdout: noise, stderr: '',
  }))
  const text = summariseOutput(many)
  assert.ok(text.length <= 8192, `output was ${text.length} bytes`)
  // Hosts that did not fit are named, so the omission is visible rather than silent.
  assert.match(text, /\[truncated\] \d+ more host\(s\): web-\d+(, web-\d+)*$/)
})

test('a run covers every host and records one run row', async (t) => {
  const store = makeStore(t)
  const { runner, calls } = makeRunner(t, store)
  const taskId = store.upsertCronTask({ name: 'uptime', schedule: '*/5 * * * *', command: 'uptime' })

  const result = await runner.runTask(store.listCronTasks()[0], { manual: true })

  assert.deepEqual(calls.map((call) => call.alias).sort(), ['web-01', 'web-02'])
  assert.equal(result.ok, true)
  assert.equal(result.total, 2)
  assert.equal(result.okCount, 2)
  assert.equal(store.listCronRuns(taskId).length, 1)
  assert.equal(store.listCronTasks()[0].lastOk, true, 'the task remembers the outcome')
  assert.ok(Number.isInteger(store.listCronTasks()[0].lastRunAt))
})

test('one failing host marks the run as failed but still runs the rest', async (t) => {
  const store = makeStore(t)
  const { runner } = makeRunner(t, store, {
    hosts: [host('web-01'), host('web-02'), host('web-03')],
    run: async (target) => (target.alias === 'web-02'
      ? { code: 1, stdout: '', stderr: 'permission denied' }
      : { code: 0, stdout: 'ok', stderr: '' }),
  })
  store.upsertCronTask({ name: 'restart', schedule: '0 4 * * *', command: 'systemctl restart app' })

  const result = await runner.runTask(store.listCronTasks()[0], { manual: true })
  assert.equal(result.ok, false)
  assert.equal(result.total, 3)
  assert.equal(result.okCount, 2)
  assert.match(result.output, /permission denied/)
  assert.equal(store.listCronTasks()[0].lastOk, false)
})

test('a second task cannot start while one is running', async (t) => {
  const store = makeStore(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { runner } = makeRunner(t, store, {
    run: async () => {
      await gate
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  store.upsertCronTask({ name: 'slow', schedule: '0 4 * * *', command: 'sleep 60' })
  store.upsertCronTask({ name: 'other', schedule: '0 5 * * *', command: 'true' })
  const [first, second] = store.listCronTasks()

  const running = runner.runTask(first, { manual: true })
  const skipped = await runner.runTask(second, { manual: true })
  assert.equal(skipped.skipped, 'another task is already running')
  release()
  await running
  // Exactly one run was recorded: the skipped attempt must not leave a row.
  assert.equal(store.listCronRuns(first.id).length, 1)
  assert.equal(store.listCronRuns(second.id).length, 0)
})

test('a host behind a jump box is reported instead of silently dropped', async (t) => {
  const store = makeStore(t)
  const jumped = { ...host('jump-01'), proxyJump: [{ host: 'bastion', user: 'ops' }] }
  const { runner, calls } = makeRunner(t, store, { hosts: [host('web-01'), jumped] })
  store.upsertCronTask({ name: 'uptime', schedule: '*/5 * * * *', command: 'uptime' })

  const result = await runner.runTask(store.listCronTasks()[0], { manual: true })
  assert.equal(calls.length, 1, 'the reachable host still ran')
  assert.match(result.output, /jump-01 \(proxy jump not supported\)/)
  assert.equal(result.okCount, 1)
  assert.equal(result.total, 2)
})

test('the scheduler picks the soonest pending task', (t) => {
  const store = makeStore(t)
  const { runner } = makeRunner(t, store)
  store.upsertCronTask({ name: 'every minute', schedule: '* * * * *', command: 'true' })
  store.upsertCronTask({ name: 'never soon', schedule: '0 4 1 1 *', command: 'true' })
  runner.reload()

  const next = runner.nextAt(new Date('2026-03-01T10:00:00').getTime())
  const minute = store.listCronTasks().find((task) => task.name === 'every minute')
  assert.equal(next.taskId, minute.id)
  assert.equal(next.at, new Date('2026-03-01T10:01:00').getTime())
})

test('a disabled task is not scheduled at all', (t) => {
  const store = makeStore(t)
  const { runner } = makeRunner(t, store)
  store.upsertCronTask({ name: 'off', schedule: '* * * * *', command: 'true', enabled: false })
  store.upsertCronTask({ name: 'on', schedule: '0 4 * * *', command: 'true' })
  runner.reload()
  const enabled = store.listCronTasks().find((task) => task.name === 'on')
  assert.equal(runner.nextAt(new Date('2026-03-01T10:00:00').getTime()).taskId, enabled.id)
})

test('a row edited into an invalid schedule is skipped without breaking the rest', (t) => {
  const store = makeStore(t)
  const { runner } = makeRunner(t, store)
  store.upsertCronTask({ name: 'broken', schedule: 'not a cron', command: 'true' })
  store.upsertCronTask({ name: 'fine', schedule: '0 4 * * *', command: 'true' })
  runner.reload()
  assert.equal(runner.nextAt(new Date('2026-03-01T10:00:00').getTime()).taskId,
    store.listCronTasks().find((task) => task.name === 'fine').id)
})

test('deleting a task removes its run history', (t) => {
  const store = makeStore(t)
  const id = store.upsertCronTask({ name: 'uptime', schedule: '*/5 * * * *', command: 'uptime' })
  store.insertCronRun(id, { ts: 1, total: 1, okCount: 1, durationMs: 5, output: 'ok' })
  assert.equal(store.listCronRuns(id).length, 1)
  assert.equal(store.deleteCronTask(id), true)
  assert.equal(store.listCronTasks().length, 0)
  assert.equal(store.listCronRuns(id).length, 0)
  assert.equal(store.deleteCronTask(id), false, 'a second delete reports nothing was there')
})

test('only the newest runs are kept', (t) => {
  const store = makeStore(t)
  const id = store.upsertCronTask({ name: 'chatty', schedule: '* * * * *', command: 'true' })
  for (let index = 0; index < 510; index += 1) {
    store.insertCronRun(id, { ts: index, total: 1, okCount: 1, durationMs: 1, output: '' })
  }
  const runs = store.listCronRuns(id, 1000)
  assert.equal(runs.length, 500)
  assert.equal(runs[0].ts, 509, 'the newest run is first')
})
