# AGENTS.md - cursor-pocket

Project: control the LOCAL chats of Cursor 3.x's Agents Window from an iPhone (PWA), on macOS.

## Read first
1. `docs/FINDINGS.md` - everything that was verified (and how, and what was not)
2. `docs/ARCHITECTURE.md` - the architecture
3. `docs/ROADMAP.md` - phases and next steps

## Working rules
- Code, comments, tests, logs and documentation are in English. User-visible text lives only in the catalogs
  (`pwa/js/i18n/locales/*.js`, `daemon/src/i18n-messages.js`); English is the source and the fallback, and every locale must keep
  the same keys and placeholders (`cd daemon && npm test` checks it). Never call `t()` at module top level.
- No emojis in the interface: SVG icons only. Sober UI: no glow, no gradients, no purple/indigo palette.
- Ask before changing the user's own configuration (`~/.cursor/*`, Cursor settings) and make a backup first.
- Do not restart Cursor without asking (it interrupts running chats).

## Technical constraints
- Minimal dependencies. Node 22 (built-in `node:sqlite`, no native modules). Python 3.11 only for research scripts.
- Cursor's database (`state.vscdb`, ~17 GB) is ALWAYS opened read-only (`mode=ro`) and never scanned in full: query by `composerId`.
  Never write to it.
- Never log API keys, tokens or chat contents. The command line of some Cursor processes (`ps`) contains an API key in clear text:
  never print raw `ps` output.
- The daemon listens on localhost only; exposure is through `tailscale serve` (HTTPS), never `tailscale funnel`. Authentication is mandatory.
- Everything that depends on Cursor internals lives in `daemon/src/cursor/`, so it can be updated when Cursor changes.

## Functional requirements
- Only local chats (not cloud, not archived, not sub-agents).
- Group by workspace/repo, in the same order as the Agents Window sidebar.
- "Needs attention": a chat with a pending question or blocking action; red dot as in Cursor.
- "Ignore" is local to the daemon: it removes the dot, sends nothing to Cursor and does not change the chat. Key:
  (composerId, toolCallId); a NEW question brings the dot back.
- Push notifications: new question, command approval, chat finished. No repeated reminders by default.
- Actions: answer a pending question (even hours or days later) and send new messages to a chat.
- A live view is not needed.

## Status
See `docs/ROADMAP.md`.
