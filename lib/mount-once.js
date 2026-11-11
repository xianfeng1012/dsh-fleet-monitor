/**
 * Mount-once guard shared by every surface this plugin registers.
 *
 * A DSH host can evaluate a plugin module more than once (hot reload, two
 * loader passes, a preset plus a bundle), and each evaluation would otherwise
 * register a second copy of the same route or tool. The guard keys on a
 * `Symbol.for` slot so the first successful mount wins across module instances.
 *
 * The guard has to be *released*, not just taken. The host disposes a plugin's
 * effects when it unloads or reloads it, and a guard that stayed held would make
 * the plugin silently inert after the first reload — it would look enabled in the
 * UI while registering nothing. So the guard owns one effect of its own, and its
 * disposer clears the id and replays whoever was queued behind it.
 *
 * Everything here stays synchronous. The host calls `apply` during its own fiber
 * setup and never awaits a returned promise, so an async `apply` turns every
 * mount failure into an unhandled rejection the loader never sees — the plugin
 * then looks mounted while nothing is registered.
 *
 * @module dsh-fleet-monitor/mount-once
 */

/** Global registry of mounted plugin ids. */
const MOUNTED = Symbol.for('dsh-web.mounted-plugins')

/** Global queue of mounts waiting for their id to be released. */
const WAITERS = Symbol.for('dsh-web.mounted-plugins.waiters')

/**
 * Run `applyImpl` at most once per `packageName` in this host process.
 *
 * @param packageName - plugin id used as the dedupe key.
 * @param applyImpl - the real plugin `apply`, which must be synchronous.
 * @returns the host-facing `apply`, also synchronous.
 */
export function mountOnce(packageName, applyImpl) {
  function apply(ctx, config) {
    const mounted = (globalThis[MOUNTED] ??= new Set())
    const waiters = (globalThis[WAITERS] ??= new Map())

    if (mounted.has(packageName)) {
      // A live mount owns the surfaces. Queue this attempt so the release can
      // hand them over, instead of failing the load or double-registering.
      const queue = waiters.get(packageName) ?? []
      queue.push({ ctx, config })
      waiters.set(packageName, queue)
      return
    }

    mounted.add(packageName)

    // Registered before `applyImpl` runs: a cordis context only accepts new
    // effects while the plugin is still being set up.
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => () => {
          mounted.delete(packageName)
          const queue = waiters.get(packageName)
          if (queue === undefined || queue.length === 0) return
          waiters.delete(packageName)
          for (const waiter of queue) {
            // A queued mount that fails is the host's problem to report, not a
            // reason to lose the remaining queue entries.
            try {
              apply(waiter.ctx, waiter.config)
            } catch (error) {
              console.warn(`[${packageName}] queued mount failed:`, error)
            }
          }
        },
        `${packageName}: mount guard`,
      )
    }

    try {
      applyImpl(ctx, config)
    } catch (error) {
      // A failed mount must not leave the id held, or the retry is locked out
      // and the queued attempts never run.
      mounted.delete(packageName)
      throw error
    }
  }

  return apply
}
