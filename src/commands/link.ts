import {Args, Command, Flags} from '@oclif/core'

import {apexFlag, domainFlag, jsonFlag, projectFlag, providerFlag, subdomainFlag} from '../lib/flags.js'
import {linkDomain} from '../lib/link-domain.js'
import {createOutput, outputError} from '../lib/output.js'

export default class Link extends Command {
  static description = 'Link a Vercel project to a domain and create DNS records.'

  static examples = [
    '<%= config.bin %> <%= command.id %> app.example.com --project my-app --json',
    '<%= config.bin %> <%= command.id %> --domain app.example.com --project my-app --json',
    '<%= config.bin %> <%= command.id %> --domain example.com --subdomain app --project my-app',
    '<%= config.bin %> <%= command.id %> --provider spaceship --domain example.com --apex --project my-app --json',
  ]

  static args = {
    domain: Args.string({description: 'Target domain to link, for example app.example.com.', required: false}),
  }

  static flags = {
    apex: apexFlag,
    domain: domainFlag,
    'dry-run': Flags.boolean({description: 'Preview changes without writing to Vercel or DNS.'}),
    force: Flags.boolean({description: 'Overwrite conflicting DNS records.'}),
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
      if (flags['dry-run']) {
        const result = await linkDomain({...flags, domain, dryRun: true, timeoutSeconds: flags.timeout})
        out.result(result)
        if (!out.json) out.success(`Dry run ready for ${result.domain}.`)
        return
      }

      out.intro('DMLink')
      spinner = out.spinner()
      spinner.start('Linking Vercel project and domain')
      const result = await linkDomain({
        ...flags,
        domain,
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
