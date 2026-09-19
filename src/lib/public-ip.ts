import { Effect } from 'effect'

import type { DoomainEffect } from './effect.js'

export function fetchPublicIp(): DoomainEffect<string | undefined, never> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      return { controller, timeout }
    }),
    ({ controller }) =>
      Effect.tryPromise(async () => {
        const response = await fetch('https://api.ipify.org', { signal: controller.signal })
        if (!response.ok) return undefined
        const ip = (await response.text()).trim()
        return ip || undefined
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    ({ timeout }) => Effect.sync(() => clearTimeout(timeout)),
  )
}
