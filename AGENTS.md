# AGENTS.md

## Commands
- Use Bun here: `package.json` declares `packageManager: bun@1.3.13` and CI runs `bun install --frozen-lockfile`.
- Install: `bun install --frozen-lockfile`.
- Full local verification matching CI: `bun run build` then `bun run test`; `test` runs Mocha and then `posttest` runs `bun run lint`.
- Focused test file: `bunx mocha --forbid-only "test/path/to-file.test.ts"`.
- Lint/format are Biome, not ESLint/Prettier: `bun run lint`, `bun run check`, `bun run format`.
- Build deletes and recreates `dist` with `tsc -b`; do not edit `dist` directly.
- Run the CLI in development with `./bin/dev.js ...`; installed/runtime entry is `./bin/run.js`.

## Structure
- This is a single TypeScript ESM oclif CLI package; source entrypoints are `src/commands/**` and shared logic is in `src/lib/**`.
- `bin/run.js` routes bare `doomain` and `doomain --json` to hidden `wizard`; JSON/agent flows should use explicit commands such as `link --json`.
- oclif command discovery points at compiled `dist/commands`, so command changes usually need `bun run build` before testing packaged behavior through `bin/run.js`.
- `examples/**` is excluded by Biome and is a separate example project; do not treat it as part of this package's build or lint surface.

## CLI And Output Contracts
- Machine-readable commands should emit exactly one JSON object through `createOutput({json})`; non-JSON mode uses Clack prompts/spinners.
- `shouldUseJson` also enables JSON when stdout is not a TTY, so tests or piped runs may be JSON even without `--json`.
- `doomain schema --json` is the in-repo command contract for agent-safe commands; update `src/lib/command-schema.ts` when adding or changing public command flags/examples.
- Local config defaults to `~/.doomain/config.json`, but tests isolate it with `DOOMAIN_CONFIG_FILE`; use that env var for any test touching credentials.

## Provider Rules
- Providers are registered only in `src/lib/providers/registry.ts`; adding a provider requires adding its definition there.
- All DNS providers implement the shared contract in `src/lib/providers/core/types.ts` via `listZones`, `listRecords`, `planChanges`, and `applyChanges`.
- `linkDomain` infers the DNS provider by listing configured providers and choosing the longest matching zone; equal-length matches across providers are an error unless `--provider` is passed.
- Cloudflare Vercel `A`/`AAAA`/`CNAME` records must be written with `proxied: false` so Vercel validation works.
- Namecheap `setHosts` replaces the whole host list; preserve unrelated records by planning from existing records and submitting the full final set.
- DNS conflict behavior lives in `src/lib/providers/core/planner.ts`: TXT can coexist at the same name, same-type conflicts require `--force`, and CNAME slot conflicts delete/create only with `--force`.

## Release/Generated Files
- `prepack` runs `oclif manifest && oclif readme`, generating `oclif.manifest.json` and updating README command docs.
- `oclif.manifest.json` and `dist/` are ignored build artifacts; README changes from `oclif readme` are source changes.
- Every push to `main` (other than the bot's own `[skip ci]` version-bump commit) bumps the patch version via `npm version patch`, runs `build` and `prepack`, publishes to npm, then pushes the tag and creates the matching GitHub release.
