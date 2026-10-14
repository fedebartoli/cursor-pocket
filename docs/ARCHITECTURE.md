# Architecture

```
iPhone (PWA in Home, Web Push)
        |  HTTPS (tailscale serve) + authentication
        v
Node 22 daemon on the Mac  (listens on 127.0.0.1 only, no dependencies)
  cursor/   [the ONLY place that knows Cursor's internals]
    db.js         read-only access to state.vscdb (headers, composerData tail, bubbles, sidebar settings)
    model.js      visible chats, "running", pending requests (question / leftover / plan)
    questions.js  ask_question params -> questions and options
    workspaces.js chat -> folder/workspace and sidebar section id
    sidebar.js    group order and collapsed state, as in the Agents Window
    hash.js       VS Code hash for section ids
    cdp.js        minimal CDP client (Node WebSocket, loopback only) to 127.0.0.1:9222
    agents-ui.js  Agents Window selectors and page scripts: open a chat, questionnaire, Skip, message, and so on
  actions.js      action service (queue, validation, dedup, verification against the database, `actions` status)
  watcher.js      ~1 s polling -> snapshot + events (new question, chat finished)
  state/
    present.js    model -> PWA payload (pure, deterministic function)
    store.js      own state (SQLite): ignored, push subscriptions, sessions, codes, VAPID keys, notified
  push/
    webpush.js    Web Push with node:crypto only (RFC 8291 encryption, RFC 8292 VAPID)
    notifier.js   message composition, dedup, delivery with retries
  auth.js         one-time pairing codes, sessions, cookies
  http/           server (REST API + SSE + static files), SSE hub, security (Host/Origin/CSP), static assets
  cli.js          npm run pair | status | probe | cdp
pwa/              vanilla HTML/CSS/JS (ES modules, no build step), service worker, manifest
tools/            vendor-icons.mjs, make-icons.mjs, demo-server.mjs (fake Cursor), launchd.sh, cursor-cdp.sh,
                  ui-check.mjs (optional browser check: WebKit and Chromium)
research/         research scripts and prototypes (not used in production)
docs/
```

## Data model exposed to the PWA (`GET /api/state`)
```
{ version, state, status }
state  = { counts:{attention,pending,running,total}, attention:[Card], pending:[Card],
           workspaces:[{ id, name, home, collapsed, lastUpdatedAt, counts, chats:[Card] }] }
Card   = { id, name, subtitle, sectionId, workspaceName, state, running, unread, mode, lastUpdatedAt,
           attention: { kind, key, live, since, approvalAction?, reason, title, prompt } | null }
state  = running | attention | pending | done | idle
status = { ok, error: 'db' | null, actions: 'ok' | 'off' | 'no_window' | 'disabled' }
         (deliberately stable: no timestamps, so it does not trigger useless pushes)
```
Detail (`GET /api/chats/:id`) adds `lastMessage` (text of the agent's last message) and `question`
(title, questions, options) when the request is a question. `GET /api/info` also reports action status and the
expected debug port (for "Impostazioni" (Settings)).

## Derivation rules
- Chat list: non-archived `composerHeaders`, not a subagent, not a draft, `lastUpdatedAt > 0`; `agentLocation` null
  (classic chat, optional), `local`, or `worktree`. Chats from projects REMOVED from the sidebar are excluded
  (`ItemTable`, `cursor/glass.removedProjects`, match on `workspaceIdentifier.id`; re-read every 10 s): without this rule
  the app showed 35 chats versus 9 in the Agents Window (FINDINGS 8.2).
- Grouping by workspace in the same order as the sidebar (`cursor/glassSidebarSettings`). Default order (or when
  `sortGroupsBy` is not `manual`): descending last activity. With manual order: sections not in the saved order first
  (in default order), then the filtered saved order. The algorithm is derived from Cursor's bundle and
  confirmed visually with the user's sidebar screenshot (FINDINGS 8.3). Known limit: `removedSectionIds` is not
  handled (no case in real data).
- "Richiede attenzione" (Require attention) = like Cursor's dot: `hasBlockingPendingActions` or `hasPendingPlan`. The flag alone does not say
  what kind of request it is, so classification uses the last bubble:
  - `question`: last `ask_question` bubble with no answer, i.e. `loading` (first seconds) or `completed` with
    `additionalData.status: "pending"` (turn finished, question waiting for hours), with the flag on OR created less than
    120 s ago (Cursor's header arrives late, up to 60 s: FINDINGS 9.7); key = `toolCallId`; actionable in phase 2;
  - `approval`: the last or second-to-last bubble is a tool (not `ask_question` or `create_plan`) with
    `additionalData.reviewData.status === "Requested"`, as Cursor itself looks for; key = `toolCallId`. Live if the flag is
    on, or the chat is working, or the bubble is recent (less than 120 s); otherwise it is a leftover and does not count.
    Notified only after `CP_APPROVAL_DELAY_SECONDS` of continuous waiting, with only the action TYPE. Not actionable from the PWA
    (FINDINGS 11);
  - `plan`: pending plan only;
  - `leftover`: flag on but the last bubble is not an open question (question already answered or superseded by other messages,
    or chat working with the flag still on); key = last tool or last bubble.
  - A tool WITHOUT `reviewData` is never a request: a running tool looks the same as an approval request based on
    `loading` and lack of `userDecision` (hypothesis disproved live, FINDINGS 9.1). Only `question` and
    `approval` are "live" and generate notifications; everything else is display-only.
- A chat that is WORKING (`running`) with a leftover or plan does not need you: state `running`, outside
  "Richiedono attenzione" (Cursor still shows the dot while the agent works). During the run only one
  live request counts (question or approval). When the run ends the leftover becomes visible again and can be ignored.
- "In sospeso" (Pending) = ignored requests (`reason: ignored`) or older than `CP_PENDING_AFTER_HOURS` (`reason: old`).
  The dot and "Richiedono attenzione" count do not include them.
- "Ignora" (Ignore): writes only to the daemon store, key `(chatId, key)`. No interaction with Cursor. With a new request
  the key changes and the dot reappears. The API responds 409 `stale` if the submitted key is no longer that of the current
  request: only what the user actually saw is ignored.
- "In corso" (Running) = the header has `unfinishedRunAt` more recent than `CP_STALE_RUN_HOURS` AND the composer state is not `completed`
  (the composer signals run end immediately, the header up to 30 s late: FINDINGS 9.1).
- "Chat finita" (event) = was running, then stopped for `CP_DONE_SETTLE_MS`, with no live requests, no open question as
  last bubble (a run that ends with a question waits for the user: not finished), no queued messages, and work of at least
  `CP_MIN_RUN_SECONDS` (work already in progress at daemon startup counts as long).
- ALL visible chats are re-read (composer tail and last bubble) every `CP_FULL_SCAN_MS` even when the header is unchanged:
  Cursor writes the header in bursts, every 60 s or on certain events, and after the composer; a new question or run end may
  therefore not change it for tens of seconds. Re-read costs 0.5–3 ms per chat (FINDINGS 9.7), so there is no need to limit it
  to "hot" chats. Typical delay for a question notification: a few seconds.

## Execution
- `npm start` to try; for daily use a user LaunchAgent (`tools/launchd.sh install`): starts at login with
  the real node path, is restarted by launchd after an error (not after a clean stop), writes the log to
  `~/Library/Logs/cursor-pocket/daemon.log`. Does not require administrator and does not touch Cursor or Tailscale. HTTPS exposure
  (`tailscale serve`) is Tailscale configuration that survives reboots on its own.

## Notifications
- Events: new question (question title and first question in the body), approval requested (action type only,
  after `CP_APPROVAL_DELAY_SECONDS`), chat finished. One notification per event, no repeats. Tap -> opens the chat in the PWA (the service worker brings the window to the foreground and requests navigation).
- Persistent deduplication: `a:<chat>:<toolCallId>` for questions and approvals, `d:<chat>:<lastUpdatedAt>` for finished chats.
- No notifications from initial state: at startup questions older than `CP_STARTUP_GRACE_SECONDS` are marked
  as already notified without sending anything.
- Delivery: encrypted payload (aes128gcm), VAPID ES256 with 12 h lifetime, closed list of push service hosts (anti SSRF),
  two retries on 429/5xx/network, subscription removed on 404/410. The payload also carries the badge count.
- iOS: every push must show a notification; the service worker always calls `showNotification`, even with an anomalous payload.

## Actions (phase 2)
Require Cursor started with `--remote-debugging-port=9222` (`tools/cursor-cdp.sh`). Without the port the daemon stays read-only
and says so (`status.actions: 'off'`), rechecking every 5 s. Details and rationale: FINDINGS section 10.
```
POST /api/chats/:id/answer   { key, answers: [{ questionId, optionIds: [...], freeform }] }
POST /api/chats/:id/skip     { key }
POST /api/chats/:id/message  { text }
```
- Success response: `{ ok, verified, warning?, queued? }`. Errors: 400 `bad_answer`, 409 (`stale`, `no_question`, `mismatch`,
  `already_sent`, `question_pending`, `draft_not_empty`, `chat_not_in_sidebar`), 503 `actions_unavailable`, 504 `timeout`,
  502 `ui_failed`. Max body 64 KB (long text, including non-ASCII).
- Actions apply only to what the daemon sees NOW (key = `toolCallId`; otherwise 409 `stale`) and after validating answers
  against the real question read from the database.
- One action at a time (serial queue); timeout responds 504 immediately but the queue stays busy until the real work
  finishes. Deduplication: same answer 60 s, same message 8 s.
- Answer: open the chat in the sidebar, verify the displayed questionnaire is the expected one, fill it
  (check state before clicking: in single choice a second click DESELECTS), press "Next"/"Continue"; then
  reopen the chat the user had open. Send a message: opens the chat, rejects if there is a draft or a pending question,
  focuses the composer, `Input.insertText` (newline with Shift+Enter), send.
- Post-action verification from the database (up to 12 s): answer `submitted` with expected selection; message with more bubbles or
  longer composer queue. If Cursor does not write it in time: `verified: false`, never a fabricated success.
- If Cursor was restarted and the question is dead (flag on and `pending` bubble but no questionnaire) today the response is
  409 `no_question`. To verify live whether the questionnaire survives restart and whether degrading to a new message is needed.
- All selectors are in `cursor/agents-ui.js` (single file to update when Cursor changes) with diagnostics
  (`npm run cdp -- inspect`) that prints page structure and never the text.

## Security
- Bind on 127.0.0.1; exposure only via `tailscale serve`. Authentication required: one-time pairing code
  (8 characters, 15 minutes, 5 failures every 10 minutes) that opens a session (cookie `HttpOnly`, `SameSite=Strict`, `Secure`
  when HTTPS is used, 90 days of inactivity). Only SHA-256 fingerprints of codes and sessions are stored.
- HTTP checks: `Host` allowed only if localhost or `*.ts.net` or configured (anti DNS rebinding); `Origin` equal to `Host`
  on mutating requests; JSON `Content-Type`; max body 16 KB (64 KB for actions); CSP with no inline scripts or styles; `nosniff`,
  `frame-ancestors 'none'`; static files without path traversal; optional `CP_ALLOWED_TS_LOGINS` on Tailscale identity.
- API errors (JSON): `{ error, message, detail?, params? }`. `error` is a stable code; `message` is a concise English default for
  logs and clients without i18n. Optional `detail` disambiguates when several user messages share the same `error` (e.g. UI automation
  keys mapped from Cursor). Optional `params` supplies `{placeholder}` values. The PWA translates with `error.<detail>` first, then
  `error.<code>`, using catalogs in `pwa/js/i18n/locales/` (English source, Italian and others aligned by key).
- Logs: JSON with allow-list; numbers and booleans pass, strings only for a few known keys. Never chat contents, never
  raw error messages, never keys. Dedicated test that searches log contents.
- The Cursor database is always opened with `mode=ro` and `query_only`; never full scans (query by `composerId`).
  Test verifies file hash before and after.
- CDP port (phase 2): Cursor binds it to 127.0.0.1, but while open ANY program on the Mac can control Cursor.
  A risk to accept knowingly, only if you want actions; to remove it, reopen Cursor normally.
  The daemon never exposes it: the client accepts only WebSocket URLs on loopback, on the expected port and with path
  `/devtools/page/<id>`. Answering from the phone is equivalent to driving an agent with shell access: authentication always
  on, Tailscale, and `CP_ALLOWED_TS_LOGINS` recommended.
- Actions never write to the Cursor database: they drive the UI as the user would (clicks, text, keys) and
  read the database read-only for verification.

## PWA UI
- Home: "Richiedono attenzione" (with count), "In sospeso" (collapsed), then workspaces in Cursor order (collapsed
  state like Cursor, editable locally), 5 chats per group and "Mostra altre N" (Show N more).
- Chat detail: state, pending request, "Ignora"/"Ripristina" (Restore), last message, composer at bottom. For a chat in
  progress the request panel is not shown (Cursor leftover).
  - With actions enabled the question is a questionnaire: options with badges A, B, C (single choice = exclusive selection,
    multiple = checkboxes), "Altro" (Other) entry with free-text field (always at bottom, as in Cursor), one section per
    question, "Invia risposta" (Submit answer) active only with complete answers, "Salta" (Skip) with second confirmation that expires on its own, "Ignora".
    The outcome stays a few seconds above the composer even when the questionnaire disappears.
  - Without actions (debug port closed or offline) options are a read-only list with explanation and a
    link to "Impostazioni".
  - Composer (`composer.js`): field grows with text (max 140 px), draft kept in memory per chat (never on
    disk), send disabled when empty, hidden if a question is pending (answer first), reduced to one line
    of explanation if actions are unavailable; when the chat is working warns that Cursor queues the message.
  - Questionnaire and composer DOM is persistent (updated in place): a live update does not lose
    focus, selection, or typed text.
- "Impostazioni": "Rispondere dal telefono" (Answer from phone) panel with status (Attivo / porta chiusa / finestra non aperta / disattivato) and
  instructions to enable it.
- Safari/iOS: `touch-action: manipulation` and block ONLY the second tap of a double-tap (pinch free, text fields
  excluded), 16 px fields, `viewport-fit=cover` with safe margins and `100dvh`, composer follows the keyboard
  (`visualViewport` -> `--kb`), `format-detection` off, `-webkit-text-size-adjust`. Cursor logo top left on
  home and pairing screen, and as Home screen icon (`pwa/icons/cursor-logo.svg`, separate replaceable file:
  Anysphere trademark; `tools/make-icons.mjs` derives PNGs from it).
- Markers: red dot (attention), spinner (running), blue dot (unread), clock (pending).
- No emoji, SVG icons (Lucide, ISC, vendored); no gradients, glow, or purple/indigo; single blue accent and red
  only as semantic color; automatic light/dark theme; WCAG AA contrast verified.
- DOM is replaced only when markup actually changes (`commit`): identical periodic updates do not interrupt
  text selection or taps in progress.
- Offline: the service worker pre-caches all app files (list injected by the daemon); chat data never
  goes in cache.
