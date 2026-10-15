# Findings (verified on Cursor 3.24.6, macOS 26.5, Electron 42.10 / Chrome 148; live recheck on 3.25.6 in 10.4q)

Legend: [OK] verified live - [CODE] read in the bundle, not verified live - [NO] discarded.

## 1. Existing solutions (none suitable)
- Official Cursor Remote Control: shows all chats without splitting by workspace, includes archived ones,
  inbox centered on cloud agents, no real-time notifications comparable to Claude's app. [user]
- nitech/auto and similar (CursorRemote etc.): automation via CDP/DOM, fragile, designed for the classic IDE.
- Recursor, omg.dev, Nexting, Codync and similar: separate CLI/ACP sessions, NOT Agents Window chats.
- Pushary (SaaS ~9.99 USD/month): covers questions/approvals but not local Agents Window chats.
Conclusion: a custom solution is needed.

## 2. Data in the Cursor database (read-only)
Path: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (~17 GB, SQLite).
- [OK] Table `composerHeaders(composerId PK, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency,
  checkpointAt, value TEXT(JSON), subagentTypeName)`. Example: 587 chats, 286 archived, 130 subagents, 70 active workspaces.
- [OK] JSON `value` keys: agentLocation, agentLocationHistory, composerId, contextUsagePercent,
  conversationCheckpointLastUpdatedAt, createdAt, filesChangedCount, forceMode, hasBlockingPendingActions, hasPendingPlan,
  hasUnreadMessages, isBestOfNSubcomposer, isDraft, isProject, isSpec, isWorktree, lastUpdatedAt, name, numSubComposers,
  referencedPlans, subtitle, totalLinesAdded, totalLinesRemoved, trackedGitRepos, type, unifiedMode, workspaceIdentifier,
  worktreeStartedReadOnly.
- Verified in Phase 0 (see section 8): semantics of `hasBlockingPendingActions`, values of `agentLocation`, where Cursor
  saves workspace ORDER in the sidebar, how to recognize “in progress” and “finished”.
- [OK] Map workspaceId -> folder: `~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json`
  (`folder` field). Some workspaces are not mappable this way (to investigate, `workspaceIdentifier` in JSON).
- [OK] `cursorDiskKV`: keys `composerData:<composerId>` (JSON with `fullConversationHeadersOnly`, `status`,
  `generatingBubbleIds`, `queueItems`, ...) and `bubbleId:<composerId>:<bubbleId>` (messages and tool calls).
- [OK, CORRECTED IN 9.1] Pending native question: the LAST bubble of the chat has `toolFormerData.name == "ask_question"`.
  `toolFormerData.status` is `loading` only for the first 5-33 seconds; then it becomes `completed` with `additionalData.status ==
  "pending"` and stays that way (hours or days) until answered. (The first version of this note gave `loading` for the entire
  wait: that was a measurement taken within that brief window.) `toolFormerData.params` is a JSON string:
  `{title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}`.
  After answer: `status == "completed"`, `additionalData = {status:"submitted", currentSelections:{qid:[optId|"__freeform_other__"]},
  freeformTexts:{qid:text}}`, `result` = JSON `{"answers":[{questionId, selectedOptionIds, freeformText}]}`.
- [OK] Detection latency with 1 s polling: the question is seen as pending within ~1 s; scanning the 40 most
  recent chats costs ~0.4 s.
- The `status` field of `composerData` for chats with agent in loop can remain “aborted”/“completed”: do not rely on it alone
  to tell if the chat is finished; use the last bubble and headers.

## 3. Cursor hooks (hooks.json)
- [OK] They work in the Agents Window. Events used in tests: preToolUse, postToolUse, beforeShellExecution, beforeMCPExecution,
  afterMCPExecution, subagentStart/Stop, beforeSubmitPrompt, stop.
- [OK] They can block >= 100 s, deny with message (`user_message` arrives, `agent_message` does not), rewrite inputs
  (including MCP).
- [OK] They do NOT fire for: native AskQuestion, Glob, WebFetch. So the native question cannot be intercepted with a hook.
- [NOT VERIFIED] `stop` hook (not testable in a chat in loop): to try for “chat finished”.

## 4. Blocking MCP tool (discarded alternative but documented)
The user wants to use NATIVE AskQuestion, so this path is discarded. Measurements made:
- Without `notifications/progress`: 75 s OK, 330 s -> error -32001 “Request timed out” (limit between 75 and 330 s, not measured more precisely).
- With progress every 15 s: 130 s OK, 900 s OK, 3700 s -> “Maximum total timeout exceeded” at exactly 3600 s (1 hour total cap).
- Cursor can restart an MCP stdio server (all in-flight calls fail with “Connection closed”): success after
  starting a subagent, cause not confirmed.

## 5. Answering native questions: CDP
- [OK] `Cursor --remote-debugging-port=<port>` works: `/json/list` exposes the “Cursor Agents” window as a `page` target
  (title “Cursor Agents”). Cursor reads the switch in `main.js` and passes `cdpPort` to windows.
- [NO] `~/.cursor/argv.json` CANNOT set it (switch whitelist). Must be passed at launch:
  `open -a Cursor --args --remote-debugging-port=9222` (only with Cursor closed). See `research/launch-cursor-cdp.sh`.
- [OK] The port binds to 127.0.0.1. Anyone on the Mac can drive Cursor while it is active: risk to disclose.
- [OK] Question state lives in memory in the renderer (draft `additionalData.status:"pending"`, then
  `submitted` + persist). Writing to the database does NOT unblock the tool call. The bundle has no internal commands to answer.
- [CODE] Selectors in bundle `out/vs/workbench/workbench.glass.main.js`:
  - tray: `.glass-questionnaire-tray`
  - option: `button.ui-tray-option` (attributes `aria-pressed`, `data-selected`, `data-label-style="letter"`),
    badge `.ui-tray-option__badge` (A, B, C...), label `.ui-tray-option__label`
  - freeform field: `.questionnaire-freeform-option` (rich text editor; focus, then `Input.insertText`)
  - primary button: `.ui-tray-footer__primary button` (text “Continue” or “Next”); secondary “Skip”
  - multiple questions = steps (stepper): “Next” until the last, then “Continue”
  - tray open only for the visible chat: for an unselected chat you must open it in the sidebar first
  - sidebar: container `.glass-sidebar-agent-list-container`, rows with `data-sidebar-item-key` (HYPOTHESIS: chat id),
    `data-sidebar-selected-static-row`, `data-sidebar-status-subdued` ("done-unseen")
- Prototype: `research/bridge_probe.py` (commands pending, sidebar, tray, open, answer). `pending` verified; the rest NO.
- [NO] Accessibility/System Events: the Cursor window was not listed (not on current Space); fragile.
- [NO] SIGUSR1 on main process to open inspector: risk of terminating Cursor; do not try.

## 6. Notifications on iPhone
- The user sideloads with SideStore = free Apple ID => no APNs permission, 7-day certificate, Xcode not installed.
  So a native IPA CANNOT receive push with app closed. Decision: PWA.
- PWA installed on Home: real Web Push (iOS >= 16.4), VAPID, no account.
  Requires HTTPS: `tailscale serve` + enable HTTPS certificates in Tailscale admin panel.
- Tailscale: installed on Mac (`/usr/local/bin/tailscale`); at the start of research the iPhone had been offline for 23
  days and needed reconnecting (device names omitted: the repository may become public).
- Fallback: ntfy (App Store app) that opens the PWA.
- True “persistent” notification does not exist on iOS without Live Activity (requires APNs/native app). Alternative: “Pending”
  section in the PWA and, optional, repeated reminders (disabled by default).

## 7. Security
- Answering from phone = controlling an agent with shell access. Strong authentication, Tailscale only, no public ports.
- The state database contains keys in plain text; a Cursor process command line exposes an API key: do not log `ps`.
- The CDP port is total control of Cursor for local processes.

## 8. Phase 0 - database checks (Cursor 3.24.6, read-only)
Method: scripts `research/phase0_*.py` (stdlib only, `mode=ro`, print only counts, shapes and states: never titles
or text) and reading with `rg` of bundle `Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.glass.main.js`
(no modifications). Numbers are from the user's database at measurement time (588 headers).

### 8.1 `hasBlockingPendingActions`, `hasPendingPlan`, `hasUnreadMessages`
- [CODE] The renderer writes in the header the value computed from IN-MEMORY state: true if there is a blocking user
  decision (e.g. tool approval), a questionnaire awaiting input, or a blocked subagent. If the chat is not
  loaded in memory (Cursor restarted, chat archived, run interrupted) the flag is NOT recalculated and keeps the last
  written value.
- [CODE] Sidebar state (`tIi`): `needs_attention` if `hasBlockingPendingActions` or `hasPendingPlan`;
  `in_progress` if `composerData.status === "generating"`; otherwise `done`. With `done` and `hasUnreadMessages` the icon is
  "Completed, unread" (`done-unseen`). So Cursor's red dot = blocking flag or pending plan.
- [OK] 20 headers with flag true (10 not archived, 10 archived). Only 1 had last bubble `ask_question` in `loading`;
  for almost all others the last bubble was an `ask_question` `completed` with `additionalData.status:"pending"` (never
  `submitted`), for some `cancelled` or a bubble without tool.
  [INTERPRETATION CORRECTED IN 9.1] Then the `completed`/`pending` were mistaken for stuck leftovers. Live trace
  shows that is the NORMAL state of a question waiting for answer: `loading` lasts only a few seconds. True leftovers
  are others: flag on with last bubble that is not a pending question (answer given, question superseded by other
  messages, ...). Cursor keeps the dot on in those cases too: that is the reason for the “Ignore” button.
- Adopted rule (current version in 9.1): “Need attention” = like Cursor (flag or pending plan, not archived, not
  subagent, with content). Type: `domanda` if last bubble is an `ask_question` without answer (actionable in phase 2);
  `residuo` otherwise (the `azione` hypothesis for approvals was removed because disproven: 9.1). NOTIFICATIONS
  fire only from a new question (new pending `toolCallId`), from a pending tool approval (section 11), and from
  end of a run, never from initial state.
- [OK] `hasPendingPlan`: true in 1 header. `hasUnreadMessages`: true in 1 header out of 588 (idle chats are “read”).
- [CODE] `hasUnreadMessages` goes true at end of turn only if the chat is NOT the one shown in the Agents Window
  (`turnCompletionAnnouncement`); `lastReadAtMs` is in `composerData` (and in 1 header). So NOT enough for “chat finished”:
  if the user is viewing the chat on Mac the flag never fires.
- [HYPOTHESIS DISPROVEN, see 9.1] "Pending tool approval = tool in `loading` without `userDecision`": a running tool is
  `loading` without `userDecision` the same way (observed on dozens of commands in the same chat).
  A true approval was never observed in the database: today it cannot be recognized. `toolFormerData.userDecision`
  exists: `accepted` on answered questions, absent on executed commands. The true signal for approvals
  (`additionalData.reviewData`) was found later: section 11.

### 8.2 `agentLocation`, drafts, empty chats
- [OK] `agentLocation` is `null` in 446 headers (drafts and chats created in classic editor) and an object
  `{type, status, environment:{id, uri?}}` in 142: `local/active` (141; 9 with `environment.id:"empty-window"`, i.e. without
  folder) and `worktree/unknown` (1; with `worktreePath`, `worktreeId`, `sourceRepoRootPath`, `sourceEnvironment`, `ownership`).
  `agentLocationHistory` is a list with 1 element for the same 142.
- [CODE] Location types known to the bundle are `local`, `worktree`, `remote-ssh`, `remote-wsl`. In the local database
  there are no cloud agents: they come from the server (headers with `source:"cloud"`), not from `composerHeaders`.
- [OK] `isDraft:true` in 142 headers, all with null `agentLocation`: they are leftovers from the “new agent” flow (one per every
  agent created from the Agents Window, same count as those with `agentLocation`). They are not chats: exclude.
- [OK] `lastUpdatedAt == 0` in 249 headers: they are empty chats (sample of 60: 55 with 0 bubbles, 5 without `composerData`). For
  them `recency == createdAt`; for others `recency == lastUpdatedAt` (339 of 339). Chats with content
  (`lastUpdatedAt > 0`) almost all have 3+ bubbles.
- [OK] Set “visible local chats” = not archived, not subagent, not draft, `lastUpdatedAt > 0`: 35 chats of 588
  (another 131 not archived are empty). Origin: 24 with `agentLocation`, 11 classic (`agentLocation` null, with
  `workspaceIdentifier`).
- [OK] SQL columns and JSON match: `lastUpdatedAt`, `createdAt`, `workspaceId == workspaceIdentifier.id` (0 differences).
  `isDraft` is NOT an SQL column: it lives only in JSON.
- [OK, Oct 12, sidebar screenshot] Classic chats (`agentLocation` null) appear in the Agents Window: a chat
  created in the classic editor is visible in a sidebar group. So `CP_INCLUDE_CLASSIC=true` remains correct.
- [OK, Oct 12] **Projects removed from sidebar.** The filter above let through 35 chats, but the sidebar shows 9 (in 7
  groups): the other 26 are NOT archived chat by chat (`isArchived` false), they belong to projects the user
  REMOVED from the Agents Window. Where it lives: `ItemTable`, key `cursor/glass.removedProjects`, array of
  `{type:'workspace', id, name, repoUrls, workspaceIdentifier:{id, uri}}` (15 entries, 13 distinct workspaces). Link is
  `workspaceIdentifier.id` (32 chars), same as column `workspaceId` and chat `header.workspaceIdentifier.id`; entry field
  `id` (42 chars) is another identifier and is NOT needed.
  Rule "chat's workspace is among removed -> hidden": 9 shown of 9, 26 hidden of 26, 0 errors, both by id
  (column and header) and by name; for `uri.path` 34 chats of 35 (one has no uri). Comparison by id is the one used.
- [OK] Hypotheses discarded with same data: project `isArchived` in `glass.localAgentProjects.v1` (0 archived of 20),
  membership in a project in `glass.localAgentProjectMembership.v1` (272 entries: rule “has membership” showed 23 chats,
  22 extra and 8 missing), chat age, classic chats.
- [NOT VERIFIED] What happens if the user re-adds a removed project (presumed Cursor removes it from
  `glass.removedProjects`: daemon re-reads every 10 s) or creates a new chat in a removed project.
- [OK] After the rule visible chats are 9 (`npm run probe` also reports how many it hides).
- Header keys seen in this version, besides those listed in section 2: `unfinishedRunAt`, `lastReadAtMs`,
  `subagentInfo`, `draftTarget`, `hasBeenInSidebar`, `isEphemeral`, `committedToBranch`, `createdOnBranch`,
  `createdFromBackgroundAgent`, `projectAppearance`.

### 8.3 Workspace order in sidebar
- [OK] Key `cursor/glassSidebarSettings` in `ItemTable` of GLOBAL database (Cursor APPLICATION scope), JSON value:
  `groupBy` (`workspace`|`repository`|`environmentInstance`|`time`|`status`|`environment`), `sortAgentsBy`
  (`updated`|`status`), `sortGroupsBy` (`updated`|`manual`), `sectionOrderByGroupBy`, `collapsedSectionIdsByGroupBy`,
  `removedSectionIds`, `filter.show`, `compact`, `subtitle`. Default in code: `groupBy:"repository"`,
  `sortAgentsBy:"updated"`, `sortGroupsBy:"manual"`.
- [OK] User settings: `groupBy:"workspace"`, `sortGroupsBy:"manual"`, `sortAgentsBy:"updated"`; manual order
  saved both for `workspace` (12 ids) and `repository` (19 ids).
- [OK] Section id for `groupBy:"workspace"`: `__environment_instance_<h>__`, with `<h> = hash("local:path:<folder>")`
  (or `hash("local:home")` without folder). `hash` is VS Code's (signed int32: starts at 0, for strings
  `h=(h<<5)-h+149417`, then for each UTF-16 code unit `h=(h<<5)-h+c`). Reconstructed from real data: 7 ids saved of 12; the
  other 5 are almost certainly sections no longer existing. For `repository`: `repo:<normalized remote url>` or
  `workspace:<workspaceId>` / `workspace:home`.
- [CODE] Algorithm with `sortGroupsBy:"manual"` (`s3v`/`LO0`): first current sections NOT in saved order
  (in default order), then saved order filtered to present sections. Default order: `max(lastUpdatedAt)` of
  section chats, descending; tie by label (folder name). Inside section with `sortAgentsBy:"updated"`:
  descending `lastUpdatedAt`. With `sortGroupsBy:"updated"` only default order applies. Sidebar shows 5 chats per
  section then “More”.
- [OK, Oct 12] Visual comparison with user's sidebar screenshot (after excluding removed projects, 8.2): the 7 groups
  come out in the same order, folder name for folder name (user project names not repeated here)
  and with same sizes (2, 1, 1, 1, 1, 1, 2 chats).
- [CODE, Oct 12] Group “collapsed” state (bundle `workbench.glass.main.js`, `hmI`): `filterEmpty ?? transient ??
  (persisted || stale)`. List in `collapsedSectionIdsByGroupBy` is only the base value: groups emptied by filter
  are collapsed, a session value (click) overrides. [NOT EXPLAINED] In screenshot two groups are open
  despite showing collapsed in data read 24 minutes later (they may have been collapsed after screenshot, or a
  session value applies): PWA `collapsed` field reflects only saved list.

### 8.4 From chat to folder/workspace
- [OK] Of 35 visible chats: 24 resolve with `agentLocation.environment.uri`, 10 with `workspaceIdentifier.uri`,
  1 with `workspaceStorage/<id>/workspace.json` (`workspace` field, multi-root). None unresolved. The 249 with
  `workspaceIdentifier:{id}` without `uri` are never visible chats: 142 drafts (136 archived, 6 active), 98 empty active
  chats, 9 archived.
- Resolution priority: 1) `agentLocation.environment.uri`, 2) `workspaceIdentifier.uri`, 3) `workspace.json`
  (`folder` or `workspace`), 4) `empty-window` -> “home” section. `workspaceStorage`: 77 folders, 73 with `folder`,
  3 with `workspace`, 1 without `workspace.json`.

### 8.5 Chat in progress and finished chat
- [CODE] `unfinishedRunAt` in header equals `lastUpdatedAt ?? createdAt` only while `composerData.status === "generating"`
  (function `aqr`) and disappears (key absent) when run finishes. If Cursor dies during a run the marker remains:
  3 archived headers show it from 2 to 10 days.
- [CODE] Cursor considers “turn completed” (`bJm`) when `composerData.status === "completed"` and moreover: not
  subagent, not archived, empty `queueItems`, no foreground tool, no background subagent, no continuation
  goal.
- [OK] On the agent chat that made these measurements (in progress): header had `unfinishedRunAt` for entire run;
  `lastUpdatedAt`, `unfinishedRunAt` and `hasBlockingPendingActions` do NOT change during run; only
  `conversationCheckpointLastUpdatedAt` changes (about every 30-60 s).
- [OK] Persisted `composerData.status` stays “aborted” for entire in-progress run: NOT reliable during run. At rest
  it is `completed` (26 chats of 33), `aborted` (6), `none` (1).
- [OK] Header `lastUpdatedAt` = time of last USER message (start of last turn; median skew 0.0 s),
  not last activity. `conversationCheckpointLastUpdatedAt` = about 3.5 s after last bubble (median): follows end
  of turn.
- [OK] Bubbles are written to database within less than 1 s: delay observed between bubble `createdAt` and visibility to
  sampler (0.5 s step) from few ms to 853 ms. `composerData.fullConversationHeadersOnly[i]` has `bubbleId`, `createdAt`
  (ISO), `startedAtMs`, `type` (1 user, 2 assistant), `grouping`: last bubble time is read without opening it.
- [OK] Tool states in `toolFormerData.status`: `loading`, `completed`, `cancelled`, `error`. `additionalData.status`:
  terminal `success`/`error` at end (and `cancelled` while still `loading`, misleading value); `ask_question`
  `submitted` (answer given) / `pending` (WITHOUT answer: still waiting, or superseded by freeform message; see 9.1) /
  `cancelled`; `task_v2` `pending` -> `running`.
- Scan of 25 chats x 40 bubbles (793 bubbles) costs 0.4 s: 1 s polling is sustainable.
- Chosen signal (CALIBRATED live in 9.2): a chat is “in progress” if header has `unfinishedRunAt` or last bubble
  is recent; it is “finished” when it goes from in progress to not in progress (`unfinishedRunAt` gone, no question nor flag, last
  bubble not `loading`, stable for a few seconds). `composerData.status` only to distinguish `completed` from `aborted`
  (interrupted: no notification by default). [Implemented version and why it differs: 9.2.]
- [NOT VERIFIED] `stop` hook: requires modifying `~/.cursor/hooks.json` (confirm and backup). With these signals
  it may not be needed.

### 8.6 Subagents
- [OK] A test-launched `explore` subagent did NOT create any row in `composerHeaders` (588 before and after): light
  ones are ephemeral. Those present (130) have `isSubagent=1`, `subagentInfo.parentComposerId`, id of form `task-...`.
## 9. Phase 1 - implementation decisions and what was verified
The daemon and PWA are implemented; 93 automated tests (`cd daemon && npm test`). Labels match section 8.
Everything that depends on Cursor internal details is confined to `daemon/src/cursor/`.

### 9.1 Live trace of a question and rules derived from it
The sampler (`research/phase0_sampler.py`, 0.5 s step, metadata only) recorded a real `ask_question`
live. Times in UTC; chats are identified by the first 8 characters of the id.
- [OK] Question lifecycle (chat `be5784e2`, posted at 18:08:47):
  1. The `ask_question` bubble is born with `toolFormerData.status: "loading"`; 3 ms later the header switches to
     `hasBlockingPendingActions: true`.
  2. After 33 s (18:09:20) the agent turn ends: the bubble becomes `completed` with `additionalData.status: "pending"`, the
     composer goes from `aborted` to `completed` and `unfinishedRunAt` disappears from composerData. The question is NOT resolved: the
     flag stayed on for hours (no change until sampling ended, 20:07) and the answer arrived the next morning.
  3. On answer: bubble `submitted`, flag off, new run with a new `unfinishedRunAt` (read afterward).
  On another chat (`6814061b`) the `loading` window lasted 5.6 s. So `loading` is NOT a reliable marker of
  “question pending”: almost always the bubble is `completed`/`pending`. (Sections 2, 8.1 and 8.5 and the first daemon version
  assumed the opposite: with that rule every question would become a “residue” after a few seconds and the
  daemon would also send an out-of-place “Chat finished” when the turn ended with the question. Fixed and covered by tests.)
- [OK] Cursor can REWRITE the question bubble while waiting: `createdAt` moves forward (`be5784e2`: 19:04 and
  20:45; `6814061b`: 21:39) and the bubble list in composerData carries the same rewritten time. The bubble time is therefore not
  the question time: the stable key is `toolCallId`.
- [OK] A `pending` question stays that way if the user replies with a free-form message instead of using the questionnaire
  (`6814061b`: the 16:54 question stays `pending` and is followed by other bubbles). The flag does not turn off for this.
  A question superseded by other messages, or already answered, with the flag still on is a true residue.
- [OK] Real data after the fix (Oct 12 morning): 34 visible chats, 9 with flag on: 8 with a `ask_question`
  `completed`/`pending` as last bubble (11 to 323 hours) and 1 with last text bubble (true residue). With the old rule all 9 would have been residues.
- [DECISION] Pending request is classified by looking at the last bubble: `domanda` (`ask_question` not `submitted`:
  `loading` or `additionalData.status: "pending"`; key `toolCallId`), `piano`, `residuo` (flag or plan on but last
  bubble is not an open question). Only `domanda` is “live” and can be notified. The question is live if the flag is
  on OR if it is RECENT (bubble created less than 120 s ago): the Cursor header arrives late (9.7). With flag off
  an old question does not count: Cursor does not show the dot and it could be a tool stuck `loading` from an interrupted run.
- [OK, Oct 12] Flag on also matches an OLD question still `pending` inside the conversation, not only
  the last bubble: `a9d0c36d` has a `ask_question` `completed`/`pending` from 34 hours earlier, followed by other bubbles (the chat
  continued without using the questionnaire) and the flag stays on. That is why many “true” residues are actually forgotten questions.
  Also because of the flag, Cursor shows the orange dot even while the agent is WORKING (`6814061b`, in
  progress for almost an hour with flag on: in the screenshot it has the dot like chats idle waiting).
- [OK, HYPOTHESIS DISPROVEN] A running tool is NOT distinguishable from an approval. The first version classified as `azione`
  every tool other than `ask_question` in `loading` with no `userDecision` while flag on. After iPhone pairing (Oct 12,
  around 12:00 UTC) chat `6814061b` (flag on from an old unresolved question, now working through a
  series of terminal commands) produced 1 to 5 “new requests” per minute: 68 distinct keys in 28 minutes (11:36-12:04
  UTC; between events 5 s to 161 s apart, median 15 s), i.e. one event per command. 14 became pushes actually
  sent to the iPhone. On those bubbles `userDecision` is absent and `additionalData.status` is `cancelled` while the command is
  still `loading`. Fix: no approval classification; only `ask_question` can be a live
  request; any other tool with flag on is a `residuo` (no notification). Regression tests in `model.test.js` and
  `watcher.test.js`, verified by reintroducing the bug (both fail). After daemon restart: 0 events.
  Lesson: an unverified hypothesis must never be able to generate notifications. (The real approval signal, `reviewData`, is
  in 11; this rule remains valid for any tool WITHOUT `reviewData`.)
- [DECISION] A request stays in “Need attention” for 24 h (`CP_PENDING_AFTER_HOURS`) from its start (bubble time
  for question and action, last chat update for residue and plan), then moves to “Pending” (reason `vecchia`).
  A live question days old does not disappear: it stays visible in “by design, actionable in phase 2”.
- [DECISION] Ignore: key `(chatId, key)`; `key` = `toolCallId` (question and action), last tool or last bubble (residue),
  `plan:<bubble>` (plan). Writes only `daemon/data/store.db`. Moves the request to “reason `ignorata`”, reversible.
  With a new request the key changes and the dot reappears.

### 9.2 Notifications
- [DECISION] Only transitions are notified, never initial state. Persistent dedup keys: `a:<chat>:<toolCallId>`
  (question or approval) and `d:<chat>:<lastUpdatedAt>` (chat finished). On startup live questions older than 300 s are marked as already
  notified without sending anything; more recent ones fire (covers a daemon restart right after a question).
- [DECISION] “In progress” = header has `unfinishedRunAt` (no older than 12 h) AND composer state is not `completed`.
  The “recent last bubble” heuristic hypothesized in 8.5 was not adopted: the marker alone is simpler and does not
  require thresholds to tune.
- [OK] The header lags behind the composer. At end of run for `be5784e2` the composer removed `unfinishedRunAt`
  at 18:09:20 and the header 27 s later; for a 35 s run (`6814061b`) the header never showed the run; in a third case
  (`7cb1e28c`, 1 s run) the two writes were simultaneous. The composer changes immediately instead: `status` goes to
  `aborted` when the user sends a message and back to `completed` the instant the run ends (3 of 3 cases, together with
  disappearance of `unfinishedRunAt`); during the run it is never `completed` (no exception in over an hour of run).
  So `completed` is a reliable signal of “run finished”: a chat the header still says in progress is considered finished if
  the composer is `completed` (early finish). The header remains the start signal.
- [DECISION] “Chat finished” = was in progress, then stopped for 5 s, with no live requests and no open question (a run that
  ends with a question is NOT finished: waiting for user), no queued messages, after a run of at least 20 s. A run already
  in progress at daemon startup counts as long.
- [DECISION] All visible chats are re-read every 5 s even with unchanged header (before, only those with flag, in progress or
  just finished): a new question in a chat with flag already on (`6814061b`) does not change the header for tens of seconds
  and, in a chat without flag, the header can arrive up to 60 s after the bubble (9.7). Measured cost: 11 ms for 9 chats.
- [LIMIT] The daemon does NOT distinguish a manually stopped (or failed) run from a successful finish: at rest it was never observed and
  `status` is `aborted` in 6 of 33 chats (8.5). “Chat finished” notification anyway: better one extra notification than one missed.
- [LIMIT] The daemon learns run start from the header, which can arrive late or be missing: a 20-60 s run may
  not produce “Chat finished” and a longer one may be measured shorter than reality. Does not affect runs of minutes or hours.
- [CODE] iOS requires every push to show a notification (section 6): the service worker always calls `showNotification`, even
  with absent or invalid payload (there was a bug with JSON `null`, found by a test and fixed).
- [OK] The VAPID contact (`CP_VAPID_SUBJECT`) reaches push services in the `sub` claim. The default uses an example domain
  and Apple (`web.push.apple.com`) accepted it: the Oct 12 test push was delivered (`push_sent
  kind=test sent=1 failed=0`). Setting a real address remains recommended.

### 9.3 Security (what is implemented and how it is covered)
- Mandatory authentication on all APIs (except `/healthz`, `/api/session`, `/api/pair`): one-time 8-character pairing
  code (15 min, 5 failures per 10 min), session with `HttpOnly` + `SameSite=Strict` cookie (+ `Secure` on HTTPS), only SHA-256
  fingerprints stored for codes and sessions. Checks on `Host` (421), `Origin` (403), `Content-Type` (415), size (413).
- Logs with ALLOW-LIST (before it was a deny-list: too fragile): numbers and booleans pass, strings only for a few known keys.
  A test verifies chat titles and bodies never appear in logs.
- The Cursor database opens with `readOnly` + `PRAGMA query_only`; a test compares SHA-256 hash of the file before and after.
- Web Push: endpoints allowed only if HTTPS and known push services (anti SSRF); 404/410 remove the subscription.

### 9.4 PWA: what was verified
- [OK] In Cursor embedded browser (390 px emulation, light and dark theme), on the real daemon with synthetic database
  (`npm run demo`): pairing with wrong and correct code, home, Ignore and Restore (state, counts, tab title),
  Settings, live updates (SSE), banner when daemon is down, return to login on 401, logout, service
  worker activation with pre-cache of 19 files without API data, cold start offline from cache. Text/background contrast >= 4.5:1
  (WCAG AA) in both themes.
- [OK] Real iPhone (Oct 12): PWA reachable via `tailscale serve`, installed to Home from Safari and paired with the
  code; user granted permission and received the test notification. Daemon side: `paired`, `push_subscribed`
  (service `web.push.apple.com`), `push_sent kind=test sent=1 failed=0`.
- [NOT VERIFIED] Push with PWA closed or screen locked (not explicitly verified), tap on notification opening the chat,
  badge on icon, real “chat finished” notification, long-term behavior (session, subscription). Service worker behavior on notification press is verified only with a
  simulation (`daemon/test/sw.test.js`).
- [OK] `tailscale serve --bg 8787` (Tailscale 1.104.1, with user consent, after they enabled HTTPS certificates in the
  panel: `CertDomains` went from 0 to 1). `serve status` reports `(tailnet only)`. From Mac, via HTTPS with verified
  certificate: `/healthz` 200 (first request took about 30 s for certificate issuance), `/` 200 (HTML),
  `/api/state` without session 401; `Host` check accepts `*.ts.net`. `serve` passes `X-Forwarded-Proto: https`: the
  daemon responds with HSTS via HTTPS and not via loopback, so the session cookie will have `Secure` (inferred from HSTS, the
  cookie itself will be seen with pairing). To remove exposure: `tailscale serve --https=443 off` or
  `tailscale serve reset`.
- [OK, PITFALL] With Tailscale app stopped (`WantRunning` false, e.g. after an update) `BackendState` is
  `Stopped` and `CertDomains` appears empty even if certificates are enabled: check state before inferring
  enablement is missing. Read with `tailscale debug prefs` (field `WantRunning`).

### 9.5 Other sampler observations
- [OK] Before the question, 54 minutes with only this chat in progress: in the header only
  `conversationCheckpointLastUpdatedAt` changed (55 times, about every 60 s); no flag and no composer `status` changed.
- [OK] On message send the composer does: `status` -> `aborted` and `genUUID` -> empty; 2-8 s later arrive new
  `genUUID`, `lastUpdatedAt` and `unfinishedRunAt` (same value: send time).
- [OK] `hasUnreadMessages` is NOT a “finished” signal: on `7cb1e28c` it went `true` at the START of a 1 s run, not
  at the end (confirms 8.1).
- During tool calls `additionalData.status` took `pending`, `running`, `cancelled`: possible discriminator
  for tool approvals, NOT verified.

### 9.6 Known limits
- Displayed question age is based on bubble time, which Cursor can rewrite (9.1): it may appear more recent
  than reality. A reliable anchor would be when the daemon first saw the question (already stored in the
  store for dedup), not yet used.
- `removedSectionIds` (sections manually removed from sidebar) is not handled: no case in real data. Different from
  `glass.removedProjects`, which is handled (8.2).
- [SUPERSEDED IN 11] Tool approvals (“Run”/“Allow”, including those requested by a hook) are now recognized from
  `reviewData.status: "Requested"` and generate a notification; still to verify live that the database contains it DURING
  the wait (11.4). A tool without `reviewData` is never a request.
- A removed project then re-added, or a new chat in a removed project: Cursor behavior not verified (8.2).

### 9.7 Cursor header delay and question detection
User report (Oct 12): a question notification "arrived, a bit late". Measurement with a read-only sampler
(0.3 s step: new writes to `cursorDiskKV` via `rowid` and changes to `composerHeaders`), times UTC.
- [OK] Cursor writes headers in two ways: (a) a PERIODIC write every 60 s, at `:19.5` seconds (12:24:19 ... 12:30:19,
  7 consecutive minutes without skipping one; phase depends on Cursor startup, not absolute), which normally updates only
  `conversationCheckpointLastUpdatedAt`; (b) EVENT-driven writes (end of a run, answer to a question) that
  also carry pending changes from other chats.
- [OK] Flag `hasBlockingPendingActions` therefore appears in the header with variable delay vs the question bubble.
  Two live cases: `e2681e06` bubble at 12:24:32.9, flag at 12:24:37.7 (+4.8 s, on a run-end write);
  `5cb3de41` bubble at 12:24:38.6, flag at 12:25:19.5 (+41 s, had to wait for the periodic one). Consistent with daemon
  history: questions detected in chats with no prior flag all fall at `:18-:19` seconds of each minute
  (12:08:19, 12:10:19, 12:12:19, three different chats), i.e. delay from a few seconds to 60 s, average about 30 s.
- [OK] The question BUBBLE is written immediately instead: `createdAt` 12:24:32.712 for a row seen in the log at
  12:24:32.909. Fields `loading -> completed/pending` and `composerData` are updated IN PLACE (same `rowid`: 1.135.286
  for a bubble created 30 s before a max of 1.135.943; `composerData` 1.004.523): `rowid` only sees creations.
  That is why it is not used as a change log.
- [DECISION] Every 5 s the “tail” of ALL visible chats is re-read (`composerTail` + last bubble: 11 ms total for
  9 chats; 0.5 ms per 1000 bubbles, 3 ms per 5000) and an unanswered question created less than 120 s ago counts as live even with flag
  off (`FRESH_QUESTION_MS`, two periodic write cycles). Key `toolCallId`, so a flag arriving later does not generate
  a second notification. Expected delay: at most `fullScanMs` (5 s) plus read step (1 s).
- [OK, SUBJECTIVE] With the fix active the user reported the notification “feels immediate” (Oct 12). Not a
  measurement: for a value in seconds a sampler on a real question is needed.
- [OK] A chat that is WORKING with flag on is not “waiting for you”: in the PWA it is “In progress” (not “Needs attention”)
  until the run ends; then the residue returns and can be ignored. Only a live question stays in attention.
- [OK, Oct 12] Daemon cost at steady state (35 visible chats, read every second and deep re-read every 5 s, after phase 2
  features and approvals): CPU 0.2%, memory 24 MB per `top` (68 MB RSS per `ps`), 8 threads.

## 10. Phase 2 - actions from the PWA (tested on simulators and, since Oct 13, on a real Cursor: see 10.6)
Status (Oct 12): answering questions, skipping them, and sending messages are implemented (`daemon/src/actions.js`,
`daemon/src/cursor/agents-ui.js`, `daemon/src/cursor/cdp.js`) and verified with automated tests on a fake Cursor and on a
real Chromium with a page that reproduces the structure derived from the bundle. Until Oct 12 nothing had been tested on a real Cursor (results in 10.6):
Cursor must be restarted with `--remote-debugging-port=9222` (`tools/cursor-cdp.sh`), which interrupts chats in progress, so
the user is asked first. Until the port is available actions show as inactive and the PWA stays read-only with
an explanation (no error).

### 10.1 What the Cursor 3.24.6 bundle says [CODE]
Read `out/vs/workbench/workbench.glass.main.js` (never modified). Beyond the selectors in section 5:
- The questionnaire is component `kVC` (class `glass-questionnaire-tray`): one question per “step”. The primary button in
  the footer is always the one that sends the final answer (“Next” while more steps remain, “Continue” on the last);
  “Skip” is secondary.
- Tapping the ALREADY selected option on a SINGLE-choice question DESELECTS it (function `Weg`). That is why the daemon
  checks state before clicking: the action is idempotent. On single choice, selecting an option advances automatically
  to the next step (`Jnl`); on multiple choice you advance with the primary button.
- Free-form entry has id `__freeform_other__` and is added by Cursor itself: agent options that look like “Other”
  are hidden by Cursor and the daemon filters them with the same rule (`isOtherLabel`).
- Composer: Lexical editor (class `aislash-editor-input`) and button with `aria-label="Send message"`.
- Sidebar: rows with `data-sidebar-item-key`, shape `row:<composerId>` [HYPOTHESIS derived from code].
- Outcome is read from the question bubble in the database: `additionalData.status: "submitted"` with `currentSelections` and
  `freeformTexts` (see sections 2 and 9.1). That is the signal the daemon uses to confirm.

### 10.2 How the daemon acts [DECISION]
- Actions apply only to what the daemon sees NOW: the request carries the key (`toolCallId`) of the question the user has
  in front of them; if it is no longer the current one the response is 409 `stale` and Cursor is not touched.
- Answers are validated against the real question read from the database (existing options, “Altro” with text, a single
  option on single-choice questions, max lengths), not against what the phone sends.
- One action at a time (serial queue: they manipulate the same window). If time runs out
  (`CP_ACTION_TIMEOUT_SECONDS`, 45 s) the phone gets 504 immediately, but the queue stays busy until the real work
  finishes: no second action runs on top of the first.
- Deduplication: same answer within 60 s, or same message text within 8 s, yields 409 `already_sent`.
- A message is not sent if a question is pending (409 `question_pending`: answer first), if approval is pending
  (409 `approval_pending`: with “ferma e invia” (stop and send) enabled in Cursor it would cancel the command, so decide first on the
  Mac; section 11), or if the Cursor composer already has a draft (`draft_not_empty`): work the user did on the Mac is never
  overwritten.
- The chat is opened in the sidebar (the questionnaire exists only for the visible chat) and at the end of the action the PREVIOUS
  selection is RESTORED (`CP_RESTORE_SELECTION`, true by default), so the phone does not shift the user's view. With
  `Emulation.setFocusEmulationEnabled` the page behaves as if focused even with Cursor in the background
  (applies only for the CDP session).
- Database verification after the action, up to 12 s: answer = `submitted` with the expected selection (otherwise the outcome
  includes `warning: "differs"`); skip = state is no longer `pending`; message = bubbles increase or the composer queue grows.
  If Cursor does not write in time the outcome is `verified: false` and the PWA says so without faking success.
- Logs contain only action type, duration, outcome, and error code: never text. The CDP client accepts only WebSocket URLs on
  loopback, on the expected port, with path `/devtools/page/<id>`; Node's WebSocket does not send the `Origin` header.
- State exposed to the PWA in `status.actions`: `ok` | `off` (port closed) | `no_window` (Agents window not open) |
  `disabled` (`CP_ACTIONS=false`). The daemon rechecks every `CP_CDP_POLL_MS` (5 s, HTTP only).

### 10.3 What was tested and with what
- [OK] CDP client (`daemon/test/cdp.test.js`): URL validation, errors, timeout, close, click and text, parallel
  requests. With a fake WebSocket and a real server.
- [OK] `agents-ui.js` on real Chromium with `daemon/test/helpers/mock-agents-page.html` (sidebar and questionnaire built
  as in the bundle): single choice, multiple choice, “Other” with line breaks, multiple questions with automatic advance, already-
  selected option not clicked again, wrong question (`mismatch`), missing chat, “Skip”, restoring the open chat.
  The suite skips these tests if it finds no Chromium (`CP_TEST_CHROME` or Playwright's): it stays dependency-free.
- [OK] Actions service (`daemon/test/actions.test.js`, 19 tests): queue, timeout with immediate 504, deduplication,
  `stale`, validation, database verification, queued messages, HTTP endpoints, exposed state.
- [OK] PWA logic (`daemon/test/pwa-logic.test.js`, 15 tests): answer state, error messages, double-tap
  recognition and keyboard height calculation.
- [OK] PWA in real browsers with the demo server (fake Cursor, no real data), `tools/ui-check.mjs`: 51 checks
  in WebKit (Safari's engine, Playwright build) and Chromium, light and dark theme, iPhone 14 viewport. They verify:
  logo top left, `touch-action`, 16 px fields (no zoom on focus), questionnaire (single, multiple, “Altro”,
  multiple questions, “Skip” with double confirm), composer (anchored at bottom, grows with text, draft preserved,
  outcome), double tap blocked with real touches (`touchscreen.tap`: the second close tap is cancelled, the first and an
  isolated one are not), approval screen (action type without the command, no composer, “Ignore” and “Restore”),
  no horizontal scroll, no CSP violation.
- [WORKAROUND] In WebKit every Playwright `page.screenshot()` triggers a spurious CSP error (one per screenshot, zero
  before): it does not come from the page. Strict CSP checking is running without `--shots`.
- [OK, FOUND BY TEST] After a successful answer the questionnaire disappeared as soon as the daemon saw `submitted`, and with it
  the “Risposta inviata” (Answer sent) text: the user might never see confirmation. Now the outcome stays a few seconds above the
  composer (`composer.flash`).

### 10.4 Safari/iOS: choices and what cannot be tested here
- Zoom: no `maximum-scale` or `user-scalable=no` (iOS ignores them from version 10 onward, for accessibility). Use
  `touch-action: manipulation` everywhere, 16 px text fields (below that, iOS zooms on focus) and a JavaScript safety net
  (`pwa/js/viewport.js`) that cancels the SECOND tap of a double tap (within 350 ms and 36 px, only if clean:
  not a drag or long press), excluding text fields where double tap selects text. Pinch zoom stays free. A double tap on “Invia” (Send) does not send twice.
- Keyboard: on iOS the keyboard does not resize the page but only the visual viewport; `--kb` (CSS) follows its height
  (80 px threshold, ignoring pinch) and the composer stays above the keyboard.
- Other: `viewport-fit=cover` and safe margins, `100dvh`, `-webkit-text-size-adjust`, no automatic detection of
  phone numbers or addresses, text selection disabled on controls only.
- [NOT VERIFIED] On a real iPhone: effective double-tap zoom blocking, composer above the keyboard, full-screen PWA and
  status bar. Logic, CSS, and DOM are verified in engines, not iOS behavior.
- Branding: the app uses its own mark (`pwa/icons/app-logo.svg`: a phone with a red dot), also as Home screen icon and favicon. It replaced
  the Cursor logo (a trademark of Anysphere) before the project went public. `tools/make-icons.mjs` reads polygons from the SVG and
  generates PNGs (180, 192, 512 px, full bleed: iOS rounds the corners) with no dependencies; change the SVG and rerun it.

### 10.4b Revised iOS interface (Oct 14) [OK in browser, NOT VERIFIED on iPhone]
User-selected package: (1) bottom bar Chat / “Settings” with badge for requests that need attention, hidden
in chats (the composer is there); (2) rows with title, project, and status on separate lines, request-type icon
(question, approval, plan), question preview; (3) formatted agent text (headings, lists, code, quotes,
  bold and italic) with a dedicated safe formatter (`pwa/js/markdown.js`: DOM nodes only, no clickable links, HTML
  stays text; 6 tests); (4) swiping a row left reveals “Ignore” (Pointer events, `touch-action: pan-y pinch-zoom`,
 the list does not redraw during the gesture) and pulling the list down at the top refreshes it (touch events); (5) 160 ms fade
 between screens, opacity only (a transform would move the fixed composer) and off with Reduce Motion.
Verified: `tools/ui-check.mjs` in WebKit and Chromium, light and dark theme (74-80 checks, including mouse drag,
 “Ignore” from the row, real taps via CDP in Chromium for pull-to-refresh). NOT verified: behavior of these
 gestures with a finger on a real iPhone (edge back gesture conflict, Safari bounce at top, scrolling).

### 10.4c Recent activity and detail refresh (Oct 15) [OK in browser and on real read-only data, NOT VERIFIED on iPhone]
User request: more updates while the agent works and no “freeze” after answering a question. Cause: detail (last message, question) was
re-read only when the chat tab changed, and Cursor writes the header with
 delay (after an answer the chat stays ~20 s as a “live question” with nothing else to show). Now: `GET /api/chats/:id` also returns
 `activity` (last 10 bubbles: type, time, category and tool LABEL, one-line message preview; never commands
 or paths: `daemon/src/state/present.js` `activityOf`, `db.recentActivity`, ~2 ms) and the PWA re-reads detail every 4 s (1.5 s while the agent works or its reaction is awaited) with the
 screen open and visible (and when returning to foreground). After an answer or message from the phone the daemon re-reads that
 chat every second for 2 minutes (`watcher.boost`): in real logs the new question was seen 2-5 s after creation (5 s periodic re-read),
 now ~1 s. Panel "L'agente sta lavorando" (The agent is working) (tool with `loading` state or chat in
 progress), "Inviato: in attesa dell'agente" (Sent: waiting for the agent) (after an answer or message, until the first new step (compare by bubble id, not timestamps) or 90 s) or "Attivita' recente" (Recent activity). A tool left `loading` for over 15 minutes is
 treated as stale. Bubble shape observed on the test chat: type 1 user, type 2 assistant (text) or tool
 (`toolFormerData.name/status`, e.g. `ask_question`, `run_terminal_command_v2`, state `completed`); NO “thinking” bubbles.
 Limit: if Cursor does not write steps to the database until they finish (not verified on a long live run),
 the panel cannot show more than Cursor has written.

Live measurement on the test chat (read-only observer every 0.5 s, after an answer sent by the daemon): 1.5 s after the
 answer the question becomes “stale” (header flag still on); the agent works (commands) but `unfinishedRunAt` is NOT
 written, so `running` stays false for the whole phase and the chat looks idle when it is not; the new question appears as a
 `loading` bubble after ~16 s (“live question” state) but `toolFormerData.params` is empty until transition to `completed`, ~17 s
 later (34 s from the answer): until the agent finishes wording the question Cursor does not save its text. PWA consequences during
 that window: the panel says "L'agente sta preparando la domanda" (The agent is preparing the question) (no longer “apri Cursor sul Mac” (open Cursor on the Mac)), the
 “stale” flag is not shown if the agent is working or its reaction is awaited, and detail is re-read every 1.5 s until
 text appears. Reading the question from the Cursor window instead of the database does NOT shorten wait in a practical way: the tray
 (`.glass-questionnaire-tray`) exists in the DOM only for the foreground chat in the Agents Window (in a second measurement the
 window showed another chat and the tray text matched that one, not the test chat); to read the right one you would have to bring it
 to the foreground, changing what the user sees on the Mac. Second measurement: live question at +8.5 s,
 text in database at +10 s (first time 17 s: depends on how long the agent takes to word it).
 Residual delay reported by the user (“still arrives a few seconds late on iOS”): in logs `detectMs` (from bubble creation to detection) was 2-5 s because deep chat re-read was every 5 s; measured cost of a deep re-read of all 11 visible chats: ~25 ms. `CP_FULL_SCAN_MS` set to 1000 (~2.5% of one core): expected ~0.5-1.5 s.
 There is no artificial delay on the daemon -> SSE/push path; what remains is Cursor writing to the database and, for
 notification, send (`sendMs` ~0.6 s) plus Apple delivery (not measurable from here).
 After faster detection the user reports: push notification almost immediate, but the open chat page updates with
 ~10 s delay. Hypothesis (NOT verified, needs iPhone): the live stream (SSE) arrives late or in bursts (iOS, `tailscale serve`
 proxy), while the page depended on it for chat STATE (detail was already re-read every 1.5-4 s).
 Changes: the chat page now also re-reads `/api/state` each cycle (same cadence) and no longer depends on the stream;
 “Settings” has a “Connection diagnostics” box (stream active, count and age of SSE events, estimated
 Mac->phone delay with `at` added to the payload OUTSIDE the hash, updates found by periodic poll before the stream
 delivered them, daemon response time): it helps tell whether delay is in the stream, the network, or elsewhere.
 Follow-up optimization (user: page faster, but notification still arrives first; without loading the Mac): one watcher cycle without deep re-reads costs ~1.1 ms and a deep re-read of one chat 2-3 ms, so for a “watched”
 chat (any detail request keeps it warm for 15 s) or one just answered/written to (2 minutes) the watcher runs every
 250 ms and re-reads it each cycle (cost ~1.5% of one core, only in those periods); at rest it stays 1 cycle per second. The page, while
 waiting for the agent, re-reads every 1 s. Notification still stays one step ahead because it leaves the daemon without waiting for the
 page and without needing the question text.
 FOUND THE REAL BOTTLENECK (live measurement, test chat, read-only, field names and lengths only): the question bubble is born with `toolFormerData.status: "loading"`, WITHOUT `params`, but already with `toolCallBinary` (base64, ~300 characters =
 the same question serialized); `params` arrives ~27 s later (in other measurements 1.5-17 s, and for ~40 s or more in the worst case
 reported by the user), together with transition to `completed`. On Cursor the tray with options was visible immediately. The binary
 is a Protocol Buffers message: field 23 { field 1 { 1: title, 2 (repeated): question { 1: id, 2: text, 3 (repeated): option
 { 1: id, 2: label }, 4: multiple choice } } }, field 57 = toolCallId, field 59 = timestamp. No official schema: strict decoder
 in `daemon/src/cursor/questions.js` (`decodeQuestionBinary`; null on any doubt) used by `db.toolParams` when `params`
 is empty. Comparison with `params` on ALL real read-only questions from visible chats (80 bubbles per chat): 109 of 110
 identical (title, id, texts, options, multiple choice, multiple questions); the only remaining one has empty field 23 (args not
 written yet), so it falls back to waiting for `params`. Expected effect: text and options appear on the phone
 (and in the notification) as soon as the question is born, without the “preparing” phase.
 Zoom on text field tap on iOS (user report, fonts were already 16 px): added `maximum-scale=1` to the
 viewport, which on iOS 10+ prevents automatic zoom on focus but keeps two-finger zoom (accessibility). NOT verified on iPhone.

### 10.4d Tabs, favorites, and lighter pages (Oct 15) [OK in browser, NOT VERIFIED on iPhone]
- User choices: 4-item bar (“Attention”, Chat, “Favorites”, “Settings”), bar ALWAYS fixed at bottom, no explanatory
  notes on work screens (moved to “How it works”, under “Settings”), heart for favorites.
- “Attention” = requests to decide + chats in progress + “Pending”; Chat = groups by project like the sidebar, with search;
  “Favorites” = chats with the heart. Favorites and muted are LOCAL daemon preferences (`chat_prefs` in `store.db`,
  `POST /api/chats/:id/prefs {favorite?, muted?}`), they do not touch Cursor. Swipe a row: “Ignore” if it needs attention,
  otherwise the heart.
- Bottom bar: user reports that on iPhone it sometimes rises to mid-screen while scrolling the list. Not reproduced in
  test browsers (there it stays fixed). Defenses, ALL to try on the phone: own layer (`translate3d`, `will-change`) and
  realignment to the visual viewport bottom (`--vv-shift`, `bottomShift` in `viewport.js`, only without keyboard or zoom);
  with the keyboard open (search) the bar hides. If that is not enough: scroll inside an inner container with the bar
  outside the flow (more invasive: affects pull-to-refresh and scroll position).

### 10.4e Mute and quiet hours (Oct 15) [OK in test, NOT VERIFIED on iPhone]
- Per-chat mute (bell on the chat page), per-project (“Settings” > Muted projects; key
  `ws:<sectionId>` in `chat_prefs`) and time window (`quiet_hours` in `meta`, Mac local time, including across
  midnight; `GET/POST /api/settings/quiet`). Events are still marked as notified: when the window ends there is no
  flood of old alerts. The reason for dropping is in the log (`push_skipped {reason, kind}`), never the content.

### 10.4f Stop the agent from the phone (Oct 15) [OK on fake page and in browser, NOT VERIFIED on real Cursor]
- `POST /api/chats/:id/stop`: the daemon opens the chat in Cursor (CDP) and presses “Stop generation” (same send button, which with
  empty field and agent working changes label: FINDINGS 8). Only if the chat is running and has no live question or
  approval (409 `not_running` / `attention_pending`). Outcome: the button disappears (`settled`) or the chat reads as stopped
  from database state. In the log only `stop_agent {verified}`.
- PWA: in the composer, with empty field and agent working, the send button becomes “Stop” (square); requires a second tap
  within 4 s (turns red). When typing text it returns to “Invia” (Send). To verify live: label and position of the button in Cursor 3.x.

### 10.4g Paired devices and badge (Oct 15) [OK in test, NOT VERIFIED on iPhone]
- Settings > Paired devices (shown only with at least two devices): `GET /api/devices` (id = hash of hash of
  token, label, last access, notifications enabled; never token or hash) and `POST /api/devices/:id/revoke` (removes the session and
  its push subscriptions; the current device does not log out from here: for that there is “Esci” (Log out)). Two taps.
- Badge on the icon: already present since Phase 1 (`setAppBadge` from the service worker with the `badge` value from the push notification, and from the
  open page with the number of chats requiring attention). iOS limit: with the app closed the number changes only when a
  notification arrives (silent pushes do not exist): if you resolve a question on the Mac, the number updates on the next notification.

### 10.4h Full conversation, paginated (Oct 15) [OK in test, NOT VERIFIED on iPhone]
- `GET /api/chats/:id/history?before=<index>&limit=<n>` (limit 60, default 30): bubbles before the index, in chronological
  order, read ONLY by index from the `fullConversationHeadersOnly` list (never the full conversation, never a scan). User
  and assistant with text (truncated at 6000 characters, with `truncated`); tools as rows (action type and state, never commands or
  paths); empty bubbles skipped. Read-only: no action toward Cursor. Content never ends up in logs.
- PWA: `#/chat/<id>/storia` (link “Conversazione intera” (Full conversation) on the chat page): starts at the bottom, “Previous messages” loads
  the previous page while keeping the read position. Agent text in safe Markdown (no active links).

### 10.4i Keep Mac awake while an agent works (Oct 15) [OK in test; `caffeinate`, screen/battery/brightness reads verified manually; screen closed and `pmset` NOT VERIFIED]
- Optional, OFF by default (Settings > Keep Mac awake; `GET/POST /api/settings/awake` with `enabled`, `closed`, `dim`; state in `meta`).
- Level 1 (always, no permission): with at least one chat running, `caffeinate -i -m -s -w <daemon pid>`; after the last chat stays
  2 minutes (tolerance) then exits. Verified with `pmset -g assertions` (`PreventSystemSleep`, `PreventUserIdleSystemSleep`). The
  screen is NOT kept on (no `-d`). Closing the screen: `-s` applies only on charger (on battery macOS ignores it).
- Level 2 “even with screen closed and on battery”: `sudo -n pmset -a disablesleep 1|0` from the daemon, possible ONLY after
  `sudo tools/mac/power-setup.sh install` (sudoers rule allowing exactly those two commands; checked with `visudo -cf`;
  `uninstall` removes it). Reset to 0 with four protections: end of work, daemon shutdown, guard process
  (detached `/bin/sh` waiting for daemon death, even on SIGKILL), battery < 20% on battery (resumes above 25%).
  On startup the daemon repairs a leftover `disablesleep 1` or brightness from abrupt shutdown (flags in `meta`); during work
  sets back to 1 if someone sets 0. If it ever stays at 1: `sudo pmset -a disablesleep 0`.
- Brightness to zero: `tools/mac/build.sh` compiles `daemon/data/bin/cp-brightness` (Swift, undocumented DisplayServices; read successfully: 1.0). With screen closed (`ioreg AppleClamshellState = Yes`) and an agent working it goes to 0 saving the value
  (also in `meta` and in the guard); restored on open or end of work. Cannot test without actually closing the screen.

### 10.4j Rename, archive, restore (Oct 15) [VERIFIED LIVE on a test chat in Cursor; PWA NOT VERIFIED on iPhone]
- From a chat page: “Rename” (field with current name) and “Archive” (two taps, disabled if agent is working). From
  Settings > Archived chats: list with “Restore”. API: `POST /api/chats/:id/rename {name}`, `POST /api/chats/:id/archive`,
  `GET /api/archived`, `POST /api/archived/:id/restore`.
- Everything goes through the row context menu in the Cursor sidebar (right click via CDP, `Input.dispatchMouseEvent` with
  `button: 'right'`, `buttons: 2`): entries `Rename`, `Archive`, `Unarchive`. Rename = `input.ui-text-editable` field already selected,
  type and press Enter (focus verified before typing); outcome read from database (`composerHeaders.value.name`).
  Archive = `composerHeaders.isArchived` becomes 1 (read from database).
- Archived rows are not in the sidebar: restore turns on the “Archived” filter (“Customize Sidebar” menu, entry
  `menuitemcheckbox`), uses “Unarchive” and PUTS the filter back as it was (Cursor persistent setting). Verified live: returned to off.
- Live test (Test Chat): rename and revert to original name; archive -> `isArchived` true -> restore -> false, filter off.
- Not verified: archiving a chat with a pending question; a running chat is not archived (409 `running`).

### 10.4k Images attached to messages (Oct 15) [VERIFIED LIVE through real send with image; PWA NOT VERIFIED on iPhone]
- From the chat composer: “Allega immagini” (Attach images) button (up to 4). Each image is resized (long side 2048) and re-encoded as
  JPEG on the phone (HEIC and large photos become lightweight, location metadata stripped), then `POST /api/uploads` (body = bytes, type
  `image/*`); the daemon checks CONTENT (JPEG/PNG/GIF/WebP, max 8 MB, not declared type), saves in `daemon/data/uploads/`
  with random name and permissions 600, max 12 pending, 30 minute expiry, cleanup on every startup. `DELETE /api/uploads/:id`.
- `POST /api/chats/:id/message {text?, images?: [id]}`: text becomes optional if there is at least one image; after send files are
  deleted; if send fails they remain for retry (`image_expired` if expired). Logs only image count.
- In Cursor: the composer has an `input[type=file]` (accepts `image/*`, multiple) in the left bar; `DOM.setFileInputFiles` (with
  the input marked briefly with `data-cp-file-target`, then removed) shows preview `.ui-prompt-input-image-preview` with
  button `aria-label="Remove image"`. Verified live on Test Chat: 1 and 2 images attached, previews counted, removed one by
  one with the button, composer clean again. If something goes wrong after attach, images are removed.
- Mac draft never mixes: text draft OR images already present -> `draft_not_empty`.
- Real send with image: verified live together with new chat (10.4l): user bubble has `context.selectedImages` with 1 element
  (Cursor copies file to its folder) and the agent responded.

### 10.4l New local chat from the phone (Oct 15) [VERIFIED LIVE with one real message; PWA NOT VERIFIED on iPhone]
- From Chat tab, "+" at top: choose project (single-choice list, not a `<select>`: WebKit injects style and strict CSP flags it), write first message, attach images and “Avvia chat” (Start chat). `POST /api/chats {sectionId, text?, images?}`; the
  daemon derives project name from its own state (not from client). When done the PWA waits for the chat to appear in state and opens it.
- In Cursor: each sidebar project is a header `[data-section-head]` (text = folder name) with button
  `button[aria-label="New Agent"]` (shown on hover: `mouseMoved` first). Click opens “new chat” screen (no
  conversation panel) with three `.ui-select-trigger`: project (lowercase text), branch, environment. Environment options: “This Mac”,
  "This Mac (Self-Hosted Worker)", “Remote Machine”, “New Worktree”. The daemon checks project matches request and
  environment is “This Mac”; otherwise does NOT send (`wrong_project`, `not_local`, `project_not_found`, `project_ambiguous` if two headers
  share the same name). Composer is the same (`.ui-prompt-input-editor__input`, send “Send message”).
- ATTENTION: as soon as sent Cursor creates a “draft” row (header with `isDraft: true`, `isArchived: 1`, workspace `empty-window`, no
  bubble) and only after the real chat with a DIFFERENT id (`composerHeaders`: `isDraft` false, `agentLocation.type` local, name generated by
  Cursor). The daemon waits for new sidebar rows to stabilize (1,2 s and only one) and checks `isDraft`/`isArchived`.
  Bug found and fixed in live test (previously returned draft id).
- Live test: new chat on cursor-pocket with text and 1 image, 1 real message: chat created, text and image in bubble, agent
  responded; previously open chat selection restored; then archived via 10.4j rename/archive (also verified on a real chat).
- Removed projects: daemon does not show chats from removed projects; starting a chat on a project Cursor no longer shows returns
  `project_not_found`. A project with no local chats cannot be chosen from the phone (daemon knows projects from chats).

### 10.4m Pin chat (Oct 15) [VERIFIED LIVE on Cursor with test chat; PWA NOT VERIFIED on iPhone]
- Row menu (right click): Pin/Unpin, Rename, Edit Icon, Mark as Unread, Fork, Move to, Copy, Archive, Archive All Below. Entry toggles
  between “Pin” and “Unpin” by state.
- State is NOT in `composerHeaders` (no field) nor in `ItemTable` (no dedicated key): read from the page. Pinned chats
  sit at top of sidebar, BEFORE the first header `[data-section-head]`; pinned one leaves its project.
- The daemon looks in the menu ONLY for the entry for desired state (“Pin” to pin, “Unpin” to unpin): if menu shows the opposite it clicks nothing.
  `GET /api/chats/:id/pin` reads state (read-only page read), `POST /api/chats/:id/pin {pinned}` changes it. In the PWA the
  Pin/Unpin button appears in chat management panel after reading state once.
- Live test: initial state unpinned, pin, pinned state, repeat is no-op, unpin, final state unpinned (test chat restored).

### 10.4n Branch and model for new chat (Oct 15) [VERIFIED LIVE only WITHOUT sending; real send not verified; PWA NOT VERIFIED on iPhone]
- “New chat” screen: 3 `.ui-select-trigger` (project, branch, environment “This Mac”). Branch menu is `[role=listbox][aria-label="Select branch"]`
  with rows `[role=option]` and `[data-branch-name]`. Model is the button without aria-label in composer bar: menu has
  Context/Effort/Model; hovering “Model” opens submenu (Auto, MAX Mode, models, Add Models).
- Cursor REMEMBERS branch and model choice as default (verified live): daemon, after start, restores branch and model as they were.
  If choice or restore fail the chat does not start and Cursor returns to previous screen (tested with mock).
- API: `GET /api/projects/:sectionId/newchat-options` (opens and closes menus, changes nothing) and `POST /api/chats` with optional `branch`/`model`.
  In the PWA the “Choose branch and model” block loads lists on demand only; “Same as in Cursor” is the starting choice.
- Real test (Oct 15, with 1 message): new chat on cursor-pocket with EXPLICIT branch (master) and model choice (current ones, per user
  request not to change model): chat created, message in database, agent reply “ok”, branch and model unchanged after,
  chat selection restored. Archiving test chat: `archived` flag in database appears after a few seconds (not immediately).
- Verified live: reading lists and choosing + restoring model without sending messages. In test project only one branch (master),
  so branch choice verified only with mock.

### 10.4o Fixed bottom bar (Oct 15) [VERIFIED in WebKit/Chromium tests; real iPhone NOT VERIFIED]
- Report: the bar still moved occasionally (end-of-scroll bounce on iOS: visual viewport shifts relative to layout).
- Structural fix: on screens with the bar (lists, settings, help, archive) `body` is fixed and only `#app` scrolls
  (`pwa/js/scroll.js` picks the right container); document never scrolls, so no bounce that could move the bar.
  In chats (composer and keyboard) the window still scrolls. `--vv-shift` realignment remains as safety net.

### 10.4p Sending to the wrong chat, stray drafts, hidden sidebar, keyboard (Oct 15) [daemon part VERIFIED in tests and live for the sidebar; iPhone part NOT VERIFIED]
- Report: a message sent to chat 2 was typed into chat 1; the retry then failed with “draft not empty” because the draft WAS the message
  just typed. Daemon log: `send_disabled` followed by `draft_not_empty` seconds later. Cause: `#openChat` clicked the row but, if the
  selection did not change within ~2 s, went on anyway; and a failed send left the typed text in the composer.
- Fixes (`daemon/src/cursor/agents-ui.js`): the chat must really be open (2 click attempts, then `chat_not_open`, nothing typed);
  before typing, the foreground panel's `data-glass-agent-id` must equal the requested chat; after any failure the text THIS daemon typed
  is removed (Cmd+A, Backspace, only if the field still holds exactly that text); a leftover draft equal to the message or to what the
  daemon last typed in that chat is cleared automatically, anything else is the user's and still blocks (`draft_not_empty`).
- Follow-up report (same day): a message sent from the phone showed up in a second chat. Read-only check of the database (times and lengths
  only): the delivered user message sits in the requested chat at 02:40:27, while the daemon had logged `send_failed` at 02:40:31, i.e. the
  field was simply slow to clear (false negative; wait raised from 5 s to 10 s). The copy seen in the other chat is the text typed there
  while the wrong chat was in front (02:34), consistent with the fix above; not provable afterwards because the log carries no chat ids
  (by design). New last check: the foreground chat must still be the requested one right before pressing send.
- Hidden sidebar: the rows stay in the DOM with no size, and the toolbar button is `aria-label="Show Sidebar"` / `"Hide Sidebar"`.
  Actions that need rows now show it, and hide it again at the end (VERIFIED LIVE, state restored). The read-only pin probe never opens
  it, to avoid flicker on the Mac.
- Phone: the screenshot shows the iOS 26 floating accessory pill (arrows and checkmark) covering the bottom of the composer: the visual
  viewport does not include it. `viewport.js` adds `ACCESSORY_PILL_PX` (56) to the keyboard height on iPhone with Safari 26 features
  (CSS anchor positioning), a heuristic to confirm on the device and tune. The field is read-only (not disabled) while sending, and the
  send button does not take focus on press, so iOS does not drop the keyboard and move the button before the tap lands.

### 10.5 To verify live, with Cursor restarted with debug port [NOT VERIFIED]
Each item has ready diagnostics: `cd daemon && npm run cdp -- status | inspect | tray` (prints page structure
and never text).
1. `/json/list` really exposes the “Cursor Agents” page (title or URL with `glass`).
2. Shape of sidebar row keys (`row:<composerId>`), selected row marker, collapsed sections.
3. Questionnaire selectors on a real question: options, "Other...", freeform editor (how to type and clear),
   “Next”/“Continue”/“Skip” buttons.
4. Reliable clicks with Cursor in background (`Emulation.setFocusEmulationEnabled`).
5. How fast Cursor writes `submitted` to database (verification waits up to 12 s).
6. Composer: send with button, newline with Shift+Enter, draft already present.
7. Message to a chat that is working: does Cursor queue it or stop the run and send? Outcome text in PWA
   assumes queue (`queued` read from database).
8. “Dead” questions after Cursor restart (flag on but no questionnaire): today responds 409 `no_question`; verify
   whether to degrade to a new message.
9. Delay before database reflects a sent message (verify with `bubbleCount`).

### 10.6 Live test outcome (Oct 13, Cursor 3.24.6 restarted with debug port) [OK]
Test on a test chat created on purpose by the user (no work chats touched), with real daemon modules
(`createApp`, temp archive) and real database read-only.
- [OK] Port 9222 active; `/json/list` exposes ONE window, “Cursor Agents” (13 character title). Sidebar rows
  with key `row:<composerId>`.
- [OK] Questionnaire selectors (`.glass-questionnaire-tray`, `.ui-tray-option`, `.questionnaire-freeform-option`,
  `.ui-tray-footer__primary/secondary button`) correct first try. Tested and CONFIRMED from database (`submitted` with
  expected choices, action + verification in 3-4 s): single choice, multiple choice (two options), "Other..." with free text,
  two questions in one call (single + multiple).
- [OK] Free message to chat: written and sent, confirmed from database (`bubbleCount` increased) in about 0,5 s.
- Findings fake-page tests could NOT provide (fixed in `agents-ui.js`, with regression tests):
  1. Questionnaire `innerText` is EMPTY even when visible: need `textContent` (without it, question/screen match failed).
  2. Composer is not Lexical but tiptap/ProseMirror (`.ui-prompt-input-editor__input`). Send button label
     “Start voice input” when field empty, “Send message” with text, “Stop generation” while agent working.
  3. Cursor keeps panels for multiple chats alive (each `data-agent-panel-conversation-shell` with `data-glass-agent-id` =
     composerId); background ones inside `data-keep-alive-hidden` have their OWN composer. Composer, tray and
     send are now searched only in foreground panel (without it, text could land in wrong chat).
  4. No “selected row” marker in sidebar: open chat recognized from foreground panel.
- Bug found by user from iPhone (Oct 14): on an ignored or old question (over 24 h, “Pending” state) the PWA
  said “Per rispondere apri Cursor sul Mac” and options were not clickable, against the rule "reply even after hours or
  days". Fixed: if Cursor still has it open (`attention.live`) the reply module appears even for pending
  questions (title "(ignorata)" / "(non risolta da tempo)", button “Ignore” becomes “Restore”); if no longer open the
  daemon responds 409. Browser checks: 54 per run.
- Real latencies from log (`push_sent`): question detected in 0,9-4,5 s, notification send in 0,6-1,5 s.
- Not yet verified: “Skip”; message while chat is REALLY working (queue or interrupt: `queued` outcome read was
  false, but not certain chat was working then); clicks with Cursor in background; restore of chat user was viewing; whether a “dead” questionnaire after restart exists (question open at restart
  stayed clickable and reply arrived).
- To understand: right after a reply the chat still shows a “live” question for a few seconds and its parameters cannot
  be read (next bubble not complete yet): harmless (409 `stale`/`no_question`), but PWA may show it briefly.

### 10.4q Live check on Cursor 3.25.6 (Oct 15) [VERIFIED LIVE except approving a command and answering a question]
Cursor on this Mac updated from 3.24.6 to 3.25.6. With the debug port open, through the real daemon API (a temporary paired session,
removed afterwards) and a throwaway chat on the cheapest model ("Auto"):
- `npm run doctor`: sidebar rows, sidebar toggle, customize button, composer, send/stop button all found.
- New chat on a project (`POST /api/chats`, model "Auto"): created and sent (verified), the agent ran, the history was readable.
- Send a message to an existing chat: sent and verified. Archive from the row menu: verified.
- New-chat screen: branch and model lists read, dry run reaches the screen, the previously open chat is reopened.
- Question tray of a real pending question read WITHOUT answering it (3 options, free-form entry, both footer buttons found).
- NOT verified on 3.25.6: approving or rejecting a command (the terminal commands of the throwaway chat ran without asking: this Mac
  auto-runs them, and the settings were not changed to force it) and answering a question (the throwaway agent had no
  question tool). Both are verified on 3.24.6 (sections 10.6 and 11).
- Found: right after sending a message, the first right-click on the row for the menu was swallowed once (`ui_changed`, nothing
  changed in Cursor); a retry worked. `#rowMenu` now retries once.
- A 3-4 character draft showed up by itself in the composer of the throwaway chat and made the next send fail with
  `draft_not_empty` (the daemon correctly refused to overwrite it). The origin is NOT known (nothing the daemon did types that
  text); I cleared it in that throwaway chat and the next sends worked. Worth watching.

### 10.4r Compatibility with Cursor updates (Oct 16) [OK in test; real database checked read-only]
Prompted by a question from a user: how do writes reach Cursor, and what happens when an update moves the schema?
- Writes drive the real UI through CDP (not Cursor's IPC); the database (read-only) confirms afterwards. Without the debug port
  the app is read-only. This was already the case; what was missing were two things below.
- Gap 1, silent: a renamed column makes the queries throw (`db_unreadable`, already visible), but a MOVED JSON field makes
  `json_extract` return NULL and detection stops with no error. `cursor/compat.js` now looks at structure only: required columns,
  `composerData` bubble list type, the last bubble's `type`, and `toolFormerData.name`/`toolCallId` of tool bubbles, over the 5 most
  recent chats, by composerId. A reason needs EVERY sample to fail the same check. Checked against the real database on Cursor
  3.25.6: no reason raised (5 chats examined). Observed there: `agentLocation` is absent (not null) on classic chats, so it is
  NOT used as a canary.
- Gap 2: actions only found out about interface changes one failure at a time. Circuit breaker described in ARCHITECTURE.
- Release: `cursor/version.js` reads `Cursor.app/Contents/Resources/app/package.json`; outside the tested list is a notice.
- NOT verified: behavior against a REAL Cursor update (the breaker and the layout check are tested with fakes and a synthetic
  database, and the layout check against the current real one).

## 11. Tool approvals (“Allow”/“Run”): signal, rules, and what is NOT verified
User request (Oct 12): in one of their projects a chat had stopped waiting for an “allow” (because of a hook) and no
notification had arrived: can this be notified too?

### 11.1 The signal [OK] [CODE]
- [OK] In a tool bubble, `toolFormerData.additionalData` has the key `reviewData` (and, if a hook is involved,
  `blockReason`) ONLY when human review is involved: 2 bubbles out of 5274 checked (query by `composerId`, no
  full scan). One is a terminal command from chat `6814061b`, created at 17:19:49, followed by the next bubble
  only 67 s later (17:20:56): matches the wait reported by the user (around 17:20-17:21).
- [OK] Shape of a RESOLVED review (command approved by the user): `reviewData: { approvalType: "user", selectedOption: "run",
  status: "Done", allowlistOptions: [], candidatesForAllowlist: [], defaultAllowlistOptionIds: [], hasClassifierSuggestions:
  false, isShowingInput: false, selectedAllowlistOptionIds: [] }`. `blockReason` is a string produced by the hook (contains
  the word “hook”); the text is neither echoed nor read in the daemon: it may contain commands.
- [CODE] `reviewData.status` is an enum with three values: `None`, `Requested`, `Done`. Cursor searches on its own, among the LAST TWO
  bubbles (`getLastBubbleWithReviewStatusFromLast2Bubbles`), for a tool with `status === "Requested"` among: EDIT_FILE,
  EDIT_FILE_V2, RUN_TERMINAL_COMMAND_V2, MCP, CALL_MCP_TOOL, READ_MCP_RESOURCE, CREATE_PLAN, WEB_FETCH.
- [CODE] `reviewData.approvalType` is an enum: `user`, `allowlist`, `full_auto`, `none`; `selectedOption`: `run`, `skip`,
  `allowlistCommands`, `rejectAndTellWhatToDoDifferently`, `edit`. In automatic mode Cursor writes
  `approvalType: full_auto` itself and selects `run` (function `_autoApproveAllComposersInMode`, which iterates bubbles with
  `reviewData.status === "Requested"`): for this reason `allowlist` and `full_auto` do not count as pending.
- [CODE] Indication that `Requested` is written in composer data (therefore in the database) and survives a reload: a
  cleanup function for pending tools has an option `preservePendingApprovals` that skips bubbles with `reviewData.status`
  `Requested` or `Done`. It does not prove WHEN it is written (11.4).
- [OK] A `create_plan` stays `Requested` for hours until the plan is approved: it is the `piano` case
  (it has its own flag `hasPendingPlan`), excluded from the new rule.
- [OK] The user's hook is per-project (`.cursor/hooks.json`, event `beforeShellExecution`, execution at “failClosed”) and
  responds `permission: "ask"` to commands outside policy, i.e. asks the user for approval: that is the cause of the wait. There is
  no global hook (`~/.cursor/hooks.json`).

### 11.2 Rules adopted [DECISION]
- Request type `approvazione`: the last or second-to-last bubble is a tool (not `ask_question`, not `create_plan`) with
  `reviewData.status === "Requested"` and `approvalType` other than `allowlist` and `full_auto` (a missing or unknown type does not
  exclude). Key = `toolCallId` (same deduplication as questions).
- It is “live” if the flag `hasBlockingPendingActions` is on, or the chat is working (the agent is stopped waiting for you),
  or the bubble is recent (less than 120 s: Cursor's header arrives late, 9.7). A `Requested` in an idle chat,
  without flag and old is a leftover (Cursor closed mid-way) and does not count.
- The notification fires only if the request is still pending after `CP_APPROVAL_DELAY_SECONDS` (8 s): whoever is at the Mac and
  approves immediately receives nothing. While waiting the chat is re-read every second. One notification per request, no
  reminders. At daemon startup the same rules as for questions apply (recent yes, old only in the app).
- The notification text and the PWA report only the TYPE of action (“Comando da eseguire” (Command to run), “Modifica di un file”, "Strumento
  MCP", “Richiesta web”, “Azione da approvare”): never the command, paths, or hook text.
- From the PWA you approve or reject ONLY a terminal command (11.5); for every other request type the panel says to
  decide on the Mac. “Ignore” works as for questions, and a message from the phone with a pending approval is rejected
  (409 `approval_pending`).
- The log records `approval_seen` (bubble age, chat in progress, flag, startup) and `approval_gone` (seconds waited, whether it was
  notified): numbers and booleans only. Used to close 11.4 and measure how long waits last. Every `push_sent`
  also carries `detectMs` (from start of request to notification; for approvals includes the 8 s delay) and `sendMs`
  (send duration): first measurement in seconds of true latency, for questions and approvals.

### 11.3 What was verified
- [OK] Automated tests with synthetic bubbles in the observed shape (suite 176/176): wait before notifying, one event
  per request and new event for a new request, approval given from the Mac before the delay (no notification),
  request already present at startup (recent and old), residuo, second-to-last bubble, no “chat finita” while waiting,
  command and identifiers never in payload or log, tools without `reviewData` always `residuo`, message rejected.
- [OK] On the real database (read-only, counts only): 35 visible chats, 0 classified approvals: no false positives
  (the 2 existing `reviewData` are `Done`).
- [OK] PWA: demo chat with an approval in WebKit and Chromium, light and dark theme (`tools/ui-check.mjs`).

### 11.4 Proof with a real approval (Oct 13) [OK] and what remains [NOT VERIFIED]
- [OK] Real approval on Oct 13 (user's hook, one of their projects): in the log `approval_seen` with `{ageSec: 16, running:
  true, flag: false}`, after 8 s wait `push_sent kind=approvazione` (`detectMs` 24223, `sendMs` 624), at decision
  `approval_gone {waitedSec: 92, notified: true}`. So `reviewData.status: "Requested"` IS written to the database
  DURING the wait and the signal works; `hasBlockingPendingActions` does NOT turn on for approvals (the rule does not
  require it); the chat is “in progress” (`running`).
- The bubble was already 16 s old when the daemon saw it (then +8 s wait = 24 s at notification): unknown whether the cause is
  hook time, delayed Cursor write, or scanning. To measure with other approvals.
- That the notification arrived on the iPhone only the user can confirm.

### 11.5 Approve or reject from the phone (Oct 15) [OK on live reject, “Run” NOT VERIFIED LIVE]
- Cursor: the command card is `.ui-shell-tool-call` inside the row with `data-message-id` = bubble id in the database; buttons
  are recognized by text (Run/Esegui and Skip/Salta, English and Italian Cursor). `AgentsUi.approval` opens the chat, finds the card for THAT
  bubble (if missing or has other buttons: error, no click) and presses the button.
- Daemon: `POST /api/chats/:id/approval {key, decision: approve|reject}`. Rejects stale key (`stale`), non-terminal
  tool (`unsupported`), feature off (`CP_APPROVALS=0`, `approvals_disabled`). Chat detail carries
  `approval {key, type, supported, command, description}`: the COMMAND appears only from this authenticated API (max 2000
  characters), never from notifications and logs (the log has `approval_decision {decision, verified}`).
- PWA: command in monospace + description, “Run” and “Reject” buttons with TWO taps (the first arms the button
  for 5 s, the second sends: a wrong tap executes nothing on the Mac).
- Live test (Oct 15, on a real pending request; on the Mac the user was not using the chat): reject clicked the
  right card and the agent continued. In the database: right after the click the bubble stays `loading` with `reviewData.status:
  "Requested"` and `selectedOption: "rejectAndTellWhatToDoDifferently"`; the daemon response was `verified:false` because
  after 10 s nothing else had changed. Shortly after (within about a minute) the bubble shows `status: "completed"` with
  `additionalData.status: "rejected"` and the agent, rejected, retried with a new command (new bubble, new
  `Requested` request, therefore new approval to decide). Conclusion: `reviewData.status` does NOT go to `Done` on
  reject; outcome write is delayed. Daemon confirmation accepts the card closing in Cursor (`settled`), `status != loading` or "the request is no longer
  current attention", but within 10 s it can still show `verified:false` with a successful decision: the PWA says so
  (“non riesco ancora a confermare” (I still can't confirm)) without treating it as an error.
- [NOT VERIFIED LIVE] “Run”: the command for that request would run `git add -A && git commit` in another of the user's
  projects, so it was NOT approved for testing. The code path is the same as reject (only the button changes), but the
  outcome in the database is not observed.

#### History: what was not verified before

- That during the wait the database actually contains `reviewData.status: "Requested"` for a terminal command: the two
  `reviewData` seen were already `Done`. If Cursor kept the request only in memory until the decision, the daemon would
  see nothing during the wait (no error and no notification: the previous situation). The bundle suggests it is
  written (the function that searches for it reads composer bubbles) but does not prove WHEN.
- Whether `hasBlockingPendingActions` turns on for approvals, and whether `unfinishedRunAt` stays set during the wait (the
  rule requires neither: a recent bubble or chat in progress is enough).
- How to verify: at the next real wait the log shows `approval_seen` (if present, the signal works) and, after 8 s,
  `push_sent kind=approvazione`; at decision `approval_gone`. If the wait happened but the log shows nothing, the
  signal is not persisted and another path is needed (for example Cursor's interface via CDP).
