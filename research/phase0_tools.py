#!/usr/bin/env python3
"""
Phase 0 - vocabulary of tool states in recent bubbles (READ ONLY, mode=ro).
For the N most recent chats reads the last K bubbles (exact keys) and counts combinations
(tool name, toolFormerData.status, additionalData.status). No content, no parameters.
"""
import collections, json, os, sqlite3, sys

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")
C = collections.Counter


def connect():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    return con


def kv(con, key):
    r = con.execute("select value from cursorDiskKV where key=?", (key,)).fetchone()
    if not r or r[0] is None:
        return None
    v = r[0].decode("utf8", "replace") if isinstance(r[0], bytes) else r[0]
    try:
        return json.loads(v)
    except Exception:
        return None


def main():
    n_chats = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    con = connect()
    ids = []
    for cid, val in con.execute(
            "select composerId, value from composerHeaders where isArchived=0 and isSubagent=0 order by recency desc"):
        if not (json.loads(val).get("isDraft")):
            ids.append(cid)
        if len(ids) >= n_chats:
            break
    combos = C()
    other_keys = C()
    n_bubbles = 0
    for cid in ids:
        cd = kv(con, f"composerData:{cid}")
        if not cd:
            continue
        for h in (cd.get("fullConversationHeadersOnly") or [])[-k:]:
            b = kv(con, f"bubbleId:{cid}:{h['bubbleId']}")
            if not b:
                continue
            n_bubbles += 1
            tf = b.get("toolFormerData")
            if not tf:
                continue
            ad = tf.get("additionalData")
            combos[(tf.get("name"), tf.get("status"), ad.get("status") if isinstance(ad, dict) else None)] += 1
            if isinstance(ad, dict):
                for key in ad:
                    other_keys[(tf.get("name"), key)] += 1
    print(f"chats: {len(ids)} | bubbles read: {n_bubbles}")
    print("\n(tool, toolFormerData.status, additionalData.status) -> count")
    for key, n in sorted(combos.items(), key=lambda kv: (str(kv[0][0]), -kv[1])):
        print(f"  {n:5d}  {key}")
    print("\nadditionalData keys per tool (tools with non-completed/success status only):")
    shown = C()
    for (name, key), n in other_keys.most_common():
        shown[name] += 1
        if shown[name] <= 6:
            print(f"  {name:32s} {key:28s} {n}")


if __name__ == "__main__":
    main()
