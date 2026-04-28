import {Command, Flags} from '@oclif/core'
import * as p from '@clack/prompts'

import {getConfigPath, maskSecret, updateConfig} from '../../lib/config.js'
import {jsonFlag} from '../../lib/flags.js'
import {createOutput, outputError} from '../../lib/output.js'
import {createVercelClient, type VercelTeam} from '../../lib/vercel.js'

const PERSONAL_ACCOUNT = '__personal__'

function assertValue(value: unknown, message: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(message)
}

function teamLabel(team: VercelTeam): string {
  const name = team.name ?? team.slug
  return `${name} (${team.id})`
}

export default class AuthVercel extends Command {
  static description = 'Save Vercel credentials locally.'

  static flags = {
    json: jsonFlag,
    'team-id': Flags.string({description: 'Vercel team id. Interactive mode can fetch and select this from your token.'}),
    token: Flags.string({description: 'Vercel API token.'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(AuthVercel)
    const out = createOutput({json: flags.json})

    try {
      let token = flags.token
      let teamId = flags['team-id']

      if (!out.json && !token) {
        const value = await p.password({message: 'Vercel token'})
        if (p.isCancel(value)) {
          p.cancel('Cancelled')
          return
        }

        token = value
      }

      token = assertValue(token, 'Missing Vercel token. Pass --token or set VERCEL_TOKEN.')

      if (!out.json && teamId === undefined) {
        const spinner = p.spinner()
        spinner.start('Loading Vercel teams')
        const teams = await createVercelClient({token}).listTeams()
        spinner.stop(`Loaded ${teams.length} Vercel team${teams.length === 1 ? '' : 's'}`)

        const selected = await p.select({
          message: 'Select Vercel account/team',
          options: [
            {label: 'Personal account', value: PERSONAL_ACCOUNT, hint: 'No team id'},
            ...teams.map((team) => ({label: teamLabel(team), value: team.id, hint: team.role ?? team.slug})),
          ],
        })

        if (p.isCancel(selected)) {
          p.cancel('Cancelled')
          return
        }

        teamId = selected === PERSONAL_ACCOUNT ? undefined : selected
      }

      await updateConfig((config) => ({
        ...config,
        vercel: {token, teamId},
      }))

      out.result({configPath: getConfigPath(), vercel: {token: maskSecret(token), teamId}})
      out.success(`Vercel credentials saved to ${getConfigPath()}.`)
    } catch (error) {
      outputError(out.json, error, 'MISSING_CREDENTIALS')
      this.exit(1)
    }
  }
}
