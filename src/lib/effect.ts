import { Effect } from 'effect'

import { type DoomainError, type DoomainErrorCode, toDoomainError } from './errors.js'

export type DoomainEffect<A, E = DoomainError> = Effect.Effect<A, E>

export function trySync<A>(evaluate: () => A, fallbackCode: DoomainErrorCode): DoomainEffect<A> {
  return Effect.try({
    try: evaluate,
    catch: (error) => toDoomainError(error, fallbackCode),
  })
}

export function tryPromise<A>(evaluate: () => PromiseLike<A>, fallbackCode: DoomainErrorCode): DoomainEffect<A> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (error) => toDoomainError(error, fallbackCode),
  })
}

export async function runDoomainEffect<A>(effect: DoomainEffect<A>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect))
  if (result._tag === 'Left') throw result.left
  return result.right
}
