# Security

**English.** cursor-pocket lets a phone drive agents that can run shell commands on your Mac. Treat it like remote access to your
machine. Report vulnerabilities privately (GitHub “Report a vulnerability” on the repository, not a public issue).

## What protects what

- The daemon listens only on `127.0.0.1`. The only intended way to reach it is `tailscale serve` (HTTPS within your tailnet).
  **Never use `tailscale funnel`**: it exposes the Mac to the Internet and leaves public DNS names even after you turn it off
  (see `docs/SETUP.md`).
- Each device pairs with a one-time code shown on the Mac (`npm run pair`) and receives its own session, revocable from
  Settings (“Paired devices”). Without a session the API returns 401. Requests that change data also verify the origin (no requests from other sites).
- The Cursor database is always opened read-only (`mode=ro`) and is never written to.
- Chats, keys, and tokens are not written to logs. Daemon data lives in `daemon/data/` (permissions 0700, ignored by git).

## Accepted risks (good to know)

- Actions go through the Cursor interface via the debug port (CDP). As long as the port is open, **any local program
  running as the user** can control Cursor. The port is loopback-only; enable it only if you need actions.
- Whoever obtains a valid session can respond to requests, **approve command execution**, and write to agents.
  Protect your iPhone (passcode, Face ID) and disconnect lost devices.
- “Keep Mac awake with lid closed” uses a limited, passwordless `sudo` rule (`tools/mac/power-setup.sh`): read it before
  installing; remove it with `uninstall`.
- The project depends on Cursor internals that may change: after a Cursor update check `docs/FINDINGS.md`.

## Reporting

Use GitHub's private feature (“Security” > “Report a vulnerability”). Do not publish chats, keys, or real screenshots in issues.
