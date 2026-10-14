# Setup

Guide to run the daemon on the Mac and use the PWA from the iPhone. Status: push notifications and read-only work without anything else;
actions (reply, approve, write, stop, new chat, rename/pin/archive) require Cursor started with a local debug
port and have been VERIFIED LIVE on a real Cursor (FINDINGS 10.x and 11.x). Enable them as in section 6.

## 1. Requirements
- Mac with Cursor 3.x (Agents Window) and Node >= 22.13 (`node -v`). No `npm install`: zero dependencies.
- iPhone with iOS >= 16.4 (PWA push notifications exist only from version 16.4 and only for the app installed
  on the Home screen).
- Tailscale on Mac and iPhone, with MagicDNS and HTTPS certificates enabled for the tailnet (see section 4).

## 2. Starting the daemon
```
cd daemon
npm start
```
- Listens only on `127.0.0.1:8787` (port from `CP_PORT`): not reachable from the network.
- Reads the Cursor database in read-only mode (`mode=ro`, `query_only`): never writes to that database.
- Stores its own data in `daemon/data/` (permissions 0700): ignored items, sessions, push subscriptions, VAPID keys.
  Deleting the folder means starting from scratch (sessions and notifications must be re-enabled).
- Quick checks: `npm run status` (daemon running or not, “Dispositivi abbinati” (Paired devices), push subscriptions, ignored requests),
  `npm run probe` (reads the Cursor database and summarizes chats and groups anonymously; with `-- --names` shows
  workspace names, useful for comparing order with the Cursor sidebar).

### Automatic startup (recommended for daily use)
```
tools/launchd.sh install     # creates the service and starts the daemon
tools/launchd.sh status      # service and port status
tools/launchd.sh restart     # after updating the code
tools/launchd.sh uninstall   # removes it (data and logs remain)
tools/launchd.sh print       # shows the plist without installing anything
```
- Creates ONLY `~/Library/LaunchAgents/local.cursor-pocket.daemon.plist` (user service: no administrator) and the log folder
  `~/Library/Logs/cursor-pocket/`. Does not touch Cursor or Tailscale. macOS may show the “background item added” notice: it is the `node`
  service.
- The daemon starts at login and restarts on its own if it stops due to an error; if you stop it cleanly (`launchctl bootout`,
  `kill` without `-9`) it stays stopped until the next login or `restart`.
- Uses the REAL path to `node` (not the temporary fnm/nvm symlink): if you change Node version or move it, run
  `tools/launchd.sh install` again. `CP_*` variables present in the environment at install time are copied into the plist
  (installation prints their names).
- If the port is in use (for example an `npm start` still running) installation stops with a message: shut down that
  daemon first.
- Keep the project outside Documents, Desktop, and Downloads: services launched by launchd cannot access them without
  extra permissions. The log contains only counters and event types.
- After a Mac restart you still need Cursor and Tailscale running: the first is the data source, the second the path
  from the iPhone. `tailscale serve` remembers its configuration.

## 3. Try the PWA without touching real data
```
cd daemon
npm run demo                 # fake Cursor database, simulated push, port 8799
npm run demo -- --animate    # after 15 s a chat finishes, after 30 s one appears with a question
```
The command prints the address (`http://127.0.0.1:8799/`) and a pairing code. No real data is read. The
demo server also simulates Cursor (one- and two-option questions, actions): `npm run demo -- --no-actions` instead simulates
the debug port closed.

### Automatic browser check (optional, for developers)
```
node tools/ui-check.mjs webkit            # Safari engine, iPhone 14 viewport
node tools/ui-check.mjs chromium --dark   # dark theme; --shots saves screenshots
```
Runs through the app against the demo server (138-140 checks: logo, questionnaire, composer, approval, double tap, CSP...). Requires
`playwright-core` with browsers installed (`npx playwright install chromium webkit`), outside the repository, which does not
depend on it: if it cannot be resolved set `PLAYWRIGHT_CORE=/percorso/node_modules/playwright-core/index.mjs`. Does not replace a
test on a real iPhone (double-tap zoom, keyboard, full screen).

## 4. Make the daemon reachable from the iPhone (HTTPS with Tailscale)
Push notifications require HTTPS. `tailscale serve` exposes the daemon with a valid certificate ONLY inside your
tailnet (not on the Internet).

1. Once, in the Tailscale admin panel (DNS page) enable “HTTPS Certificates”.
   Privacy note: the machine name (`<mac>.<tailnet>.ts.net`) ends up in public Certificate
   Transparency logs. Without this step `tailscale serve` cannot obtain the certificate.
2. On the Mac: `tailscale serve --bg 8787` (run and verified with Tailscale 1.104.1). The address is
   `https://<mac>.<tailnet>.ts.net/`. The FIRST HTTPS request may take about 30 seconds because Tailscale obtains the
   certificate; later ones are immediate. The Tailscale app must be connected: when stopped certificates are not available.
3. Check: `tailscale serve status` (must report `(tailnet only)`). To remove exposure:
   `tailscale serve --https=443 off` or `tailscale serve reset`.
4. Do not use `tailscale funnel`: makes the service public on the Internet. VERIFIED SIDE EFFECT: if on this Mac
   Funnel is on even for another port/project (e.g. 8443), the name `<mac>.<tailnet>.ts.net` gets a
   public address on the Internet. From the Mac the name still resolves to Tailscale (`dig +short <nome>` shows 100.x), but
   `dig +short <nome> @8.8.8.8` shows public addresses that close the connection on 443. On the phone the observed symptom
   was: PWA stuck on the skeleton and Safari not loading the address either (the cause on the iPhone side is inferred
   from this, not verified inside the iPhone). Check: `tailscale serve status --json` and look for `AllowFunnel`. Fix:
   turn off Funnel (`tailscale funnel --https=<porta> off`): NOT enough, the public DNS record stays registered (verified
   on the authoritative DNS too) and the phone still would not load. What worked was giving the Mac a new name
   (`tailscale set --hostname=<nuovo>`, then `tailscale serve reset` and `tailscale serve --bg 8787`): the new name has no
   public address, but changes the PWA URL (reinstall and pair again). From the version with timeout the app shows “Daemon non
   raggiungibile” (Daemon unreachable) after 10 seconds instead of staying stuck.
5. Optional but recommended: `CP_ALLOWED_TS_LOGINS=tuo@account npm start` accepts only requests carrying
   that Tailscale identity (header added by `serve`; also blocks any Funnel, which does not send it).

## 5. Install the PWA and pair the iPhone
1. On Mac: `cd daemon && npm run pair` prints a code `XXXX-XXXX` (single use, valid 15 minutes).
2. On iPhone, in Safari, open `https://<mac>.<tailnet>.ts.net/`.
3. Share, then “Add to Home Screen”. Open the app FROM the Home screen: Safari and the installed app do not share data,
   so pairing must be done inside the installed app.
4. Enter the code. Access stays valid for 90 days of inactivity (`HttpOnly` cookie, `SameSite=Strict`).
5. “Impostazioni” (Settings), “Attiva notifiche”, allow, then “Invia notifica di prova”.

The badge on the icon shows how many chats “Richiedono attenzione” (Need attention).

## 6. Reply from the phone (Phase 2, optional)
Answering Cursor questions, skipping them, and sending messages to a chat requires Cursor started with a local
debug port. Without it, the app stays read-only (notifications, list, “Ignora” (Ignore)) and “Impostazioni” (Settings) explains it.

1. Quit Cursor with Cmd+Q. WARNING: in-progress chats are interrupted; wait until they finish.
2. From the project folder: `tools/cursor-cdp.sh`. Opens Cursor with `--remote-debugging-port=9222`; does not change Cursor settings
   or files in `~/.cursor`: the option applies only to that launch. `tools/cursor-cdp.sh status` says whether the port responds.
3. In the app’s “Impostazioni” (Settings) the “Rispondere dal telefono” panel switches to “Attivo” on its own (the daemon checks every 5 s).
   From the terminal: `cd daemon && npm run cdp -- status`.
4. To disable it: quit Cursor and reopen it normally (Dock, Spotlight). After every Mac or Cursor restart repeat
   step 2: the option is not permanent. A permanent launcher (app or Shortcut) has not been created.

What you can do from the phone, in a chat:
- Pending question: choose options (one or more, depending on the question), or “Altro” and write the answer, then “Invia
  risposta”. “Salta” skips the question (asks for a second confirmation). “Ignora” removes only the dot in the app.
- Message: the field at the bottom of the chat sends a new message to Cursor. If the agent is working Cursor decides whether
  to queue it or send it immediately. It does not send if the chat has a pending question (answer first) or if Cursor’s compose
  field already has a draft.
- The outcome appears as confirmation; if the daemon cannot confirm Cursor recorded the action it says so,
  without faking success.

Good to know:
- RISK: the port listens only on 127.0.0.1 (not reachable from the network), but while open any program on the
  Mac can control Cursor. Enable it only if you want actions.
- The daemon drives the Agents window like a user: opens the chat in the sidebar, fills in, then reopens the chat you had
  open (`CP_RESTORE_SELECTION=false` to skip that). Avoid using Cursor while replying from the phone.
- The Agents window must be open. Whether Cursor can stay in the background (or the Mac with the screen off) is to be
  VERIFIED LIVE (FINDINGS 10.5): if an action does not complete, bring Cursor to the foreground and retry.
- Maturity status: verified on a fake Cursor and a test page, NOT VERIFIED on a real Cursor. If a Cursor update
  changes the UI actions may fail with a clear error; selectors are in
  `daemon/src/cursor/agents-ui.js`. Diagnostics: `npm run cdp -- status | inspect | tray` (prints structure, never text;
  `--names` and `--texts` show them: for your testing only, never share). What remains to verify: FINDINGS 10.5.

## 7. Configuration (environment variables)
| Variable | Default | Meaning |
| --- | --- | --- |
| `CP_PORT` | `8787` | Daemon local port (127.0.0.1 only) |
| `CP_CURSOR_DB` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | Cursor database (read-only) |
| `CP_WORKSPACE_STORAGE` | `.../Cursor/User/workspaceStorage` | Cursor workspace folders |
| `CP_DATA_DIR` | `daemon/data` | Daemon’s own data |
| `CP_PENDING_AFTER_HOURS` | `24` | A pending request older than this moves from “Richiedono attenzione” (Need attention) to “In sospeso” (Pending) (0 = never) |
| `CP_MIN_RUN_SECONDS` | `20` | “Chat finished” is notified only if work lasted at least this long |
| `CP_DONE_SETTLE_MS` | `5000` | Stability wait before declaring a chat finished |
| `CP_STALE_RUN_HOURS` | `12` | An “in progress” marker older than this is a leftover (Cursor closed during work) |
| `CP_STARTUP_GRACE_SECONDS` | `300` | At startup only questions and approvals newer than this are notified |
| `CP_APPROVAL_DELAY_SECONDS` | `8` | An approval is notified only if still pending after this long (0 = immediately) |
| `CP_INCLUDE_CLASSIC` | `true` | Includes chats created in the classic editor (without `agentLocation`) |
| `CP_POLL_MS` / `CP_FULL_SCAN_MS` | `1000` / `1000` | Database read frequency (one deep re-read of 11 chats costs ~25 ms) |
| `CP_PAIRING_TTL_MINUTES` | `15` | Pairing code validity |
| `CP_ALLOWED_HOSTS` | (empty) | Additional host names accepted, besides localhost and `*.ts.net` |
| `CP_ALLOWED_TS_LOGINS` | (empty) | Allowed Tailscale accounts (see section 4) |
| `CP_VAPID_SUBJECT` | `mailto:cursor-pocket@example.com` | Contact given to push services in VAPID headers. Recommended: an address you control. Only the push service (Apple) sees it, not public |
| `CP_ACTIONS` | `true` | `false` disables actions from the phone (PWA stays read-only) |
| `CP_APPROVALS` | `true` | `false` disables only Run/Reject from the phone (replies and messages remain) |
| `CP_KEEP_AWAKE_CMD` | `/usr/bin/caffeinate` | command used by “Mac sveglio” (Keep Mac awake) (empty = feature unavailable) |
| `CP_KEEP_AWAKE_GRACE_MS` | `120000` | grace after the last in-progress chat before letting the Mac sleep |
| `CP_KEEP_AWAKE_POLL_MS` | `5000` | screen, battery, and sleep check while the Mac is kept awake |
| `CP_KEEP_AWAKE_MIN_BATTERY` | `20` | below this % on battery “lid closed” mode is suspended |
| `CP_BRIGHTNESS_CMD` | `daemon/data/bin/cp-brightness` | brightness helper (created with `tools/mac/build.sh`) |
| `CP_CDP_PORT` | `9222` | Cursor debug port (loopback only) |
| `CP_CDP_POLL_MS` | `5000` | How often the debug port and Agents window are checked |
| `CP_ACTION_TIMEOUT_SECONDS` | `45` | Maximum time for an action before replying “timeout” to the phone |
| `CP_RESTORE_SELECTION` | `true` | After an action reopens the chat you had open in Cursor |
| `CP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## 8. What arrives in notifications
- New question in a chat (title and first question in the body): one notification per question, never repeated, normally within
  a few seconds of appearing in Cursor. Only real questions (agent questionnaire): running commands do not
  generate notifications.
- Approval requested: the agent is waiting for your “Run”/“Allow” (a command, a change, an MCP tool,
  a web request; even when a project hook asks). Sent only if after `CP_APPROVAL_DELAY_SECONDS` (8 s)
  you are still waiting, so it does not bother you if you approve immediately on the Mac. The text says only the action type (“Comando da
  eseguire”), never the command. From the phone (inside the app) you can approve or reject a terminal command, with two taps; other requests you decide in Cursor on the Mac. If it never arrives, see
  FINDINGS 11.4 (and daemon log: `approval_seen`).
- Chat finished (after work of at least `CP_MIN_RUN_SECONDS`).
- Tapping the notification opens the chat. Notification content is end-to-end encrypted (RFC 8291) between the daemon and
  the iPhone: the push service only sees that a notification exists, not the text.
- Notifications are never sent from initial state at daemon startup (except very recent questions or approvals,
  see `CP_STARTUP_GRACE_SECONDS`).

## 9. The “Ignora” (Ignore) button
Removes the red dot ONLY in the app: sends nothing to Cursor and does not change the chat. The request moves to “In sospeso”
and can be restored. If the chat asks a new question, the dot reappears.
Cursor often leaves the dot on even for requests already closed (“leftovers”): the app shows them as “Richiesta non
risolta” and lets you ignore them.

## 10. Troubleshooting
- “Daemon non raggiungibile”: the daemon is not running or Tailscale is off on one of the devices.
- Error 421 / “Host non consentito”: you are using a name other than localhost or `*.ts.net`; add it with `CP_ALLOWED_HOSTS`.
- No notifications: the app is not installed from Home, permission denied (iOS Settings, Notifications), the address is not
  HTTPS, or the test from the app’s “Impostazioni” fails. Also check `npm run status`.
- “Database di Cursor non leggibile”: check `CP_CURSOR_DB`; if Cursor is open the database is still readable.
- Missing chats you had in Cursor, or fewer: the app shows only those in the Agents Window, so
  it hides chats from projects you REMOVED from the sidebar (even if you did not archive them). `npm run probe` reports how many
  are hidden for this reason.
- A working chat is “In corso” even if Cursor shows the orange dot: Cursor’s dot stays on for
  old questions; the app considers it only when the chat is idle.
- “Porta gia' in uso”: another instance is active, or change `CP_PORT`.
- Session expired or revoked: the app returns to the pairing screen on its own; generate a new code with `npm run pair`.
- “Risposte dal telefono: non attive”: Cursor was not started with the debug port (section 6). “Finestra Agents
  chiusa”: Cursor responds but the Agents window is not open.
- “La domanda e' cambiata o e' gia' stata risolta”: meanwhile you answered on the Mac or the agent asked another question;
  the app refreshes on its own. “La chat non e' visibile nella sidebar”: open it or expand the group in Cursor.
- “Non riesco ancora a confermare...”: the action started but Cursor has not written it to the database yet; check on the Mac
  before retrying (retrying the same thing within a few seconds is rejected to avoid double sends).

## 11. Security in brief
- The daemon listens only on loopback; validates `Host` (anti DNS rebinding), `Origin` on requests that modify data,
  JSON `Content-Type`, 16 KB limit per request, CSP without inline scripts or styles.
- Single-use pairing codes with limit of 5 failed attempts every 10 minutes; for sessions and codes only
  the SHA-256 fingerprint is stored.
- Logs contain only counters and event types: never keys, tokens, titles, or chat text.
- Replying from the phone (section 6) equals controlling an agent with shell access on the Mac: use only behind
  Tailscale, with authentication on, and preferably with `CP_ALLOWED_TS_LOGINS`. Actions never write to the Cursor
  database: they drive the UI like a user and read the database in read-only mode to verify. The per-request limit
  rises to 64 KB only for actions (long text).

## 12. Cursor branding
The logo at top left and on the pairing screen (`pwa/icons/cursor-logo.svg`) is a flat reproduction
of the Cursor icon, a trademark of Anysphere: it helps recognize the app at a glance, not an affiliation.
It lives in a separate file (used only by `pwa/js/components.js`, function `logoImg`) so it can be replaced or removed:
if you publish the project consider whether to keep it and replace it with your own icon by changing only that file. The same logo
is the app icon on the Home screen and the favicon: the PNGs (`pwa/icons/icon-192.png`, `icon-512.png`,
`apple-touch-icon.png`) are derived from `cursor-logo.svg` with `node tools/make-icons.mjs` (no dependencies; the SVG must
have a background `<rect>` and straight-line `<path>` elements, like the included one). After a change iOS keeps the old icon: remove
the app from Home and add it again.

