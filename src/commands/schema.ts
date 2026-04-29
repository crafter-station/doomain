import {Args, Command} from '@oclif/core'

import {getCommandSchemaForAgents} from '../lib/command-schema.js'
import {jsonFlag} from '../lib/flags.js'
import {createOutput, outputError} from '../lib/output.js'

export default class Schema extends Command {
  static args = {
    command: Args.string({description: 'Command name to inspect, for example link.', required: false}),
  }

  static description = 'Print machine-readable command schemas for agents.'

  static flags = {
    json: jsonFlag,
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Schema)
    const out = createOutput({json: flags.json})

    try {
      const schema = await getCommandSchemaForAgents(args.command)
      if (!schema) throw new Error(`Unknown command schema: ${args.command}`)
      if (!out.json) out.info(JSON.stringify(schema, null, 2))
      out.result(schema)
    } catch (error) {
      outputError(out.json, error, 'INVALID_INPUT')
      this.exit(1)
    }
  }
}
