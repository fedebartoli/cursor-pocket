# Testing on a real iPhone

Everything below was tested in WebKit/Chromium and on real Cursor via CDP, but NOT on a physical iPhone.
Check off each line; if something fails, note the screen and what you expected (update `docs/FINDINGS.md` with the outcome).

Preparation: Mac on with Cursor started with `tools/cursor-cdp.sh`, daemon running (`tools/launchd.sh status`), PWA opened from the
Home screen (not from Safari). For agent tests use a test chat, not real work.

## 1. Installation and pairing
- [ ] The PWA launches full screen (no Safari bars), with the correct icon.
- [ ] Startup: no black screen or endless skeleton; if the Mac is unreachable, "Daemon non raggiungibile" ("Daemon unreachable") appears with "Riprova" ("Retry") within ~15 s.
- [ ] Pairing with the code from `npm run pair`; after closing and reopening the app it does not ask for the code again.

## 2. Bottom bar and scrolling
- [ ] The bar (Attenzione (Attention), Chat, Preferite (Favorites), Impostazioni (Settings)) stays fixed while you scroll and on bounce at the start and end of the list.
- [ ] Tap the search field (keyboard up and down): the bar hides with the keyboard and returns to place, never halfway up the screen.
- [ ] When switching tabs the list restores its previous scroll position.
- [ ] Pulling down from the top of the list refreshes (pull-to-refresh gesture).
- [ ] Double tap: no zoom. Pinch with two fingers: zoom allowed.

## 3. Notifications (app closed and screen locked)
- [ ] Notification permission granted from Impostazioni (Settings).
- [ ] Agent question: the notification arrives; tapping it opens that chat.
- [ ] Command approval: the notification arrives with clear text.
- [ ] Chat finished: the notification arrives.
- [ ] The red badge on the app icon matches pending decisions and decreases when you resolve them.
- [ ] Muted chats or projects, and quiet hours: nothing arrives.

## 4. Actions on a chat
- [ ] Answer a question (single choice, multiple choice, "Altro" ("Other") with text): Cursor records the answer.
- [ ] "Ignora" ("Dismiss") (including by swiping the row): the dot disappears, nothing changes in Cursor; "Ripristina" ("Restore") brings it back.
- [ ] Write a message with the composer above the keyboard, including with an attached image.
- [ ] "Ferma" ("Stop") the agent while it is working.
- [ ] Approve or reject a command.
- [ ] Rinomina (Rename), Fissa/Togli (Pin/Unpin), Archivia (Archive), and Ripristina from the panel at the bottom of the chat.
- [ ] Heart: the chat appears in Preferite.
- [ ] Full conversation (read-only): scrolls, "Messaggi precedenti" ("Earlier messages") loads more chunks.

## 5. New chat
- [ ] "+" on the Chat tab: choose project, write, start: the chat appears and opens.
- [ ] "Scegli ramo e modello" ("Choose branch and model"): lists come from Cursor; "Come in Cursor" ("Same as Cursor") is the default. With another choice the chat starts
      with that one, and afterward Cursor has its previous values again.

## 6. Mac sveglio (Keep Mac awake) and reliability
- [ ] Impostazioni > Mac sveglio: on, with an agent working the Mac does not sleep; off, behavior returns to normal.
- [ ] With the `sudo` rule installed and the lid closed, the agent keeps working.
- [ ] After one or two days the PWA is still paired and notifications still arrive.
- [ ] After changing network (Wi-Fi/5G) the app reconnects on its own.

## 7. Devices
- [ ] Impostazioni > Dispositivi abbinati (Paired devices): the phone is listed; "Scollega" ("Disconnect") on a second test device disconnects it.

## 8. Languages
Interface labels in this list are quoted in Italian with the English meaning in parentheses; on your phone they follow its language.
- [ ] With the phone in a supported language, "Automatic" (Settings > Language) shows the app in that language, including the tab bar.
- [ ] Choose another language in Settings: the app reloads and every screen, error message and notification switches (notifications
      follow the language of the device that subscribed; reopen the app once so it re-sends the language).
- [ ] German, French and Japanese: no label is cut off in the bottom bar or on the buttons of the narrowest iPhone you own.
