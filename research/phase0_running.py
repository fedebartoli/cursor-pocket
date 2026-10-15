#!/usr/bin/env python3
"""
Phase 0 - which chats appear "in progress" (unfinishedRunAt set) and how they look (READ ONLY, mode=ro).
Metadata only, no titles or content.
"""
import collections, json, os, sqlite3, time

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
    con = connect()
    now = int(time.time() * 1000)
    rows = []
    keys = C()
    for cid, arch, sub, rec, val in con.execute(
            "select composerId, isArchived, isSubagent, recency, value from composerHeaders"):
        j = json.loads(val) if val else {}
        for k in j:
            keys[k] += 1
        rows.append((cid, arch, sub, rec, j))
    print("keys present in headers (row count):")
    print("  ", dict(sorted(keys.items(), key=lambda kv: -kv[1])))

    print("\n== headers with unfinishedRunAt ==")
    for cid, arch, sub, rec, j in sorted(rows, key=lambda r: -(r[3] or 0)):
        if "unfinishedRunAt" in j:
            cd = kv(con, f"composerData:{cid}") or {}
            print(f"  last_update_age={ (now-(j.get('lastUpdatedAt') or rec or 0))/60000:.1f} min | "
                  f"unfinished={ (now-j['unfinishedRunAt'])/60000:.1f} min ago | arch={arch} sub={sub} "
                  f"loc={(j.get('agentLocation') or {}).get('type')} flag={j.get('hasBlockingPendingActions')} "
                  f"cd.status={cd.get('status')} gen={len(cd.get('generatingBubbleIds') or [])}")

    print("\n== 6 most recent chats (any state), metadata ==")
    for cid, arch, sub, rec, j in sorted(rows, key=lambda r: -(r[3] or 0))[:6]:
        cd = kv(con, f"composerData:{cid}") or {}
        print(f"  age={ (now-(rec or 0))/60000:.1f} min | arch={arch} sub={sub} draft={j.get('isDraft')} "
              f"loc={(j.get('agentLocation') or {}).get('type')} flag={j.get('hasBlockingPendingActions')} "
              f"unread={j.get('hasUnreadMessages')} unfinished={'unfinishedRunAt' in j} "
              f"cd.status={cd.get('status')} bubbles={len(cd.get('fullConversationHeadersOnly') or [])}")


if __name__ == "__main__":
    main()
