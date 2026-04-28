import {Command, Flags} from '@oclif/core'

import {jsonFlag} from '../../lib/flags.js'
import {createOutput, outputError} from '../../lib/output.js'
import {createVercelClient, resolveVercelConfig} from '../../lib/vercel.js'

export default class ProjectsList extends Command {
  static description = 'List Vercel projects.'

  static flags = {
    json: jsonFlag,
    search: Flags.string({description: 'Filter projects by search term.'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ProjectsList)
    const out = createOutput({json: flags.json})

    try {
      const vercel = createVercelClient(await resolveVercelConfig())
      const projects = await vercel.listProjects(flags.search)
      for (const project of projects) out.info(`${project.name} (${project.id})`)
      out.result({projects})
    } catch (error) {
      outputError(out.json, error, 'PROJECT_NOT_FOUND')
      this.exit(1)
    }
  }
}
