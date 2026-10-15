# Contributing

Thanks for looking. Pull requests, bug reports and translation fixes are welcome.

## Before you start

- Read `AGENTS.md` (the working rules), then `docs/ARCHITECTURE.md`. `docs/FINDINGS.md` explains what was verified and how.
- Node 22.13 or newer. The daemon has no dependencies and no build step: please keep it that way.
- Everything that depends on Cursor internals belongs in `daemon/src/cursor/`.

## Rules that are not negotiable

- Cursor's database is only ever opened read-only.
- Never log chat contents, API keys or tokens, and never print raw `ps` output (some Cursor processes carry a key in their arguments).
- The daemon listens on localhost only, and nothing in the project should suggest `tailscale funnel`.
- User-visible text lives in the catalogs (`pwa/js/i18n/locales/*.js`, `daemon/src/i18n-messages.js`), never inline. English is the
  source: add a key to `en.js` first, then to every other locale (the tests tell you what is missing).
- No emojis in the interface (SVG icons only) and a sober look: no glow, no gradients.
- Code, comments, tests, logs and docs are in English.

## Checks

```sh
cd daemon && npm test                 # must pass
cd daemon && npm run doctor           # read-only health check of your setup; paste its output in bug reports
node tools/ui-check.mjs webkit        # optional, needs playwright-core (PLAYWRIGHT_CORE=/path/to/index.mjs)
```

If you change what the app looks like, regenerate the screenshots with `node tools/readme-shots.mjs`.

## Translations

The six non-English, non-Italian catalogs are machine-translated. If you read one of those languages natively, fixing the wording
is the most useful contribution. Keep placeholders such as `{count}` untouched and keep labels short: the bottom bar is narrow.

## Bug reports

Use the issue templates. The most useful report has the output of `npm run doctor` and your Cursor version: the daemon depends
on Cursor's interface, so most breakages come from a Cursor update.

## Security issues

Do not open a public issue: see `SECURITY.md`.
