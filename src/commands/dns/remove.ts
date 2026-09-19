import * as p from '@clack/prompts'
import { Args, Command, Flags } from '@oclif/core'
import { runDoomainEffect } from '../../lib/effect.js'
import { accountFlag, jsonFlag, providerFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'
import type { DnsRecord, DnsRecordType } from '../../lib/providers/types.js'
import { removeDomain } from '../../lib/remove-domain.js'

function recordLines(records: DnsRecord[]): string {
  return records.map((record) => `- ${record.type} ${record.name} -> ${record.value}`).join('\n')
}

export default class DnsRemove extends Command {
  static description = 'Safely remove exact DNS records and verify their absence.'

  static examples = [
    '<%= config.bin %> <%= command.id %> app.example.com --type A --value 203.0.113.10 --dry-run --json',
    '<%= config.bin %> <%= command.id %> app.example.com --type A --all-matching --json',
  ]

  static args = {
    domain: Args.string({ description: 'Fully qualified DNS name whose record should be removed.', required: true }),
  }

  static flags = {
    account: accountFlag,
    'all-matching': Flags.boolean({
      description: 'Delete every record matching the name and type (and value, if set).',
    }),
    'dry-run': Flags.boolean({ description: 'Preview the exact records without deleting them.' }),
    json: jsonFlag,
    provider: providerFlag,
    type: Flags.string({
      description: 'DNS record type to remove.',
      options: ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
      required: true,
    }),
    value: Flags.string({ description: 'Expected record value. Required unless --all-matching is passed.' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DnsRemove)
    const out = createOutput({ json: flags.json })
    const spinner = flags['dry-run'] || out.json ? undefined : out.spinner()

    try {
      spinner?.start(`Inspecting ${args.domain}`)
      const result = await runDoomainEffect(
        removeDomain({
          account: flags.account,
          allMatching: flags['all-matching'],
          confirmMultiple: out.json
            ? undefined
            : async (records) => {
                spinner?.stop('Multiple matching records found')
                p.note(recordLines(records), 'Records selected for deletion')
                const confirmed = await p.confirm({
                  initialValue: false,
                  message: `Delete all ${records.length} matching records?`,
                })
                if (confirmed === true) spinner?.start(`Deleting records from ${args.domain}`)
                return confirmed === true
              },
          domain: args.domain,
          dryRun: flags['dry-run'],
          progress: out.json ? undefined : (message) => spinner?.message(message),
          provider: flags.provider,
          recordType: flags.type as DnsRecordType,
          value: flags.value,
        }),
      )

      spinner?.stop(result.removed === 0 ? 'No matching records found' : 'DNS records removed')
      out.result(result)
      if (flags['dry-run'] && !out.json) p.note(recordLines(result.matched) || 'No matching records.', 'Dry run')
      else
        out.outro(
          result.removed === 0
            ? `No matching DNS record exists for ${result.domain}.`
            : `Removed ${result.removed} DNS record${result.removed === 1 ? '' : 's'} from ${result.domain}.`,
        )
    } catch (error) {
      spinner?.error('DNS removal failed')
      outputError(out.json, error, 'DNS_REMOVE_FAILED')
      this.exit(1)
    }
  }
}
