# Roadmap

## Phase 0 - Quick checks (before writing code)
Results in `docs/FINDINGS.md`, section 8.
- [x] Semantics of `hasBlockingPendingActions` and `hasUnreadMessages` (bundle code + data: the flag stays on until
  answered and Cursor leaves it on even for requests that are no longer resolvable).
  - [x] VERIFIED LIVE trace of the flag with a real question (`research/phase0_sampler.py` sampler): flag on together with the
    bubble; the bubble goes from `loading` to `completed`/`pending` after 5-33 s and the question stays pending for hours. The first
    interpretation (8.1: "19 headers out of 20 were stale") was wrong: see FINDINGS 9.1.
- [x] Values of `agentLocation` (local vs cloud): `null` | `local` | `worktree`; no cloud agent in the local database.
- [x] Where Cursor saves workspace ORDER in the sidebar: `ItemTable`, key `cursor/glassSidebarSettings`.
  - [x] Visual comparison with the real sidebar (user screenshot, Oct 12): same order and same sizes of the 7 groups,
    classic chats appear. Discovered that the sidebar hides chats from REMOVED projects (`glass.removedProjects`):
    9 chats vs the 35 from the previous filter (FINDINGS 8.2, 8.3).
- [x] Workspace mapping: 35/35 coverage with `agentLocation`, `workspaceIdentifier.uri`, `workspace.json`.
- [x] "Chat finished": signals identified (`unfinishedRunAt` on the header, Cursor's definition of completed turn).
  - [x] VERIFIED LIVE observation of the end of 3 runs: the composer goes to `completed` immediately, the header follows with delay (FINDINGS 9.1).
  - [ ] Observe a run stopped manually or failed (the daemon today notifies "finished" in that case too).
  - [ ] Test of the `stop` hook (requires touching `~/.cursor/hooks.json`: confirm and backup). With the signals from 9.1 it might
    not be needed.
- [x] Tool approvals ("Allow"/"Run", including those requested by a hook): notification and panel in the PWA, from the signal
  `additionalData.reviewData.status === "Requested"` found in the database and bundle (FINDINGS 11). The hypothesis "`loading`
  without `userDecision`" remains disproved (68 false notifications in 28 minutes, FINDINGS 9.1). Notification after 8 s of continuous wait
  (`CP_APPROVAL_DELAY_SECONDS`), action type only.
  - [ ] Try it with a real approval: the log must show `approval_seen` during the wait and after 8 s `push_sent
    kind=approvazione` (FINDINGS 11.4: NOT VERIFIED that the database contains `Requested` WHILE waiting).
  - [x] Approve/reject from the phone (terminal commands only, two taps; FINDINGS 11.5). Reject VERIFIED LIVE, "Esegui" (Run) not.

## Phase 1 - Daemon + read-only PWA with push
- [x] `daemon/`: read-only DB read, data model, watcher with events, SSE (automated tests: `cd daemon && npm test`).
- [x] Own store: ignored, push subscriptions, sessions, pairing codes, notified (deduplication).
- [x] Web Push (VAPID) with only `node:crypto`, deduplication, "new question" and "chat finished" notifications.
  Verified with test vectors (RFC 8291 encryption, VAPID signature), with a simulated push service and, on Oct 12, with Apple
  (`web.push.apple.com`): the test push arrived on the iPhone.
- [x] `pwa/`: home with "Richiedono attenzione" (Need attention) / "In sospeso" (Pending) / workspace, chat detail, "Ignora" (Ignore) button (local only), manifest,
  service worker. Verified in browser at 390 px (light and dark theme) on the real daemon with synthetic data (`npm run demo`).
- [x] Authentication (one-time code + session) and setup guide (`docs/SETUP.md`).
- [x] `tailscale serve --bg 8787` run on Oct 12 with user consent, after they enabled HTTPS certificates
  in the panel (`CertDomains` from 0 to 1). Verified from Mac: `(tailnet only)`, valid certificate, `/api/state` without session
  responds 401 via HTTPS; reachable from iPhone.
- [x] Real iPhone (Oct 12): Home installation, pairing, notification permission, test push received.
  - [ ] Still to verify: push with PWA closed and screen locked, tap opening the chat, badge on icon, real
    "question" and "chat finished" notifications, retention over days (session and subscription).
- [x] Visual comparison of workspace order with the real sidebar (`npm run probe -- --names`, Oct 12).
- [x] Automatic daemon startup with launchd (Oct 12, at user request): `tools/launchd.sh install|restart|status|
  uninstall`. Verified: the service starts, keeps iPhone session and push subscription, restarts on its own after `kill -9`
  (about 1 s). NOT VERIFIED: startup after Mac reboot or new login.
- [x] Chats from projects removed from the sidebar excluded (FINDINGS 8.2).
- [x] Delayed question notification (up to 60 s): cause found (Cursor writes the header every 60 s, FINDINGS 9.7) and fixed
  by reading all chats and the recent-question rule.
  - [x] Latency: user reports the notification now "seems immediate" (Oct 12). No measurement in seconds was taken.
- [x] Chat in progress with stale flag on: "In corso" instead of "Richiedono attenzione".
- [x] Question in the PWA: read-only list with the "Altro" entry (remains as fallback when actions are not active;
  answering is Phase 2).
- [ ] Handle `removedSectionIds` if a real case emerges.

## Phase 2 - Actions (requires Cursor started with `--remote-debugging-port=9222`)
Written and tested on simulators; from Oct 13 also tested on real Cursor (FINDINGS 10.6): single/multiple/"Altro"/two
questions and free message work, confirmed from the database. Remaining: "Skip", message to a chat that is actually working,
click with Cursor in the background, interface from the PWA on iPhone.
- [x] CDP client (`cursor/cdp.js`): loopback only, validated WebSocket URLs, errors and timeouts; tests with fake WebSocket and with
  real server.
- [x] `cursor/agents-ui.js`: isolated selectors derived from bundle (FINDINGS 10.1), questionnaire (single, multiple, "Altro",
  multiple steps), "Skip", message, restore previously open chat; tested on real Chromium with a test page.
- [x] Actions service (`actions.js`): serial queue, validation against database, deduplication, database verification
  (`submitted`, bubble, composer queue), `answer` / `skip` / `message` endpoints, `status.actions` state, `npm run cdp` CLI.
- [x] PWA: interactive questionnaire, message composer, outcomes, "Rispondere dal telefono" panel in "Impostazioni" (Settings).
- [x] Safari/iOS: block double-tap only (pinch free), 16 px fields, safe margins, composer above
  keyboard, Cursor logo top left. Verified in WebKit and Chromium (`tools/ui-check.mjs`, 138-140 checks, light
  and dark theme).
- [x] Recent activity in chat (agent steps, "waiting" state after a reply) with refresh every 1.5-4 s with screen open and re-read every second after an action (FINDINGS 10.4c).
- [x] `tools/cursor-cdp.sh`: starts Cursor with debug port (only when Cursor is closed) and shows its status.
- [x] (done Oct 13, outcomes in FINDINGS 10.6 and 11.4; list below kept as resume procedure) Restart Cursor with debug port and VERIFIED LIVE validate
  FINDINGS 10.5 points. First test: have the daemon answer a real question.
  Resume after restart (whoever opens a new chat starts here): user quits Cursor with Cmd+Q, then from a terminal
  outside Cursor runs `tools/cursor-cdp.sh` from the project folder.
  1. `cd daemon && npm run cdp -- status` (port and Agents window), then `npm run cdp -- inspect` (page structure,
     no text): compare with FINDINGS 10.1 and fix `SEL` in `cursor/agents-ui.js` if it differs.
  2. With a real question open in a chat: `npm run cdp -- tray` (options, free field, buttons).
  3. Full test: have the agent ask a question with `ask_question`, answer from the PWA and check that the database
     reports `submitted` with the chosen selection (`verified: true`); repeat with multiple choice, "Altro" and two questions.
  4. Message to an idle chat and one that is working (queue or interruption?).
  5. Update FINDINGS 10.5 (from [NOT VERIFIED] to real outcome), fix selectors and rerun `npm test`.
  6. Real approval (FINDINGS 11.4): in a project with a hook that asks for approval, trigger a command and
     leave it waiting beyond 8 s. In the log (`rg 'approval_|approvazione' ~/Library/Logs/cursor-pocket/daemon.log`) there must
     appear `approval_seen`, then `push_sent kind=approvazione` (with `detectMs` and `sendMs`) and, on decision,
     `approval_gone`. If the chat waits but the log is silent, the signal is not written during the wait: update 11.4.
- [ ] Handle dead questions after Cursor restart (today 409 `no_question`; evaluate fallback to new message).
- [ ] Test on real iPhone: no zoom on double tap, composer above keyboard, full-screen PWA.
- [ ] Permanent Cursor launcher with the flag (app or Quick Command): only with user consent.
- [x] App icon on Home screen and favicon with Cursor logo (user choice, Oct 12): `tools/make-icons.mjs`
  derives it from `pwa/icons/cursor-logo.svg`. On Home it will show only after removing and re-adding the app (iOS caches the old
  icon).

## Phase 3 - Polish and publication
- [x] Publication hardening (Oct 15): file and history scan (no personal data), author email rewritten with GitHub noreply (backup in `~/.cursor-pocket-backup/`), `SECURITY.md`, CI, `docs/IPHONE-CHECKLIST.md`.
- [ ] Handling Cursor updates (selectors): discovered only by trying after each update.
- [x] README with screenshots, MIT license, installation guide, security warnings.
- [x] Code, comments, tests and docs in English; app and push notifications in 8 languages (en, it, es, fr, de, pt, ja, zh), catalogs
  checked by tests. [ ] Native-speaker review of es/fr/de/pt/ja/zh (machine-generated).
- [ ] Create GitHub repository (user chose to wait).
- [x] No personal data in examples; Cursor database opened read-only only (test).

## Deferred ideas
- Live Activity / native app (requires paid Developer account).
- ntfy as alternative notification channel.
- Live view of running chats.

## Done after Phase 2 (Oct 15, outcomes in FINDINGS 10.4a-10.4m)
- [x] 4-item bar, "Preferite" (Favorites), mute chat/projects and schedules, paired devices, badge, "Ferma" (Stop) agent, full conversation,
  keep Mac awake (levels and brightness).
- [x] "Rinomina" (Rename), "Archivia" (Archive) and "Ripristina" (Restore) chat (Cursor row menu via CDP; VERIFIED LIVE).
- [x] Attach images to messages (controlled upload, `DOM.setFileInputFiles`; VERIFIED LIVE).
- [x] "Nuova chat" (New chat) local from phone on a project, with text and images (VERIFIED LIVE with a real message).
- [x] "Fissa" (Pin) / "Togli" (Unpin) chat from phone (VERIFIED LIVE).
- [ ] To try on iPhone: all items new in this list (so far verified in WebKit/Chromium and on real Cursor via CDP).
- [x] Branch and model choice for new chat (VERIFIED LIVE without sending; real send not verified).
- [ ] Ideas still open: start chat on a project with no local chats (not verifiable: daemon knows projects from chats).
