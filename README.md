# DMLink

DMLink links a Vercel project to a domain from the terminal.

It handles the repetitive parts of shipping a custom domain: finding the right Vercel project, choosing a DNS zone, adding the domain to Vercel, creating the required DNS records, waiting for DNS propagation, and asking Vercel to verify the domain.

Use the interactive wizard when working by hand. Use `--json` when calling DMLink from scripts, CI, or agents.

## Features

- Interactive domain-linking wizard powered by Clack.
- Non-interactive JSON output for automation and agent workflows.
- Vercel project detection from `.vercel/project.json`.
- DNS provider inference by longest matching zone.
- Dry runs that preview Vercel and DNS changes before writing.
- DNS propagation and Vercel verification waiting.
- Built-in Spaceship, Namecheap, and Cloudflare providers.

## Install

```bash
npm install -g dmlink
```

DMLink requires Node.js 18 or newer.

## Quick Start

Run the wizard:

```bash
dmlink
```

The wizard prompts for missing credentials, lets you select a Vercel account/team from the token, detects the current Vercel project when possible, lets you connect a DNS provider, lists available domains, previews the changes, and then applies them.

For automation, pass everything explicitly and add `--json`:

```bash
dmlink link app.example.com --project my-app --json
```

## How It Works

1. Resolve the Vercel account/team, then resolve the project from `--project`, `.vercel/project.json`, or the interactive project selector.
2. Resolve the target domain from an argument, `--domain`, `--subdomain`, `--apex`, config, or environment variables.
3. Choose the DNS provider from `--provider` or infer it from configured DNS zones.
4. Add the domain to the Vercel project.
5. Read Vercel's recommended target and verification records.
6. Plan DNS changes against the current provider records.
7. Apply DNS changes unless `--dry-run` is set.
8. Wait for public DNS propagation and Vercel verification unless `--no-wait` is set.

## Linking Domains

Link a full domain:

```bash
dmlink link app.example.com --project my-app
```

Link a subdomain from a base zone:

```bash
dmlink link --domain example.com --subdomain app --project my-app
```

Link the apex/root domain:

```bash
dmlink link --domain example.com --apex --project my-app
```

Preview changes without writing to Vercel or DNS:

```bash
dmlink link --provider spaceship --domain example.com --apex --project my-app --dry-run --json
```

Skip the verification wait:

```bash
dmlink link app.example.com --project my-app --no-wait
```

Overwrite conflicting DNS records:

```bash
dmlink link app.example.com --project my-app --force
```

## JSON And Agent Usage

`--json` prints a single JSON object to stdout and never prompts. Use it for scripts, CI, or agent tools.

```bash
dmlink link app.example.com --project my-app --json
dmlink link --domain app.example.com --project my-app --json
dmlink link --domain example.com --subdomain app --project my-app --json
dmlink projects list --json
dmlink providers list --json
dmlink providers status --no-verify --json
dmlink schema --json
```

When `--provider` is omitted, DMLink searches configured DNS providers and selects the longest matching DNS zone for the target domain. If more than one provider has the same best match, DMLink asks you to pass `--provider` explicitly.

Use the schema command to inspect machine-readable command metadata:

```bash
dmlink schema
dmlink schema link --json
```

## Credentials

DMLink stores local configuration at:

```bash
~/.dmlink/config.json
```

The config file is written with `0600` permissions. Environment variables override values in the local config.

### Vercel

```bash
dmlink auth vercel --token vercel_token
```

Interactive mode fetches Vercel teams from the token and lets you choose a team or your personal account. Use `--team-id` or `VERCEL_TEAM_ID` for non-interactive team-scoped usage.

### Spaceship

```bash
dmlink providers connect spaceship \
  --credential apiKey=spaceship_key \
  --credential apiSecret=spaceship_secret
```

Compatibility aliases are also available:

```bash
dmlink providers connect spaceship --api-key spaceship_key --api-secret spaceship_secret
```

Spaceship API keys need domain read access and DNS record read/write access.

### Namecheap

```bash
dmlink providers connect namecheap \
  --credential apiUser=your_namecheap_user \
  --credential apiKey=your_api_key \
  --credential clientIp=your_whitelisted_ipv4
```

For Namecheap sandbox testing:

```bash
dmlink providers connect namecheap \
  --credential apiUser=your_sandbox_user \
  --credential apiKey=your_sandbox_key \
  --credential clientIp=your_whitelisted_ipv4 \
  --credential sandbox=true
```

Namecheap API access must be enabled, and `clientIp` must be whitelisted in Namecheap API Access settings.

### Cloudflare

```bash
dmlink providers connect cloudflare \
  --credential apiToken=your_cloudflare_api_token \
  --credential accountId=your_cloudflare_account_id
```

Cloudflare API tokens need `Zone:Read` and `DNS:Edit` permissions for the account. DMLink creates Vercel records as DNS-only records, not proxied records.

## Provider Management

List supported providers:

```bash
dmlink providers list
```

Interactively add a provider:

```bash
dmlink providers add
```

Check configured provider health:

```bash
dmlink providers status
dmlink providers status --no-verify --json
```

Disconnect a saved DNS provider:

```bash
dmlink providers disconnect namecheap
dmlink providers disconnect cloudflare --json
```

Remove saved Vercel credentials:

```bash
dmlink auth logout vercel
```

Logout commands remove credentials from `~/.dmlink/config.json`. If matching environment variables are still set, they continue to override local config.

Verify one provider's saved credentials:

```bash
dmlink providers verify spaceship
dmlink providers verify namecheap --json
```

List DNS zones and records:

```bash
dmlink domains list
dmlink domains list --provider cloudflare --domain example.com --json
```

## Environment Variables

```bash
VERCEL_TOKEN
VERCEL_TEAM_ID
SPACESHIP_API_KEY
SPACESHIP_API_SECRET
NAMECHEAP_API_USER
NAMECHEAP_API_KEY
NAMECHEAP_USERNAME
NAMECHEAP_CLIENT_IP
NAMECHEAP_SANDBOX
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
DMLINK_DOMAIN
DMLINK_PROVIDER
DMLINK_CONFIG_FILE
```

## Commands

```bash
dmlink                         # interactive wizard
dmlink link                    # link a Vercel project and domain
dmlink auth vercel             # save Vercel credentials
dmlink auth logout vercel      # remove saved Vercel credentials
dmlink providers list          # list supported DNS providers
dmlink providers add           # interactively add a DNS provider
dmlink providers connect       # save provider credentials
dmlink providers disconnect    # remove saved provider credentials
dmlink providers status        # show configured provider health
dmlink providers verify        # verify provider credentials
dmlink domains list            # list DNS zones and records
dmlink projects list           # list Vercel projects
dmlink verify                  # ask Vercel to verify a domain
dmlink schema                  # print command schemas for agents
```

Run `dmlink help <command>` for command-specific flags and examples.

## Provider Notes

Spaceship, Namecheap, and Cloudflare are implemented through a shared DNS provider contract. Each provider declares its credentials and capabilities, then implements zone listing, record listing, change planning, and change application behind the same interface.

Namecheap writes DNS through `setHosts`, which replaces the full host list. DMLink reads all existing records first, applies the planned change in memory, preserves unrelated records, then submits the complete final record set.

Cloudflare supports proxied records generally, but DMLink writes Vercel `A`, `AAAA`, and `CNAME` records with `proxied: false` so Vercel can validate them correctly.

## Development

```bash
bun install
bun run build
bun run test
```

Useful scripts:

```bash
bun run lint
bun run prepack
```

The package is an oclif CLI. Source lives in `src/commands` and `src/lib`; compiled output is written to `dist`.
