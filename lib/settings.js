/**
 * The config keys the Settings tab may change.
 *
 * The host owns every field of our Config schema: a volatile() field resolves to
 * a reference whose owner writes it in place, so a plugin can read it and never
 * write it. A settings form that saved into that object would appear to work and
 * change nothing, which is the worst kind of broken. Overrides therefore live in
 * our own database and are merged over the host config on every read, which is
 * also why this table exists in a separate module: both the host half and the
 * routes need it, and neither may import the other.
 *
 * Only the keys listed here are overridable. Keeping the list explicit means a
 * typo in a request cannot invent a config key that the rest of the plugin would
 * never read.
 */
export const OVERRIDABLE = {
  intervalMs: { kind: 'number', min: 5_000, max: 3_600_000 },
  slowIntervalMs: { kind: 'number', min: 60_000, max: 86_400_000 },
  slowTimeoutMs: { kind: 'number', min: 2_000, max: 120_000 },
  execTimeoutMs: { kind: 'number', min: 1_000, max: 120_000 },
  connectTimeoutMs: { kind: 'number', min: 1_000, max: 120_000 },
  concurrency: { kind: 'number', min: 1, max: 32 },
  keep: { kind: 'number', min: 60, max: 2880 },
  cpuAlertPct: { kind: 'number', min: 1, max: 100 },
  memAlertPct: { kind: 'number', min: 1, max: 100 },
  diskAlertPct: { kind: 'number', min: 1, max: 100 },
  announceToAgent: { kind: 'boolean' },
  excludeAliases: { kind: 'stringList' },
  fsRoots: { kind: 'pathList' },
  maxDownloadBytes: { kind: 'number', min: 1024, max: 2_147_483_648 },
  maxUploadBytes: { kind: 'number', min: 1024, max: 2_147_483_648 },
}

/**
 * Keep only the overrides that are still valid.
 *
 * Applied on every read, not only on write: the settings table is an ordinary
 * SQLite file, and a hand-edited row must not be able to hand the collector an
 * interval of zero.
 */
export function sanitiseOverrides(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [key, spec] of Object.entries(OVERRIDABLE)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      out[key] = Math.min(spec.max, Math.max(spec.min, Math.round(value)))
      continue
    }
    if (spec.kind === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (spec.kind === 'stringList') {
      if (!Array.isArray(value)) continue
      out[key] = value
        .filter(item => typeof item === 'string' && item.trim() !== '')
        .map(item => item.trim())
        .slice(0, 500)
      continue
    }
    if (spec.kind === 'pathList') {
      if (!Array.isArray(value)) continue
      const paths = value
        .filter(item => typeof item === 'string' && item.startsWith('/'))
        .map(item => item.trim())
      if (paths.length > 0) out[key] = paths.slice(0, 32)
    }
  }
  return out
}

/** The overridable subset of a resolved config, for the settings form. */
export function pickValues(config) {
  const out = {}
  for (const key of Object.keys(OVERRIDABLE)) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}
