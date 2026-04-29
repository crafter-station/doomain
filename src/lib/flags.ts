import {Flags} from '@oclif/core'

export const jsonFlag = Flags.boolean({description: 'Output a single JSON object and never prompt.'})

export const providerFlag = Flags.string({description: 'DNS provider id. Inferred from the target domain when omitted.'})

export const domainFlag = Flags.string({description: 'Target domain or base zone, for example app.example.com or example.com.'})

export const subdomainFlag = Flags.string({description: 'Subdomain to add, for example app for app.example.com.'})

export const apexFlag = Flags.boolean({description: 'Use the root/apex domain instead of a subdomain.'})

export const projectFlag = Flags.string({
  char: 'p',
  description: 'Vercel project id/name. Inferred from env, config, .vercel/project.json, or package.json when omitted.',
})
