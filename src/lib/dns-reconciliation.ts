import { type DnsRecordSelector, desiredSlotPostcondition, recordMatchesSelector } from './dns-records.js'
import { DoomainError } from './errors.js'
import type { DnsChangePlan, DnsProvider, DnsRecord, DnsRecordInput, DnsZone } from './providers/types.js'

interface RetryDependencies {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface ReconciliationResult {
  appliedChanges: number
  attempts: number
  observed: DnsRecord[]
  reconciled: true
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export async function reconcileDesiredRecord(input: {
  desired: DnsRecordInput
  intervalMs?: number
  provider: DnsProvider
  timeoutMs?: number
  zone: DnsZone
  progress?: (message: string) => void
  dependencies?: RetryDependencies
}): Promise<ReconciliationResult> {
  const now = input.dependencies?.now ?? Date.now
  const wait = input.dependencies?.sleep ?? sleep
  const deadline = now() + (input.timeoutMs ?? 30_000)
  let attempts = 0
  let appliedChanges = 0

  while (true) {
    attempts += 1
    const records = await input.provider.listRecords(input.zone)
    const state = desiredSlotPostcondition(records, input.desired)
    if (state.reconciled) return { appliedChanges, attempts, observed: state.observed, reconciled: true }

    if (now() >= deadline) {
      throw new DoomainError(
        'DNS_RECONCILIATION_INCOMPLETE',
        `The DNS provider accepted the change, but the ${input.desired.type} ${input.desired.name} slot is not reconciled yet.`,
        {
          attempts,
          expected: input.desired,
          observed: state.observed,
          recovery: 'Retry the command. Do not treat the DNS change as complete until reconciled is true.',
        },
      )
    }

    input.progress?.('Provider state is still stale; reconciling DNS records')
    const plan = await input.provider.planChanges(input.zone, [input.desired], { force: true })
    if (plan.changes.some((change) => change.action !== 'skip')) {
      const result = await input.provider.applyChanges(input.zone, plan, { force: true })
      appliedChanges += result.applied.length
    }

    const remaining = deadline - now()
    await wait(Math.min(input.intervalMs ?? 1000, Math.max(0, remaining)))
  }
}

export async function reconcileRecordRemoval(input: {
  intervalMs?: number
  plannedRecords: DnsRecord[]
  provider: DnsProvider
  selector: DnsRecordSelector
  timeoutMs?: number
  zone: DnsZone
  progress?: (message: string) => void
  dependencies?: RetryDependencies
}): Promise<ReconciliationResult> {
  const now = input.dependencies?.now ?? Date.now
  const wait = input.dependencies?.sleep ?? sleep
  const deadline = now() + (input.timeoutMs ?? 30_000)
  let attempts = 0
  let appliedChanges = 0

  while (true) {
    attempts += 1
    const records = await input.provider.listRecords(input.zone)
    const observed = records.filter((record) => recordMatchesSelector(record, input.selector))
    if (observed.length === 0) return { appliedChanges, attempts, observed, reconciled: true }

    if (now() >= deadline) {
      throw new DoomainError(
        'DNS_RECONCILIATION_INCOMPLETE',
        `The DNS provider accepted the deletion, but ${observed.length} matching record${observed.length === 1 ? '' : 's'} remain.`,
        {
          attempts,
          observed,
          selector: input.selector,
          recovery: 'Retry the command. Do not treat the DNS deletion as complete until reconciled is true.',
        },
      )
    }

    input.progress?.('Provider state is still stale; retrying DNS record deletion')
    const plannedIds = new Set(input.plannedRecords.flatMap((record) => (record.id ? [record.id] : [])))
    // Without stable ids, a stale read and a concurrently-created identical record are
    // indistinguishable. Poll for the accepted deletion instead of risking an unplanned delete.
    const retryable = observed.filter((record) => record.id && plannedIds.has(record.id))

    if (retryable.length === 0) {
      const remaining = deadline - now()
      await wait(Math.min(input.intervalMs ?? 1000, Math.max(0, remaining)))
      continue
    }

    const plan: DnsChangePlan = {
      changes: retryable.map((existing) => ({ action: 'delete', existing })),
      conflicts: [],
      desired: [],
      existing: records,
      zone: input.zone,
    }
    const result = await input.provider.applyChanges(input.zone, plan, { force: true })
    appliedChanges += result.applied.length
    const remaining = deadline - now()
    await wait(Math.min(input.intervalMs ?? 1000, Math.max(0, remaining)))
  }
}
