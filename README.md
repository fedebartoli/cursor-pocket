# cursor-pocket

Follow and drive the **local** chats of Cursor's Agents Window from your iPhone. A tiny Node 22 daemon on your Mac plus an
installable web app (PWA). No dependencies, no build step, macOS only.

> Unofficial project, not affiliated with Anysphere. It relies on Cursor internals (a local SQLite database and the Agents Window UI)
> that can change without notice. Tested on Cursor 3.24.x. The app's interface is currently in Italian.

<p>
<img src="docs/screenshots/01-home.png" width="220" alt="List of chats that need attention">
<img src="docs/screenshots/02-question.png" width="220" alt="An agent question with answer options">
<img src="docs/screenshots/21-newchat.png" width="220" alt="New chat with branch and model choice">
<img src="docs/screenshots/16-history.png" width="220" alt="Full read-only conversation">
</p>

Screenshots come from the demo server (`npm run demo`, invented data).

## What it does

Works out of the box (read-only):

- Push notifications for a new agent question, a command waiting for approval, and a finished chat.
- Chats grouped by project in the same order as the Agents Window sidebar, with a red dot for "needs attention".
- "Ignore" (local to the daemon: nothing is sent to Cursor), favorites, per-chat and per-project mute, quiet hours, app badge.
- The whole conversation, read-only, in pages; paired-device management.

With Cursor started with a local debug port (`tools/cursor-cdp.sh`):

- Answer questions, approve or reject commands, send messages (with images), stop an agent.
- Start a new chat on a project, optionally choosing branch and model.
- Rename, pin and archive/restore chats.
- Keep the Mac awake while an agent works (optionally with the lid closed, through a narrow sudo rule).

## How it works

```
iPhone (PWA, Web Push)  --HTTPS (tailscale serve)-->  daemon on 127.0.0.1:8787
                                                         |-- reads Cursor's state.vscdb  (read-only, never written)
                                                         '-- drives the Agents Window    (Chrome DevTools Protocol, loopback only)
```

Everything that depends on Cursor internals lives in `daemon/src/cursor/`, so an update of Cursor means touching one place.
Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); what has been verified and what has not, in [docs/FINDINGS.md](docs/FINDINGS.md).

## Quick start

Requirements: macOS with Cursor 3.x, Node >= 22.13, Tailscale on the Mac and the iPhone, iOS >= 16.4 for push notifications.

Try it without touching your data:

```
cd daemon
npm run demo
```

Run it for real (full guide, including Tailscale and iPhone pairing, in [docs/SETUP.md](docs/SETUP.md)):

```
cd daemon
npm start                       # listens on 127.0.0.1:8787 only
npm run pair                    # prints a one-time pairing code
tailscale serve --bg 8787       # HTTPS inside your tailnet (never use Funnel)
tools/launchd.sh install        # optional: start at login
```

## Security in short

Answering from the phone means controlling an agent that can run shell commands on your Mac. The daemon listens on localhost only,
every device pairs with a one-time code and gets a revocable session, and the Cursor database is only ever opened read-only.
The debug port, while open, lets any local program control Cursor: enable it only if you need the actions. Read
[SECURITY.md](SECURITY.md) before exposing anything. **Never use `tailscale funnel`.**

## Status

In daily use on a real iPhone. Actions were verified live against a real Cursor (FINDINGS 10.x and 11.x); running a real command from
the phone is covered only by tests and by the reject path, which shares the same code. Still to verify on a physical iPhone: the newest
features (tab bar, stop, new chat, attachments, rename/pin/archive), push on a locked screen, notification tap, badge, long-term
stability. See [docs/IPHONE-CHECKLIST.md](docs/IPHONE-CHECKLIST.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

Tests: `cd daemon && npm test` (254 tests). Optional browser checks: `tools/ui-check.mjs` (about 140 checks, WebKit and Chromium).

## Repository layout

- `daemon/`   the daemon (read-only on Cursor's database) and its tests
- `pwa/`      the web app (plain HTML/CSS/JS, no build)
- `tools/`    icon generators, demo server, `launchd.sh`, `cursor-cdp.sh`, `ui-check.mjs`, macOS power helpers
- `docs/`     setup, architecture, findings, roadmap, iPhone checklist
- `research/` research scripts and prototypes

## License

MIT (see `LICENSE`). Icons come from Lucide (ISC, `pwa/icons/LICENSE-lucide.txt`). The Cursor logo in the app is a trademark of
Anysphere, kept in a replaceable file (see "Cursor logo" in [docs/SETUP.md](docs/SETUP.md)).
