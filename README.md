# Doomain

Doomain links a Vercel project to a custom domain from your terminal.

It handles the boring parts of custom-domain setup: selecting the Vercel project, finding the right DNS zone, adding the domain to Vercel, writing the Vercel DNS records, waiting for public DNS propagation, and asking Vercel to verify the domain.

Use the interactive wizard when working by hand. Use explicit commands with `--json` for scripts, CI, or agents.

## Features

- Interactive Vercel domain-linking wizard.
- Script-friendly commands with one JSON object on stdout.
- Vercel project detection from `.vercel/project.json`.
- DNS provider inference by longest matching configured zone.
- Dry-run plans before writing changes.
- Safety checks before replacing DNS records that point elsewhere.
- DNS propagation and Vercel verification wait loop.
- DNS provider support for Spaceship, Namecheap, Cloudflare, and Hostinger.

## Install

```bash
npm install -g doomain
```

Doomain requires Node.js 18 or newer.

## Quick Start

Run the wizard:

```bash
doomain
```

The wizard will:

1. Ask for a Vercel token if one is not already configured.
2. Let you choose a Vercel personal account or team.
3. Detect and preselect a local Vercel project when `.vercel/project.json` exists.
4. Connect a DNS provider if none is configured.
5. List domains from configured DNS providers.
6. Preview the Vercel and DNS changes.
7. Warn if the current DNS target points elsewhere and ask before overriding it.
8. Apply the changes and request Vercel verification.

If you already know the target project and domain, run the link command directly:

```bash
doomain link app.example.com --project my-vercel-project
```

## Scripted Setup

For CI, shell scripts, and agents, use explicit commands and `--json`.

First save Vercel credentials:

```bash
doomain auth vercel \
  --token "$VERCEL_TOKEN" \
  --team-id "$VERCEL_TEAM_ID" \
  --json
```

`--team-id` is optional for personal-account usage.

Then connect one DNS provider:

```bash
doomain providers connect cloudflare \
  --credential apiToken="$CLOUDFLARE_API_TOKEN" \
  --credential accountId="$CLOUDFLARE_ACCOUNT_ID" \
  --json
```

Preview the domain link:

```bash
doomain link app.example.com --project my-vercel-project --dry-run --json
```

Apply it:

```bash
doomain link app.example.com --project my-vercel-project --json
```

If JSON mode returns `DNS_TARGET_CONFLICT`, the current DNS target appears to point to another project or site. Re-run with `--force` only when you intend to replace that DNS target.

## Provider Setup

Doomain stores local credentials in `~/.doomain/config.json` with `0600` file permissions. Environment variables override saved config values.

| Provider | Provider ID | Required credentials | Environment variables | Notes |
| --- | --- | --- | --- | --- |
| Spaceship | `spaceship` | `apiKey`, `apiSecret` | `SPACESHIP_API_KEY`, `SPACESHIP_API_SECRET` | API key needs domain read access and DNS record read/write access. |
| Namecheap | `namecheap` | `apiUser`, `apiKey`, `clientIp` | `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IP` | API access must be enabled and `clientIp` must be your whitelisted public IPv4. Optional: `username`, `sandbox`. |
| Cloudflare | `cloudflare` | `apiToken`, `accountId` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | API token needs `Zone:Read` and `DNS:Edit`. Vercel records are written as DNS-only records, not proxied. |
| Hostinger | `hostinger` | `apiToken` | `HOSTINGER_API_TOKEN` | API token needs access to domain portfolio and DNS zone records. |

### Spaceship

```bash
doomain providers connect spaceship \
  --credential apiKey=spaceship_key \
  --credential apiSecret=spaceship_secret
```

Compatibility aliases are also available:

```bash
doomain providers connect spaceship --api-key spaceship_key --api-secret spaceship_secret
```

### Namecheap

```bash
doomain providers connect namecheap \
  --credential apiUser=your_namecheap_user \
  --credential apiKey=your_api_key \
  --credential clientIp=your_whitelisted_ipv4
```

For Namecheap sandbox testing:

```bash
doomain providers connect namecheap \
  --credential apiUser=your_sandbox_user \
  --credential apiKey=your_sandbox_key \
  --credential clientIp=your_whitelisted_ipv4 \
  --credential sandbox=true
```

`NAMECHEAP_USERNAME` is optional. If omitted, Doomain uses `apiUser` as the Namecheap username.

### Cloudflare

```bash
doomain providers connect cloudflare \
  --credential apiToken=your_cloudflare_api_token \
  --credential accountId=your_cloudflare_account_id
```

Cloudflare records created for Vercel `A`, `AAAA`, and `CNAME` targets are set to `proxied: false` so Vercel can validate the domain.

### Hostinger

```bash
doomain providers connect hostinger \
  --credential apiToken=your_hostinger_api_token
```

Create Hostinger API tokens from hPanel Account > API. Doomain lists active zones from the Hostinger domain portfolio and updates records through the DNS zone API.

## Linking Domains

You can pass the full target domain as a positional argument:

```bash
doomain link app.example.com --project my-app
```

Or pass a base domain and subdomain:

```bash
doomain link --domain example.com --subdomain app --project my-app
```

Link the apex/root domain:

```bash
doomain link --domain example.com --apex --project my-app
```

An exact zone match without `--subdomain` is also treated as apex:

```bash
doomain link example.com --project my-app
```

Preview without writing to Vercel or DNS:

```bash
doomain link app.example.com --project my-app --dry-run --json
```

Skip the DNS/Vercel verification wait:

```bash
doomain link app.example.com --project my-app --no-wait
```

Change the wait timeout, in seconds:

```bash
doomain link app.example.com --project my-app --timeout 600
```

Use a specific DNS provider instead of provider inference:

```bash
doomain link app.example.com --project my-app --provider cloudflare
```

Use `-p` as shorthand for `--project`:

```bash
doomain link app.example.com -p my-app
```

## What Gets Created

For apex/root domains, Doomain creates Vercel's apex `A` record:

```text
A @ 76.76.21.21
```

For subdomains, Doomain creates a `CNAME` to Vercel's recommended target. If Vercel does not return a special target, it uses:

```text
CNAME app cname.vercel-dns.com
```

During real linking, Doomain also reads Vercel's domain response and adds any required TXT verification records, for example:

```text
TXT _vercel vc-domain-verify=app.example.com,...
```

## Project Detection

`--project` accepts a Vercel project id or name. If you omit it, Doomain searches upward from the current directory for `.vercel/project.json` and uses its `projectId`.

The interactive wizard also uses `.vercel/project.json`, but only preselects the local project when the detected `orgId` matches the selected Vercel account or team.

## Provider And Zone Inference

When `--provider` is omitted, Doomain lists zones from every configured provider and chooses the longest zone that matches the target domain.

Example: for `api.dev.example.com`, a provider zone named `dev.example.com` wins over `example.com`.

If two providers have the same best matching zone, Doomain stops with `PROVIDER_ZONE_AMBIGUOUS`. Re-run with `--provider` to choose one:

```bash
doomain link app.example.com --project my-app --provider cloudflare
```

## Safety, Dry Runs, And Conflicts

Use `--dry-run` before applying changes:

```bash
doomain link app.example.com --project my-app --dry-run --json
```

Dry runs do not write to Vercel or DNS. They resolve the target project, provider, zone, and base Vercel DNS record. They do not add the domain to Vercel, fetch Vercel TXT verification records, or inspect current DNS records for conflicts.

DNS conflict rules:

- Existing exact records are skipped.
- TXT records can coexist at the same name.
- Same-name, same-type conflicts trigger an interactive override prompt or require `--force` in JSON/non-interactive mode.
- CNAME slot conflicts trigger an interactive override prompt or require `--force` in JSON/non-interactive mode because a CNAME cannot share a name with most other record types.

For real links, Doomain inspects the target `A` or `CNAME` DNS slot before adding the domain to Vercel. In interactive mode, it shows the existing and desired records and asks whether to override. In JSON mode, it fails with `DNS_TARGET_CONFLICT` instead of prompting.

Use `--force` only when you intend to replace conflicting DNS records or move an existing Vercel alias:

```bash
doomain link app.example.com --project my-app --force
```

`--force` can remove an existing Vercel alias from another project and add it to the target project.

Confirming the interactive DNS override only forces DNS writes. If Vercel says the domain is already assigned to another project, re-run with `--force` to move that Vercel alias.

Namecheap note: Namecheap's API writes DNS through `setHosts`, which replaces the full host list. Doomain reads all existing records first, applies planned changes in memory, preserves unrelated records, then submits the complete final record set.

## JSON And Agent Usage

Use `--json` for automation. JSON mode never prompts and writes exactly one JSON object to stdout.

Successful commands use this shape:

```json
{"ok":true,"data":{}}
```

Failed commands use this shape:

```json
{"ok":false,"error":{"code":"MISSING_ARGUMENT","message":"Domain is required."}}
```

JSON mode is also enabled automatically when stdout is not a TTY, which makes piped commands script-safe.

Use explicit commands for agents. The bare `doomain` command is interactive, and `doomain --json` returns an error that points agents to `doomain link --json`.

Useful agent-safe commands:

```bash
doomain link app.example.com --project my-app --json
doomain providers list --json
doomain providers status --no-verify --json
doomain domains list --provider cloudflare --domain example.com --json
doomain projects list --search my-app --json
doomain schema --json
doomain schema link --json
```

The schema command prints machine-readable metadata for the documented command contracts:

```bash
doomain schema --json
doomain schema "providers connect" --json
```

## Command Reference

Run `doomain help <command>` for oclif-generated help.

### `doomain`

Starts the interactive wizard.

```bash
doomain
```

### `doomain link [domain]`

Links a Vercel project to a domain and creates DNS records.

Common flags:

- `--domain <domain>`: target domain or base zone.
- `--subdomain <name>`: subdomain under `--domain`.
- `--apex`: use the root/apex domain.
- `-p, --project <project>`: Vercel project id or name.
- `--provider <id>`: DNS provider id.
- `--dry-run`: preview without writing.
- `--force`: overwrite DNS conflicts without prompting and allow Vercel alias moves.
- `--wait`, `--no-wait`: wait for DNS and Vercel verification. Default is `--wait`.
- `--timeout <seconds>`: wait timeout. Default is `300`.
- `--json`: output one JSON object.

Examples:

```bash
doomain link app.example.com --project my-app
doomain link --domain example.com --subdomain app --project my-app
doomain link --domain example.com --apex --project my-app
doomain link app.example.com --project my-app --dry-run --json
doomain link app.example.com --project my-app --force
```

### `doomain auth vercel`

Saves Vercel credentials locally.

```bash
doomain auth vercel --token vercel_token
doomain auth vercel --token vercel_token --team-id team_123 --json
```

### `doomain auth logout vercel`

Removes saved Vercel credentials from the local config file.

```bash
doomain auth logout vercel
doomain auth logout vercel --json
```

If `VERCEL_TOKEN` or `VERCEL_TEAM_ID` are still set, they continue to override local config.

### `doomain providers list`

Lists supported DNS providers.

```bash
doomain providers list
doomain providers list --json
```

### `doomain providers connect [provider]`

Saves DNS provider credentials locally.

```bash
doomain providers connect cloudflare -c apiToken=token -c accountId=account_id
doomain providers connect namecheap -c apiUser=user -c apiKey=key -c clientIp=127.0.0.1 --json
doomain providers connect hostinger -c apiToken=token --json
doomain providers connect spaceship --api-key key --api-secret secret
```

Common flags:

- `-c, --credential key=value`: provider credential. Can be repeated.
- `--api-key <key>`: Spaceship compatibility alias for `apiKey`.
- `--api-secret <secret>`: Spaceship compatibility alias for `apiSecret`.
- `--no-verify`: save credentials without calling the provider API first.
- `--json`: output one JSON object.

### `doomain providers add [provider]`

Alias for `providers connect`.

```bash
doomain providers add cloudflare
```

### `doomain providers status`

Shows configured provider health.

```bash
doomain providers status
doomain providers status --no-verify --json
```

### `doomain providers verify <provider>`

Verifies saved provider credentials.

```bash
doomain providers verify cloudflare
doomain providers verify namecheap --json
```

### `doomain providers disconnect <provider>`

Removes saved DNS provider credentials locally. `providers logout` is an alias.

```bash
doomain providers disconnect cloudflare
doomain providers logout namecheap --json
```

Environment variables for that provider still override local config after disconnect.

### `doomain domains list`

Lists DNS zones and records.

```bash
doomain domains list --provider cloudflare
doomain domains list --provider cloudflare --domain example.com --json
```

If `--provider` is omitted, this command uses `DOOMAIN_PROVIDER`, then the saved default provider, then `spaceship`.

### `doomain projects list`

Lists Vercel projects for the configured Vercel account or team.

```bash
doomain projects list
doomain projects list --search my-app --json
```

### `doomain verify`

Asks Vercel to verify a project domain without changing DNS.

```bash
doomain verify --domain example.com --subdomain app --project my-app
doomain verify --domain example.com --apex --project my-app --json
```

For `verify`, pass a base domain plus `--subdomain`, or pass a base domain plus `--apex`.

### `doomain schema [command]`

Prints machine-readable command metadata.

```bash
doomain schema --json
doomain schema link --json
doomain schema "providers connect" --json
```

## Environment Variables

Vercel:

```bash
VERCEL_TOKEN
VERCEL_TEAM_ID
```

Spaceship:

```bash
SPACESHIP_API_KEY
SPACESHIP_API_SECRET
```

Namecheap:

```bash
NAMECHEAP_API_USER
NAMECHEAP_API_KEY
NAMECHEAP_USERNAME
NAMECHEAP_CLIENT_IP
NAMECHEAP_SANDBOX
```

Cloudflare:

```bash
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Hostinger:

```bash
HOSTINGER_API_TOKEN
```

Doomain defaults and config:

```bash
DOOMAIN_DOMAIN
DOOMAIN_PROVIDER
DOOMAIN_CONFIG_DIR
DOOMAIN_CONFIG_FILE
DOOMAIN_DEBUG
```

Notes:

- `DOOMAIN_DOMAIN` is used by the interactive wizard and internal link planning, but the `doomain link` command currently still requires a positional domain or `--domain` before it calls the linker.
- `DOOMAIN_PROVIDER` is used by the interactive wizard and `domains list`. For `link`, pass `--provider` when you want to force a specific provider.
- Set `DOOMAIN_DEBUG=1` to enable provider debug mode where supported.
- Use `DOOMAIN_CONFIG_FILE` in tests or scripts when you want isolated credentials.

## Troubleshooting

`Missing Vercel token`

Run `doomain auth vercel` or set `VERCEL_TOKEN`.

`No DNS provider is configured`

Run `doomain providers connect <provider>` or set the provider's required environment variables.

`PROVIDER_ZONE_NOT_FOUND`

The selected provider does not have a DNS zone matching the target domain. Check `doomain domains list --provider <provider>` or pass the correct `--provider`.

`PROVIDER_ZONE_AMBIGUOUS`

More than one configured provider has the same best matching zone. Re-run with `--provider cloudflare`, `--provider namecheap`, `--provider spaceship`, or `--provider hostinger`.

Namecheap authentication or permission errors

Make sure Namecheap API access is enabled and your current public IPv4 is whitelisted in Namecheap API Access settings.

Cloudflare permission errors

Make sure the API token has `Zone:Read` and `DNS:Edit` permissions for the account that owns the zones.

Hostinger authentication errors

Make sure the API token is active and can access the domains you want Doomain to manage.

Hostinger DNS zone not found

Make sure the domain is active in Hostinger before linking it. Domains shown as `pending_setup` in Hostinger's portfolio API are not writable through the DNS zone API yet.

DNS propagation timeout

The DNS records may have been saved even if Vercel verification timed out. Check the domain in Vercel, inspect records with `doomain domains list`, or re-run verification with `doomain verify`.

DNS target conflict

The domain already has a conflicting `A` or `CNAME` record, which usually means it points to another project or site. In interactive mode, confirm the override only if you intend to replace that target. In JSON mode, re-run `doomain link` with `--force` to overwrite DNS.

Domain already assigned to another Vercel project

If you intend to move it, re-run `doomain link` with `--force`. This can remove the alias from the previous Vercel project.

SSL certificate is not ready yet

Vercel may need a few extra minutes to provision SSL after the domain verifies.

## Development

This repository is a TypeScript ESM oclif CLI package.

```bash
bun install --frozen-lockfile
bun run build
bun run test
```

Useful commands:

```bash
bun run lint
bun run check
bun run format
bunx mocha --forbid-only "test/path/to-file.test.ts"
./bin/dev.js link app.example.com --project my-app --dry-run
```

Notes for contributors:

- Source commands live in `src/commands/**`.
- Shared logic lives in `src/lib/**`.
- Build output goes to `dist/`; do not edit `dist` directly.
- `examples/**` is excluded from this package's Biome surface.
- Public command contract metadata lives in `src/lib/command-schema.ts`.
- `prepack` runs `oclif manifest && oclif readme`, which may update generated README command docs.

## License

MIT
