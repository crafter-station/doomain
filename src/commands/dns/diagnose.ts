import { Args, Command, Flags } from '@oclif/core'
import { diagnoseDns } from '../../lib/diagnose-dns.js'
import { runDoomainEffect } from '../../lib/effect.js'
import { accountFlag, jsonFlag, providerFlag } from '../../lib/flags.js'
import { createOutput, outputError } from '../../lib/output.js'

export default class DnsDiagnose extends Command {
  static description = 'Compare DNS provider records with system and public resolver answers.'

  static examples = [
    '<%= config.bin %> <%= command.id %> example.com --json',
    '<%= config.bin %> <%= command.id %> app.example.com --type A --target 203.0.113.10 --json',
  ]

  static args = {
    domain: Args.string({ description: 'Fully qualified DNS name to diagnose.', required: true }),
  }

  static flags = {
    account: accountFlag,
    json: jsonFlag,
    provider: providerFlag,
    target: Flags.string({ description: 'Expected IP address or canonical hostname.' }),
    type: Flags.string({ description: 'Record type to compare.', options: ['A', 'AAAA', 'CNAME'] }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DnsDiagnose)
    const out = createOutput({ json: flags.json })
    const spinner = out.json ? undefined : out.spinner()
    try {
      spinner?.start(`Diagnosing ${args.domain}`)
      const result = await runDoomainEffect(
        diagnoseDns({
          account: flags.account,
          domain: args.domain,
          provider: flags.provider,
          recordType: flags.type as 'A' | 'AAAA' | 'CNAME' | undefined,
          target: flags.target,
        }),
      )
      spinner?.stop('DNS diagnosis complete')
      out.result(result)
      out.info(`Provider: ${result.provider}/${result.account} (${result.zoneDomain})`)
      out.info(`Status: ${result.status}`)
      for (const observation of result.observations) {
        const answers = observation.answers.map(
          (answer) => `${answer.value}${answer.ttl == null ? '' : ` (TTL ${answer.ttl}s)`}`,
        )
        out.info(`${observation.resolver}: ${answers.join(', ') || observation.error || 'no answer'}`)
      }
    } catch (error) {
      spinner?.error('DNS diagnosis failed')
      outputError(out.json, error, 'DNS_DIAGNOSE_FAILED')
      this.exit(1)
    }
  }
}
