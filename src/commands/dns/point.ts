import * as p from '@clack/prompts'
import { Args, Command, Flags } from '@oclif/core'

import { accountFlag, jsonFlag, providerFlag } from '../../lib/flags.js'
import type { DnsOverrideWarning } from '../../lib/link-domain.js'
import { createOutput, outputError } from '../../lib/output.js'
import { type PointDomainResult, type PointRecordType, pointDomain } from '../../lib/point-domain.js'

function preview(result: PointDomainResult): string {
  return [
    `Domain: ${result.domain}`,
    `DNS provider: ${result.provider}/${result.account} (${result.zoneDomain})`,
    `Record: ${result.record.type} ${result.record.name} -> ${result.record.value}`,
  ].join('\n')
}

function conflictNote(warning: DnsOverrideWarning): string {
  return [
    `${warning.domain} already points somewhere else.`,
    '',
    'Existing:',
    ...warning.conflicts.map(
      (conflict) => `- ${conflict.existing.type} ${conflict.existing.name} -> ${conflict.existing.value}`,
    ),
    '',
    'Desired:',
    ...warning.desired.map((record) => `- ${record.type} ${record.name} -> ${record.value}`),
  ].join('\n')
}

function successMessages(result: PointDomainResult, waited: boolean): { outro: string; spinner: string } {
  if (result.propagated) {
    return {
      outro: result.updated
        ? `${result.domain} now points to ${result.record.value}.`
        : `${result.domain} already points to ${result.record.value}.`,
      spinner: 'DNS record is live',
    }
  }

  if (!waited) {
    return {
      outro: result.updated
        ? `${result.domain} was updated; propagation was not checked.`
        : `${result.domain} was already configured; propagation was not checked.`,
      spinner: result.updated ? 'DNS record saved; propagation not checked' : 'DNS record already configured',
    }
  }

  return {
    outro: result.updated
      ? `${result.domain} was updated; propagation is still pending.`
      : `${result.domain} was already configured; public DNS does not match yet.`,
    spinner: result.updated ? 'DNS record saved' : 'DNS record already configured',
  }
}

export default class DnsPoint extends Command {
  static description = 'Point a DNS name at an IP address or canonical hostname.'

  static examples = [
    '<%= config.bin %> <%= command.id %> app.example.com --target 203.0.113.10 --json',
    '<%= config.bin %> <%= command.id %> app.example.com --target origin.example.net --dry-run --json',
    '<%= config.bin %> <%= command.id %> example.com --target 203.0.113.10 --provider spaceship --account work --force --json',
  ]

  static args = {
    domain: Args.string({ description: 'Fully qualified domain to point.', required: true }),
  }

  static flags = {
    account: accountFlag,
    'dry-run': Flags.boolean({ description: 'Preview the DNS record without writing it.' }),
    force: Flags.boolean({ description: 'Overwrite conflicting DNS records.' }),
    json: jsonFlag,
    provider: providerFlag,
    target: Flags.string({ description: 'IPv4, IPv6, or hostname target.', required: true }),
    timeout: Flags.integer({ default: 300, description: 'DNS propagation wait timeout in seconds.' }),
    ttl: Flags.integer({ default: 300, description: 'DNS record TTL in seconds.' }),
    type: Flags.string({
      description: 'Record type. Inferred from the target when omitted.',
      options: ['A', 'AAAA', 'CNAME'],
    }),
    wait: Flags.boolean({ allowNo: true, default: true, description: 'Wait for public DNS propagation.' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DnsPoint)
    const out = createOutput({ json: flags.json })
    let spinner: ReturnType<typeof out.spinner> | undefined

    try {
      if (!flags['dry-run']) {
        out.intro('Doomain')
        spinner = out.spinner()
        spinner.start(`Pointing ${args.domain}`)
      }

      const result = await pointDomain({
        account: flags.account,
        confirmDnsOverride: out.json
          ? undefined
          : async (warning) => {
              spinner?.stop('Existing DNS target found')
              p.note(conflictNote(warning), 'DNS already points elsewhere')
              const confirmed = await p.confirm({ message: `Override DNS for ${warning.domain}?`, initialValue: false })
              if (confirmed === true) spinner?.start(`Pointing ${warning.domain}`)
              return confirmed === true
            },
        domain: args.domain,
        dryRun: flags['dry-run'],
        force: flags.force,
        progress: out.json ? undefined : (message) => spinner?.message(message),
        provider: flags.provider,
        recordType: flags.type as PointRecordType | undefined,
        target: flags.target,
        timeoutSeconds: flags.timeout,
        ttl: flags.ttl,
        wait: flags.wait,
      })

      if (flags['dry-run']) {
        out.result(result)
        if (!out.json) p.note(preview(result), 'Dry run')
        return
      }

      const messages = successMessages(result, flags.wait)
      spinner?.stop(messages.spinner)
      out.result(result)
      out.outro(messages.outro)
    } catch (error) {
      spinner?.error('DNS update failed')
      outputError(out.json, error, 'DNS_POINT_FAILED')
      this.exit(1)
    }
  }
}
