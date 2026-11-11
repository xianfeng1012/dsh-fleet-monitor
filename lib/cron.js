/**
 * A five field cron parser, small enough to read in one sitting.
 *
 * The plugin has to schedule a handful of operator commands on their own hosts.
 * Pulling in a cron library for that would add a dependency every DSH user pays
 * for, and the expression itself is only ever typed by the same operator who
 * wrote the command — so this file optimises for refusing bad input loudly
 * rather than for the corners of the format nobody types.
 *
 * Supported: `*`, single values, `a-b` ranges, `a-b/n` and `a/n` steps, and
 * comma separated lists of any of those. Day names and `@daily` style shortcuts
 * are deliberately absent: `describeCron` explains the expression back in words
 * so the panel can show what the operator actually scheduled.
 */

const FIELDS = [
  { key: 'minutes', name: 'minute', min: 0, max: 59 },
  { key: 'hours', name: 'hour', min: 0, max: 23 },
  { key: 'days', name: 'day of month', min: 1, max: 31 },
  { key: 'months', name: 'month', min: 1, max: 12 },
  { key: 'weekdays', name: 'day of week', min: 0, max: 7 },
]

const MINUTE_MS = 60_000
const SEARCH_LIMIT = 366 * 24 * 60

function fail(name, detail) {
  throw new Error(`${name} field: ${detail}`)
}

function parseField(text, field) {
  const values = new Set()
  for (const part of text.split(',')) {
    if (part === '') fail(field.name, 'contains an empty list item')
    const slash = part.indexOf('/')
    const head = slash === -1 ? part : part.slice(0, slash)
    const stepText = slash === -1 ? null : part.slice(slash + 1)
    let step = 1
    if (stepText !== null) {
      step = Number(stepText)
      if (!Number.isInteger(step) || step < 1) fail(field.name, `"${part}" has an invalid step`)
    }

    let from
    let to
    if (head === '*') {
      from = field.min
      to = field.max
    } else if (head.includes('-')) {
      const [left, right] = head.split('-')
      from = Number(left)
      to = Number(right)
      if (left === '' || right === '') fail(field.name, `"${part}" is not a range`)
    } else {
      from = Number(head)
      // `5/10` means "from 5, every 10, until the field ends"; a bare `5` is one value.
      to = stepText === null ? from : field.max
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) fail(field.name, `"${part}" is not a number`)
    if (from < field.min || to > field.max) {
      fail(field.name, `"${part}" is outside ${field.min}-${field.max}`)
    }
    if (from > to) fail(field.name, `"${part}" runs backwards`)

    for (let value = from; value <= to; value += step) values.add(value)
  }

  // Both 0 and 7 name Sunday; keep one so a set comparison stays meaningful.
  if (field.key === 'weekdays' && values.has(7)) {
    values.delete(7)
    values.add(0)
  }
  return values
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('the schedule must be a string')
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`a schedule needs five fields (minute hour day month weekday), got ${parts.length}`)
  }
  const parsed = {}
  for (let index = 0; index < FIELDS.length; index += 1) {
    parsed[FIELDS[index].key] = parseField(parts[index], FIELDS[index])
  }
  return parsed
}

/**
 * The next matching minute strictly after `from`, or null when the expression can
 * never match again (the 29th of February, or an impossible combination).
 *
 * Walking minute by minute is slower than the calendar arithmetic the big
 * libraries do, but the worst case here is bounded by a year of minutes and the
 * walk cannot get the month boundaries or leap years wrong.
 */
export function nextRun(parsed, from = Date.now()) {
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  // Standard cron treats a restricted day-of-month and a restricted day-of-week
  // as an OR, and only ANDs the two when one of them is a wildcard.
  const dayRestricted = parsed.days.size < 31
  const weekdayRestricted = parsed.weekdays.size < 7

  for (let step = 0; step < SEARCH_LIMIT; step += 1) {
    const dayMatches = dayRestricted && weekdayRestricted
      ? parsed.days.has(cursor.getDate()) || parsed.weekdays.has(cursor.getDay())
      : parsed.days.has(cursor.getDate()) && parsed.weekdays.has(cursor.getDay())

    if (dayMatches &&
      parsed.months.has(cursor.getMonth() + 1) &&
      parsed.hours.has(cursor.getHours()) &&
      parsed.minutes.has(cursor.getMinutes())) {
      return cursor.getTime()
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (value) => String(value).padStart(2, '0')

/**
 * A sentence for the panel. Chinese by default because the UI is, with an English
 * variant for the `en` locale; anything unusual falls back to the raw expression
 * rather than a wrong sentence.
 */
export function describeCron(expr, lang = 'zh') {
  let parsed
  try {
    parsed = parseCron(expr)
  } catch {
    return expr
  }
  const en = lang === 'en'
  const minutes = [...parsed.minutes].sort((a, b) => a - b)
  const hours = [...parsed.hours].sort((a, b) => a - b)
  const everyDay = parsed.days.size === 31 && parsed.months.size === 12 && parsed.weekdays.size === 7

  if (minutes.length === 1 && hours.length === 1 && everyDay) {
    const time = `${pad(hours[0])}:${pad(minutes[0])}`
    return en ? `every day at ${time}` : `每天 ${time}`
  }
  if (minutes.length === 1 && hours.length === 1 && parsed.days.size === 31 && parsed.months.size === 12) {
    const time = `${pad(hours[0])}:${pad(minutes[0])}`
    const names = en ? WEEKDAY_NAMES_EN : WEEKDAY_NAMES
    const days = [...parsed.weekdays].sort((a, b) => a - b).map((day) => names[day]).join(', ')
    return en ? `${time} on ${days}` : `${days} ${time}`
  }
  const step = minutes.length > 1 ? minutes[1] - minutes[0] : 0
  if (step > 0 && minutes[0] === 0 && hours.length === 24 && everyDay) {
    return en ? `every ${step} minutes` : `每 ${step} 分钟`
  }
  if (minutes.length === 1 && minutes[0] === 0 && hours.length === 24 && everyDay) {
    return en ? 'every hour, on the hour' : '每小时整点'
  }
  if (minutes.length === 1 && hours.length === 24 && everyDay) {
    return en ? `every hour at :${pad(minutes[0])}` : `每小时第 ${pad(minutes[0])} 分`
  }
  return expr
}
