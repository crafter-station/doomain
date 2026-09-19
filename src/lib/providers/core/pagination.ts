import { Effect } from 'effect'

import type { DoomainEffect } from '../../effect.js'

export interface SkipPaginationInput<T> {
  fetchPage(input: { skip: number; take: number }): DoomainEffect<{ items: T[]; total: number }>
  maxPages?: number
  take: number
}

export function paginateBySkip<T>(input: SkipPaginationInput<T>): DoomainEffect<T[]> {
  return Effect.gen(function* () {
    const items: T[] = []
    const maxPages = input.maxPages ?? 100
    let skip = 0
    let total = Number.POSITIVE_INFINITY

    for (let page = 0; skip < total && page < maxPages; page += 1) {
      const result = yield* input.fetchPage({ skip, take: input.take })
      items.push(...result.items)
      total = result.total
      if (result.items.length === 0) break
      skip += result.items.length
    }

    return items
  })
}
