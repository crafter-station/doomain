import * as p from '@clack/prompts'
import { Args, Command, Flags } from '@oclif/core'

import { type AddClerkDomainResult, addClerkProductionDomain } from '../../../lib/clerk-domain.js'
import { accountFlag, jsonFlag, providerFlag } from '../../../lib/flags.js'
import type { DnsOverrideWarning } from '../../../lib/link-domain.js'
import { createOutput, outputError } from '../../../lib/output.js'

function recordLine(record: { name: string; proxied?: boolean; type: string; value: string }): string {
  return `${record.type} ${record.name} -> ${record.value}${record.proxied === undefined ? '' : ` (proxied ${record.proxied})`}`
}

function conflictNote(warning: DnsOverrideWarning): string {
  return [
    'Existing:',
    ...warning.conflicts.map((conflict) => `- ${recordLine(conflict.existing)}`),
    '',
    'Required by Clerk:',
    ...warning.desired.map((record) => `- ${recordLine(record)}`),
  ].join('\n')
}

function resultMessage(result: AddClerkDomainResult): string {
  if (result.clerk.verified) return `${result.domain} is configured and verified for Clerk production.`
  return `${result.domain} is configured for Clerk production. Run ${result.nextSteps.at(-1)} to check provisioning.`
}

export default class ClerkDomainsAdd extends Command {
  static description = 'Create a Clerk production instance with its primary domain and configure DNS.'

  static examples = [
    '<%= config.bin %> <%= command.id %> example.com --app app_123 --json',
    '<%= config.bin %> <%= command.id %> example.com --app app_123 --provider cloudflare --no-wait',
    '<%= config.bin %> <%= command.id %> example.com --app app_123 --dry-run --json',
  ]

  static args = {
    domain: Args.string({ description: 'Production primary domain, for example example.com.', required: true }),
  }

  static flags = {
    account: accountFlag,
    app: Flags.string({ description: 'Clerk application id. Defaults to CLERK_APPLICATION_ID or saved Clerk config.' }),
    'dry-run': Flags.boolean({
      description: 'Check the Clerk application and DNS zone without creating the production instance.',
    }),
    force: Flags.boolean({ description: 'Overwrite DNS records that conflict with Clerk requirements.' }),
    json: jsonFlag,
    provider: providerFlag,
    timeout: Flags.integer({ default: 300, description: 'Wait timeout in seconds.' }),
    wait: Flags.boolean({
      allowNo: true,
      default: true,
      description: 'Wait for Clerk DNS, SSL, and email DNS verification.',
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClerkDomainsAdd)
    const out = createOutput({ json: flags.json })
    let spinner: ReturnType<typeof out.spinner> | undefined

    try {
      if (!out.json && !flags['dry-run']) {
        p.note(
          `This creates the first production instance for Clerk application ${flags.app ?? 'the configured app'} and sets ${args.domain} as its primary domain. Existing production instances are never modified.`,
          'Clerk production setup',
        )
        const confirmed = await p.confirm({ message: 'Create the Clerk production instance?', initialValue: false })
        if (confirmed !== true) {
          p.cancel('Cancelled')
          return
        }
      }

      spinner = out.spinner()
      spinner.start(flags['dry-run'] ? 'Checking Clerk production setup' : 'Creating Clerk production setup')
      const result = await addClerkProductionDomain({
        account: flags.account,
        app: flags.app,
        confirmDnsOverride: out.json
          ? undefined
          : async (warning) => {
              spinner?.stop('DNS conflict found')
              p.note(conflictNote(warning), 'DNS records point elsewhere')
              const confirmed = await p.confirm({ message: 'Overwrite these DNS records?', initialValue: false })
              if (confirmed === true) spinner?.start('Continuing Clerk production setup')
              return confirmed === true
            },
        domain: args.domain,
        dryRun: flags['dry-run'],
        force: flags.force,
        progress: out.json ? undefined : (message) => spinner?.message(message),
        provider: flags.provider,
        timeoutSeconds: flags.timeout,
        wait: flags.wait,
      })

      spinner.stop(flags['dry-run'] ? 'Clerk production setup is available' : 'Clerk production domain configured')
      out.result(result)
      if (!out.json) {
        p.note(result.nextSteps.map((step) => `- ${step}`).join('\n'), 'Next steps')
        out.outro(flags['dry-run'] ? `Ready to create Clerk production for ${result.domain}.` : resultMessage(result))
      }
    } catch (error) {
      spinner?.error('Clerk production setup failed')
      outputError(out.json, error, 'DOMAIN_LINK_FAILED')
      this.exit(1)
    }
  }
}
