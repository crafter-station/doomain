import {Command} from '@oclif/core'

import {apexFlag, domainFlag, jsonFlag, projectFlag, subdomainFlag} from '../lib/flags.js'
import {detectLocalVercelProject} from '../lib/local-vercel.js'
import {createOutput, outputError} from '../lib/output.js'
import {resolveDomainTarget} from '../lib/validate.js'
import {createVercelClient, resolveVercelConfig} from '../lib/vercel.js'

export default class Verify extends Command {
  static description = 'Ask Vercel to verify a project domain.'

  static flags = {
    apex: apexFlag,
    domain: domainFlag,
    json: jsonFlag,
    project: projectFlag,
    subdomain: subdomainFlag,
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Verify)
    const out = createOutput({json: flags.json})

    try {
      if (!flags.domain) throw new Error('Missing --domain.')
      const target = resolveDomainTarget({domain: flags.domain, subdomain: flags.subdomain, apex: flags.apex})
      const project = flags.project ?? detectLocalVercelProject()?.projectId
      if (!project) throw new Error('Missing --project and no local .vercel/project.json was found.')
      const vercel = createVercelClient(await resolveVercelConfig())
      const result = await vercel.verifyProjectDomain(project, target.fullDomain)
      out.result({project, domain: target.fullDomain, vercel: result})
      out.success(`Verification requested for ${target.fullDomain}.`)
    } catch (error) {
      outputError(out.json, error, 'DOMAIN_VERIFY_FAILED')
      this.exit(1)
    }
  }
}
