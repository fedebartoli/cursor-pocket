#!/usr/bin/env python3
"""
Research prototype (only `pending` verified live; the rest NOT tested on a real instance).
Standard library only. Used to answer native Agents Window AskQuestion prompts via CDP.

Prerequisite for CDP commands: Cursor started with --remote-debugging-port=9222 (see launch-cursor-cdp.sh).

Commands:
  pending            read native pending questions from the DB (last ask_question bubble with loading state)
  sidebar            list sidebar chat rows (data-sidebar-item-key, text, selected)
  tray               describe the visible questionnaire (text, options, buttons)
  open <composerId>  select the chat in the sidebar
  answer <json>      answer the visible questionnaire, e.g.:
                     '{"selections":[["A"]],"freeform":{"0":"text"},"submit":true}'
                     selections[i] = badge (A, B, ...) or label of options for step i
"""
import base64, json, os, socket, sqlite3, struct, sys, urllib.request

PORT = int(os.environ.get("CURSOR_CDP_PORT", "9222"))
DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")


# ---------- minimal websocket ----------
def _ws(url):
    hp, path = url[5:].split("/", 1)
    host, port = hp.split(":")
    s = socket.create_connection((host, int(port)), timeout=15)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hp}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(1)
    return s


def _send(s, obj):
    d = json.dumps(obj).encode()
    h = bytearray([0x81])
    n = len(d)
    if n < 126:
        h.append(0x80 | n)
    elif n < 65536:
        h.append(0x80 | 126)
        h += struct.pack(">H", n)
    else:
        h.append(0x80 | 127)
        h += struct.pack(">Q", n)
    m = os.urandom(4)
    h += m
    s.sendall(bytes(h) + bytes(b ^ m[i % 4] for i, b in enumerate(d)))


def _recv(s):
    def rd(n):
        b = b""
        while len(b) < n:
            c = s.recv(n - len(b))
            if not c:
                raise EOFError
            b += c
        return b
    msg = b""
    while True:
        b1, b2 = rd(2)
        n = b2 & 127
        if n == 126:
            n = struct.unpack(">H", rd(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", rd(8))[0]
        msg += rd(n)
        if b1 & 0x80:
            return msg.decode("utf8", "replace")


class Page:
    def __init__(self):
        ts = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
        pages = [t for t in ts if t["type"] == "page"]
        agents = [t for t in pages if "Agents" in t.get("title", "")] or pages
        self.s = _ws(agents[0]["webSocketDebuggerUrl"])
        self.i = 0

    def call(self, method, params=None):
        self.i += 1
        _send(self.s, {"id": self.i, "method": method, "params": params or {}})
        while True:
            r = json.loads(_recv(self.s))
            if r.get("id") == self.i:
                return r

    def js(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            raise RuntimeError(res["exceptionDetails"].get("text", "js error"))
        return res.get("result", {}).get("value")

    def type_text(self, text):
        self.call("Input.insertText", {"text": text})


# ---------- page-side JS (selectors to verify live) ----------
JS_TRAY = r"""
(() => {
  const tray = document.querySelector('.glass-questionnaire-tray');
  if (!tray) return null;
  const opts = [...tray.querySelectorAll('button.ui-tray-option')].map((b, i) => ({
    i,
    badge: b.querySelector('.ui-tray-option__badge')?.textContent?.trim() ?? null,
    label: b.querySelector('.ui-tray-option__label')?.textContent?.trim() ?? null,
    freeform: b.classList.contains('questionnaire-freeform-option'),
    selected: b.getAttribute('data-selected') !== null || b.getAttribute('aria-pressed') === 'true',
  }));
  const btns = [...tray.querySelectorAll('button')].filter(b => !b.classList.contains('ui-tray-option'))
    .map(b => b.textContent.trim()).filter(Boolean);
  return { text: tray.innerText.slice(0, 1500), options: opts, buttons: btns };
})()
"""

JS_SIDEBAR = r"""
(() => [...document.querySelectorAll('[data-sidebar-item-key]')].map(e => ({
  key: e.getAttribute('data-sidebar-item-key'),
  text: (e.innerText || '').split('\n')[0].slice(0, 80),
  selected: e.matches('[aria-selected="true"],[data-selected],[data-sidebar-selected-static-row]') ||
            !!e.querySelector('[data-sidebar-selected-static-row]'),
})))()
"""


def js_click_option(badge_or_label):
    q = json.dumps(badge_or_label)
    return f"""
(() => {{
  const tray = document.querySelector('.glass-questionnaire-tray'); if (!tray) return 'no-tray';
  const want = {q}.toLowerCase();
  const b = [...tray.querySelectorAll('button.ui-tray-option')].find(x => {{
    const bd = (x.querySelector('.ui-tray-option__badge')?.textContent || '').trim().toLowerCase();
    const lb = (x.querySelector('.ui-tray-option__label')?.textContent || '').trim().toLowerCase();
    return bd === want || lb === want;
  }});
  if (!b) return 'no-option';
  b.click(); return 'clicked';
}})()
"""


JS_FOCUS_FREEFORM = r"""
(() => {
  const tray = document.querySelector('.glass-questionnaire-tray'); if (!tray) return 'no-tray';
  const f = tray.querySelector('.questionnaire-freeform-option');
  if (!f) return 'no-freeform';
  f.click();
  const ed = f.querySelector('[contenteditable="true"], .ProseMirror, input[type="text"]');
  if (!ed) return 'no-editor';
  ed.focus(); return 'focused:' + ed.tagName;
})()
"""

JS_PRIMARY = r"""
(() => {
  const tray = document.querySelector('.glass-questionnaire-tray'); if (!tray) return 'no-tray';
  const b = tray.querySelector('.ui-tray-footer__primary button'); if (!b) return 'no-primary';
  if (b.disabled) return 'disabled:' + b.textContent.trim();
  const label = b.textContent.trim(); b.click(); return 'clicked:' + label;
})()
"""


def cmd_pending():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    ids = [r[0] for r in con.execute(
        "select composerId from composerHeaders where coalesce(isArchived,0)=0 and coalesce(isSubagent,0)=0 "
        "order by lastUpdatedAt desc limit 40")]
    out = []
    for cid in ids:
        r = con.execute("select value from cursorDiskKV where key=?", (f"composerData:{cid}",)).fetchone()
        if not r:
            continue
        d = json.loads(r[0])
        hs = d.get("fullConversationHeadersOnly") or []
        if not hs:
            continue
        b = con.execute("select value from cursorDiskKV where key=?",
                        (f"bubbleId:{cid}:{hs[-1]['bubbleId']}",)).fetchone()
        if not b:
            continue
        tf = (json.loads(b[0]).get("toolFormerData") or {})
        if tf.get("name") == "ask_question" and tf.get("status") == "loading":
            out.append({"composerId": cid, "name": d.get("name"), "toolCallId": tf.get("toolCallId"),
                        "params": json.loads(tf.get("params") or "{}")})
    print(json.dumps(out, ensure_ascii=False, indent=1))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "tray"
    if cmd == "pending":
        return cmd_pending()
    p = Page()
    if cmd == "sidebar":
        print(json.dumps(p.js(JS_SIDEBAR), ensure_ascii=False, indent=1))
    elif cmd == "tray":
        print(json.dumps(p.js(JS_TRAY), ensure_ascii=False, indent=1))
    elif cmd == "open":
        key = json.dumps(sys.argv[2])
        print(p.js("(() => { const k = " + key + "; const e = [...document.querySelectorAll('[data-sidebar-item-key]')]"
                   ".find(x => x.getAttribute('data-sidebar-item-key') === k); if (!e) return 'not-found';"
                   " (e.querySelector('button,[role=button],a') || e).click(); return 'clicked'; })()"))
    elif cmd == "answer":
        spec = json.loads(sys.argv[2])
        sels = spec.get("selections", [])
        for step, sel in enumerate(sels):
            for o in sel:
                print("select", o, p.js(js_click_option(o)))
            ff = spec.get("freeform", {}).get(str(step))
            if ff:
                print("focus", p.js(JS_FOCUS_FREEFORM))
                p.type_text(ff)
            if step < len(sels) - 1:
                print("next", p.js(JS_PRIMARY))
        if spec.get("submit", True):
            print("submit", p.js(JS_PRIMARY))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
