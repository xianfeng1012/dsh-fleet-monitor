/**
 * Cron parsing and the next-run arithmetic.
 *
 * The interesting cases are the ones that decide *when* something runs on a
 * production host, so they are pinned here: the OR between day-of-month and
 * day-of-week, the Sunday-is-both-0-and-7 rule, and the expressions that can
 * never fire again.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeCron, nextRun, parseCron } from '../lib/cron.js'

const at = (text) => new Date(text).getTime()

test('every field shape the format allows parses to the right set', () => {
  const parsed = parseCron('*/15 9-17 1,15 3 *')
  assert.deepEqual([...parsed.minutes].sort((a, b) => a - b), [0, 15, 30, 45])
  assert.deepEqual([...parsed.hours].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual([...parsed.days].sort((a, b) => a - b), [1, 15])
  assert.deepEqual([...parsed.months], [3])
  assert.equal(parsed.weekdays.size, 7, '`*` fills the whole range')
})

test('steps run to the end of the field, not to the next multiple', () => {
  // `5/10` starts at 5: 5, 15, 25 ... 55.
  const parsed = parseCron('5/10 * * * *')
  assert.deepEqual([...parsed.minutes].sort((a, b) => a - b), [5, 15, 25, 35, 45, 55])
  // `10-20/5` stays inside its range.
  const ranged = parseCron('10-20/5 * * * *')
  assert.deepEqual([...ranged.minutes].sort((a, b) => a - b), [10, 15, 20])
})

test('Sunday is reachable as both 0 and 7', () => {
  assert.deepEqual([...parseCron('0 3 * * 7').weekdays], [0])
  assert.deepEqual([...parseCron('0 3 * * 0').weekdays], [0])
  assert.deepEqual([...parseCron('0 3 * * 1-5').weekdays].sort((a, b) => a - b), [1, 2, 3, 4, 5])
})

test('bad input is refused with the field named', () => {
  assert.throws(() => parseCron('* * * *'), /five fields/)
  assert.throws(() => parseCron('61 * * * *'), /minute field: .*outside 0-59/)
  assert.throws(() => parseCron('* 24 * * *'), /hour field: .*outside 0-23/)
  assert.throws(() => parseCron('* * 0 * *'), /day of month field: .*outside 1-31/)
  assert.throws(() => parseCron('* * * 13 *'), /month field: .*outside 1-12/)
  assert.throws(() => parseCron('* * * * */0'), /invalid step/)
  assert.throws(() => parseCron('5-1 * * * *'), /runs backwards/)
  assert.throws(() => parseCron('1,,2 * * * *'), /empty list item/)
  assert.throws(() => parseCron('a * * * *'), /not a number/)
})

test('the next run is strictly after the given minute', () => {
  const everyFive = parseCron('*/5 * * * *')
  // 10:00 exactly is the current minute, so the answer is 10:05.
  assert.equal(nextRun(everyFive, at('2026-03-01T10:00:00')), at('2026-03-01T10:05:00'))
  // 10:04:30 rounds into the 10:05 slot rather than firing immediately.
  assert.equal(nextRun(everyFive, at('2026-03-01T10:04:30')), at('2026-03-01T10:05:00'))
})

test('the next run crosses hour and day boundaries', () => {
  const nightly = parseCron('30 3 * * *')
  assert.equal(nextRun(nightly, at('2026-03-01T04:00:00')), at('2026-03-02T03:30:00'))
  const hourly = parseCron('0 * * * *')
  assert.equal(nextRun(hourly, at('2026-03-01T10:59:00')), at('2026-03-01T11:00:00'))
})

test('day-of-month and day-of-week are an OR when both are restricted', () => {
  // "the 1st, or any Monday"
  const expr = parseCron('0 9 1 * 1')
  // 2026-03-01 is a Sunday, so the 1st still matches.
  assert.equal(nextRun(expr, at('2026-02-28T10:00:00')), at('2026-03-01T09:00:00'))
  // After that, the next match is Monday the 2nd (weekday rule) rather than April 1st.
  assert.equal(nextRun(expr, at('2026-03-01T10:00:00')), at('2026-03-02T09:00:00'))
})

test('an impossible expression returns null instead of spinning', () => {
  assert.equal(nextRun(parseCron('0 0 30 2 *'), at('2026-03-01T00:00:00')), null)
})

test('the schedule is described back in words, or echoed when unusual', () => {
  assert.equal(describeCron('*/5 * * * *'), '每 5 分钟')
  assert.equal(describeCron('0 * * * *'), '每小时整点')
  assert.equal(describeCron('30 3 * * *'), '每天 03:30')
  assert.equal(describeCron('30 3 * * 1'), '周一 03:30')
  assert.equal(describeCron('*/5 * * * *', 'en'), 'every 5 minutes')
  assert.equal(describeCron('30 3 * * *', 'en'), 'every day at 03:30')
  // Anything the sentence builder does not recognise is shown verbatim: a wrong
  // sentence is worse than the expression the operator typed.
  assert.equal(describeCron('7 8 9 10 11'), '7 8 9 10 11')
  assert.equal(describeCron('not a schedule'), 'not a schedule')
})
