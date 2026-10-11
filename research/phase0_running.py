#!/usr/bin/env python3
"""
Fase 0 - quali chat risultano "in corso" (unfinishedRunAt presente) e come si presentano (SOLA LETTURA, mode=ro).
Solo metadati, nessun titolo/contenuto.
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
    print("chiavi presenti negli header (conteggio righe):")
    print("  ", dict(sorted(keys.items(), key=lambda kv: -kv[1])))

    print("\n== header con unfinishedRunAt ==")
    for cid, arch, sub, rec, j in sorted(rows, key=lambda r: -(r[3] or 0)):
        if "unfinishedRunAt" in j:
            cd = kv(con, f"composerData:{cid}") or {}
            print(f"  eta'_ultimo_agg={ (now-(j.get('lastUpdatedAt') or rec or 0))/60000:.1f} min | "
                  f"unfinished={ (now-j['unfinishedRunAt'])/60000:.1f} min fa | arch={arch} sub={sub} "
                  f"loc={(j.get('agentLocation') or {}).get('type')} flag={j.get('hasBlockingPendingActions')} "
                  f"cd.status={cd.get('status')} gen={len(cd.get('generatingBubbleIds') or [])}")

    print("\n== le 6 chat piu' recenti (qualsiasi stato), metadati ==")
    for cid, arch, sub, rec, j in sorted(rows, key=lambda r: -(r[3] or 0))[:6]:
        cd = kv(con, f"composerData:{cid}") or {}
        print(f"  eta'={ (now-(rec or 0))/60000:.1f} min | arch={arch} sub={sub} draft={j.get('isDraft')} "
              f"loc={(j.get('agentLocation') or {}).get('type')} flag={j.get('hasBlockingPendingActions')} "
              f"unread={j.get('hasUnreadMessages')} unfinished={'unfinishedRunAt' in j} "
              f"cd.status={cd.get('status')} bubbles={len(cd.get('fullConversationHeadersOnly') or [])}")


if __name__ == "__main__":
    main()
