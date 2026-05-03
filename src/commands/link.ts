import {Args, Command, Flags} from '@oclif/core'
import * as p from '@clack/prompts'

import {DoomainError} from '../lib/errors.js'
import {accountFlag, apexFlag, domainFlag, jsonFlag, projectFlag, providerFlag, subdomainFlag} from '../lib/flags.js'
import {linkDomain, type DnsOverrideWarning} from '../lib/link-domain.js'
import {createOutput, outputError} from '../lib/output.js'

function recordName(name: string): string {
  return name === '@' ? 'root' : name
}

function recordLine(record: {name: string; priority?: number; proxied?: boolean; ttl?: number; type: string; value: string}): string {
  const details = [
    record.priority === undefined ? undefined : `priority ${record.priority}`,
    record.proxied === undefined ? undefined : `proxied ${record.proxied}`,
    record.ttl === undefined ? undefined : `ttl ${record.ttl}`,
  ].filter(Boolean)

  return `${record.type} ${recordName(record.name)} -> ${record.value}${details.length > 0 ? ` (${details.join(', ')})` : ''}`
}

function dnsOverrideNote(warning: DnsOverrideWarning): string {
  const account = warning.account === 'default' ? warning.providerName : `${warning.providerName}/${warning.account}`
  return [
    `${warning.domain} already has DNS records in ${account} (${warning.zoneDomain}) that do not match the Vercel target.`,
    '',
    'Existing:',
    ...warning.conflicts.map((conflict) => `- ${recordLine(conflict.existing)}`),
    '',
    'Desired:',
    ...warning.desired.map((record) => `- ${recordLine(record)}`),
  ].join('\n')
}

export default class Link extends Command {
  static description = 'Link a Vercel project to a domain and create DNS records.'

  static examples = [
    '<%= config.bin %> <%= command.id %> app.example.com --json',
    '<%= config.bin %> <%= command.id %> app.example.com --project my-app --json',
    '<%= config.bin %> <%= command.id %> --domain app.example.com --project my-app --json',
    '<%= config.bin %> <%= command.id %> --domain example.com --subdomain app --project my-app',
    '<%= config.bin %> <%= command.id %> --provider spaceship --domain example.com --apex --project my-app --json',
    '<%= config.bin %> <%= command.id %> app.example.com --provider spaceship --account work --project my-app --json',
  ]

  static args = {
    domain: Args.string({description: 'Target domain to link, for example app.example.com.', required: false}),
  }

  static flags = {
    account: accountFlag,
    apex: apexFlag,
    domain: domainFlag,
    'dry-run': Flags.boolean({description: 'Preview changes without writing to Vercel or DNS.'}),
    force: Flags.boolean({description: 'Move existing Vercel project domains and overwrite conflicting DNS records.'}),
    json: jsonFlag,
    project: projectFlag,
    provider: providerFlag,
    subdomain: subdomainFlag,
    timeout: Flags.integer({default: 300, description: 'Wait timeout in seconds.'}),
    wait: Flags.boolean({allowNo: true, default: true, description: 'Wait for DNS propagation and Vercel verification.'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Link)
    const out = createOutput({json: flags.json})
    let spinner: ReturnType<typeof out.spinner> | undefined
    const domain = flags.domain ?? args.domain

    try {
      if (!domain) {
        throw new DoomainError('MISSING_ARGUMENT', 'Domain is required. Use `doomain link <domain>` or pass --domain.')
      }

      if (flags['dry-run']) {
        const result = await linkDomain({...flags, domain, dryRun: true, timeoutSeconds: flags.timeout})
        out.result(result)
        if (!out.json) out.success(`Dry run ready for ${result.domain}.`)
        return
      }

      out.intro('Doomain')
      spinner = out.spinner()
      spinner.start('Linking Vercel project and domain')
      const result = await linkDomain({
        ...flags,
        domain,
        confirmDnsOverride: out.json
          ? undefined
          : async (warning) => {
              spinner?.stop('Existing DNS target found')
              p.note(dnsOverrideNote(warning), 'DNS already points elsewhere')
              const confirmed = await p.confirm({
                message: `Override existing DNS records for ${warning.domain}?`,
                initialValue: false,
              })
              if (confirmed === true) {
                spinner?.start('Continuing domain link')
                return true
              }

              spinner = undefined
              return false
            },
        dryRun: false,
        progress: out.json ? undefined : ({message}) => spinner?.message(message),
        timeoutSeconds: flags.timeout,
      })
      spinner.stop(result.vercel.verified ? 'Domain linked and verified' : 'Domain linked')

      out.result(result)
      out.outro(
        result.vercel.verified
          ? `${result.domain} is linked to ${result.project}. SSL certificate provisioning may take a few minutes in Vercel.`
          : `${result.domain} is linked to ${result.project}.`,
      )
    } catch (error) {
      spinner?.error('Domain link failed')
      outputError(out.json, error, 'DOMAIN_LINK_FAILED')
      this.exit(1)
    }
  }
}
