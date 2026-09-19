import { Effect } from 'effect'

import { type DnsRecordSelector, desiredSlotPostcondition, recordMatchesSelector } from './dns-records.js'
import type { DoomainEffect } from './effect.js'
import { DoomainError } from './errors.js'
import type { DnsProvider, DnsRecord, DnsRecordInput, DnsZone } from './providers/types.js'

interface RetryDependencies {
  now?: () => number
  sleep?: (milliseconds: number) => DoomainEffect<void, never>
}

export interface ReconciliationResult {
  appliedChanges: number
  attempts: number
  observed: DnsRecord[]
  reconciled: true
}

const sleep = (milliseconds: number): DoomainEffect<void, never> => Effect.sleep(milliseconds)

export function reconcileDesiredRecord(input: {
  desired: DnsRecordInput
  intervalMs?: number
  provider: DnsProvider
  timeoutMs?: number
  zone: DnsZone
  progress?: (message: string) => void
  dependencies?: RetryDependencies
}): DoomainEffect<ReconciliationResult> {
  return Effect.gen(function* () {
    const now = input.dependencies?.now ?? Date.now
    const wait = input.dependencies?.sleep ?? sleep
    const deadline = now() + (input.timeoutMs ?? 30_000)
    let attempts = 0
    const appliedChanges = 0

    while (true) {
      attempts += 1
      const records = yield* input.provider.listRecords(input.zone)
      const state = desiredSlotPostcondition(records, input.desired)
      if (state.reconciled) return { appliedChanges, attempts, observed: state.observed, reconciled: true }

      if (now() >= deadline) {
        return yield* Effect.fail(
          new DoomainError(
            'DNS_RECONCILIATION_INCOMPLETE',
            `The DNS provider accepted the change, but the ${input.desired.type} ${input.desired.name} slot is not reconciled yet.`,
            {
              attempts,
              expected: input.desired,
              observed: state.observed,
              recovery: 'Retry the command. Do not treat the DNS change as complete until reconciled is true.',
            },
          ),
        )
      }

      input.progress?.('Waiting for the DNS provider to publish the accepted change')
      const remaining = deadline - now()
      yield* wait(Math.min(input.intervalMs ?? 1000, Math.max(0, remaining)))
    }
  })
}

export function reconcileRecordRemoval(input: {
  intervalMs?: number
  provider: DnsProvider
  selector: DnsRecordSelector
  timeoutMs?: number
  zone: DnsZone
  progress?: (message: string) => void
  dependencies?: RetryDependencies
}): DoomainEffect<ReconciliationResult> {
  return Effect.gen(function* () {
    const now = input.dependencies?.now ?? Date.now
    const wait = input.dependencies?.sleep ?? sleep
    const deadline = now() + (input.timeoutMs ?? 30_000)
    let attempts = 0
    const appliedChanges = 0

    while (true) {
      attempts += 1
      const records = yield* input.provider.listRecords(input.zone)
      const observed = records.filter((record) => recordMatchesSelector(record, input.selector))
      if (observed.length === 0) return { appliedChanges, attempts, observed, reconciled: true }

      if (now() >= deadline) {
        return yield* Effect.fail(
          new DoomainError(
            'DNS_RECONCILIATION_INCOMPLETE',
            `The DNS provider accepted the deletion, but ${observed.length} matching record${observed.length === 1 ? '' : 's'} remain.`,
            {
              attempts,
              observed,
              selector: input.selector,
              recovery: 'Retry the command. Do not treat the DNS deletion as complete until reconciled is true.',
            },
          ),
        )
      }

      input.progress?.('Waiting for the DNS provider to publish the accepted deletion')
      const remaining = deadline - now()
      yield* wait(Math.min(input.intervalMs ?? 1000, Math.max(0, remaining)))
    }
  })
}
