#!/usr/bin/env python3
"""
Fase 0 - correlazione tra hasBlockingPendingActions e lo stato reale dell'ultimo bubble (SOLA LETTURA, mode=ro).
Per ogni chat interrogata si usano solo chiavi esatte (composerData:<id>, bubbleId:<id>:<bubble>).
Stampa solo metadati (tipi, nomi di tool, stati): niente titoli, niente testo dei messaggi.
"""
import collections, json, os, sqlite3, sys, time

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
    v = r[0]
    if isinstance(v, bytes):
        v = v.decode("utf8", "replace")
    try:
        return json.loads(v)
    except Exception:
        return None


def last_bubble(con, cid, cd):
    hs = (cd or {}).get("fullConversationHeadersOnly") or []
    if not hs:
        return None, 0
    b = kv(con, f"bubbleId:{cid}:{hs[-1]['bubbleId']}")
    return b, len(hs)


def summarize(con, h, now):
    cid = h["composerId"]
    cd = kv(con, f"composerData:{cid}")
    b, n = last_bubble(con, cid, cd)
    tf = ((b or {}).get("toolFormerData") or {})
    ad = tf.get("additionalData") or {}
    return {
        "cid": cid,
        "age_h": round((now - max(h["lastUpdatedAt"] or 0, h["recency"] or 0)) / 3600000, 1),
        "arch": int(h["isArchived"] or 0),
        "loc": ((h["j"].get("agentLocation") or {}).get("type")) or "null",
        "flag": h["j"].get("hasBlockingPendingActions", "assente"),
        "unread": h["j"].get("hasUnreadMessages", "assente"),
        "cd_status": (cd or {}).get("status", "<no cd>") if cd else "<no cd>",
        "n_bub": n,
        "last_type": (b or {}).get("type", "-"),
        "last_tool": tf.get("name", "-"),
        "last_tool_status": tf.get("status", "-"),
        "last_ad_status": ad.get("status", "-") if isinstance(ad, dict) else "?",
        "gen": len((cd or {}).get("generatingBubbleIds") or []),
        "queue": len((cd or {}).get("queueItems") or []),
    }


def main():
    con = connect()
    now = int(time.time() * 1000)
    cols = ["composerId", "lastUpdatedAt", "isArchived", "isSubagent", "recency", "value"]
    hs = []
    for r in con.execute("select " + ",".join(cols) + " from composerHeaders"):
        d = dict(zip(cols, r))
        d["j"] = json.loads(d["value"]) if d["value"] else {}
        hs.append(d)

    print("== 1) tutte le chat con hasBlockingPendingActions=true ==")
    flagged = [h for h in hs if h["j"].get("hasBlockingPendingActions")]
    rows = [summarize(con, h, now) for h in sorted(flagged, key=lambda h: -(h["recency"] or 0))]
    hdr = ["age_h", "arch", "loc", "flag", "unread", "cd_status", "n_bub", "last_type", "last_tool", "last_tool_status",
           "last_ad_status", "gen", "queue"]
    print(" | ".join(hdr))
    for r in rows:
        print(" | ".join(str(r[k]) for k in hdr))

    print("\n== 2) le 60 chat non archiviate/non sottoagenti piu' recenti: ultimo bubble vs flag ==")
    recent = sorted([h for h in hs if not h["isArchived"] and not h["isSubagent"]], key=lambda h: -(h["recency"] or 0))[:60]
    t0 = time.time()
    rows2 = [summarize(con, h, now) for h in recent]
    print(f"(scansione di {len(recent)} chat in {time.time()-t0:.2f}s)")
    print("combinazioni (flag, ultimo tool, stato tool, additionalData.status):")
    for k, n in C((r["flag"], r["last_tool"], r["last_tool_status"], r["last_ad_status"]) for r in rows2).most_common():
        print(f"  {n:3d}  {k}")
    print("composerData.status:", dict(C(r["cd_status"] for r in rows2)))
    print("tipo ultimo bubble:", dict(C(r["last_type"] for r in rows2)))
    print("generatingBubbleIds non vuoto:", sum(1 for r in rows2 if r["gen"]), "- queueItems non vuoto:", sum(1 for r in rows2 if r["queue"]))

    print("\n== 3) pending 'ask_question' (loading) trovate nelle 60 chat recenti ==")
    for r in rows2:
        if r["last_tool"] == "ask_question" and r["last_tool_status"] == "loading":
            print(f"  age_h={r['age_h']} arch={r['arch']} loc={r['loc']} flag={r['flag']} cd_status={r['cd_status']}")


if __name__ == "__main__":
    main()
