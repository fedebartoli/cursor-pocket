# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com), and the project uses
[Semantic Versioning](https://semver.org) while it is below 1.0: minor versions may change behavior.

## [Unreleased]

### Added
- Compatibility check with Cursor. A moved field inside Cursor's database used to stop detection without any error (no red dot,
  no push). The daemon now checks, every few minutes and read-only, that column names and JSON field types of a few recent chats
  are what it reads (never content). When they are not, the home screen shows a banner, Settings says so, `/api/info` and
  `npm run doctor` list the reason codes.
- Phone actions pause themselves after three consecutive "Cursor's interface changed" failures: the app stays read-only and says
  why, instead of clicking at things that are not there. They resume when the page check passes again or Cursor restarts; after
  resuming, one more failure pauses them again. `CP_UI_PAUSE_FAILURES=0` turns this off.
- The installed Cursor release is read automatically (Settings shows it, with "not tested yet" for a release outside the tested
  list). It is only a notice: nothing is disabled because of a version.

## [0.1.0] - 2026-10-15

First tagged version, prepared for a public release.

### Added
- Read-only mode: chats grouped by project in the order of the Agents Window sidebar, "needs attention" dot, local "Ignore",
  favorites, mute and quiet hours, the whole conversation page by page, paired devices with revocation.
- Push notifications (Web Push) for a new question, a command waiting for approval and a finished chat, in the language of
  each device. App icon badge with the number of pending decisions.
- Actions through Cursor's debug port: answer questions, approve or reject commands, send messages (with images), stop an
  agent, start a chat (choosing branch and model), rename, pin, archive and restore.
- Safety of actions: the chat must really be open before typing, a draft written on the Mac is never overwritten, text typed by
  the daemon is removed after a failure, the sidebar is opened (and closed again) automatically.
- Keep the Mac awake while an agent works, optionally with the lid closed.
- Eight languages: English, Italian, Spanish, French, German, Portuguese, Japanese, Simplified Chinese. Six are machine-translated.
- `npm run doctor`: read-only health check of Node, Cursor version, database, daemon, debug port, page elements and Tailscale.
- Demo server (`npm run demo`) with invented data, README screenshots and animation generators, a static project page in `site/`.
- 286 tests, browser checks for WebKit and Chromium, GitHub Actions.

### Notes
- Verified against Cursor 3.24.x and 3.25.x (on 3.25.6 approving a command and answering a question were not re-checked live). Newer releases may work; run `npm run doctor` and report what it says.
- Unofficial: not affiliated with Anysphere.
