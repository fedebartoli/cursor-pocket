#!/usr/bin/env python3
"""
Phase 0 - cross-tab of header fields (READ ONLY, mode=ro). Aggregate counts only.
"""
import collections, json, os, sqlite3, time

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")
C = collections.Counter


def connect():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    return con


def load():
    con = connect()
    cols = ["composerId", "workspaceId", "createdAt", "lastUpdatedAt", "isArchived", "isSubagent", "recency",
            "checkpointAt", "value"]
    out = []
    for r in con.execute("select " + ",".join(cols) + " from composerHeaders"):
        d = dict(zip(cols, r))
        d["j"] = json.loads(d["value"]) if d["value"] else {}
        out.append(d)
    return out


def loc_type(h):
    a = h["j"].get("agentLocation")
    if a is None:
        return "null"
    env = a.get("environment") or {}
    kind = "empty-window" if env.get("id") == "empty-window" else ("uri" if "uri" in env else "env-no-uri")
    return f"{a.get('type')}/{a.get('status')}/{kind}"


def main():
    hs = load()
    now = int(time.time() * 1000)

    print("== agentLocation.type / status / environment ==")
    for k, n in C(loc_type(h) for h in hs).most_common():
        print(f"  {n:4d}  {k}")

    print("\n== isDraft vs null agentLocation ==")
    print(dict(C((bool(h['j'].get('isDraft')), h['j'].get('agentLocation') is None) for h in hs)))
    print("(key: (isDraft, agentLocation_null))")

    print("\n== null or zero lastUpdatedAt (by isDraft / workspaceIdentifier shape) ==")
    def wi(h):
        w = h["j"].get("workspaceIdentifier")
        return "none" if w is None else "{" + ",".join(sorted(w)) + "}"
    print(dict(C((bool(h['j'].get('isDraft')), wi(h), (h["lastUpdatedAt"] or 0) == 0) for h in hs)))
    print("(key: (isDraft, workspaceIdentifier, lastUpdatedAt==0))")

    print("\n== SQL columns vs JSON fields ==")
    mism = C()
    for h in hs:
        j = h["j"]
        mism["lastUpdatedAt differs"] += (j.get("lastUpdatedAt") or 0) != (h["lastUpdatedAt"] or 0)
        mism["createdAt differs"] += (j.get("createdAt") or 0) != (h["createdAt"] or 0)
        wid = (j.get("workspaceIdentifier") or {}).get("id")
        mism["workspaceId != workspaceIdentifier.id"] += wid != h["workspaceId"]
    print(dict(mism))

    print("\n== daemon 'candidate' chats: not archived, not subagents ==")
    cand = [h for h in hs if not h["isArchived"] and not h["isSubagent"]]
    print("total:", len(cand))
    print("by isDraft:", dict(C(bool(h['j'].get('isDraft')) for h in cand)))
    print("by agentLocation type:", dict(C(loc_type(h) for h in cand)))
    print("by unifiedMode:", dict(C(h['j'].get('unifiedMode') for h in cand)))

    print("\n== recency ==")
    z = [h for h in hs if (h["lastUpdatedAt"] or 0) == 0]
    print("rows with lastUpdatedAt==0:", len(z), "- with recency>0:", sum(1 for h in z if (h["recency"] or 0) > 0))
    nz = [h for h in hs if (h["lastUpdatedAt"] or 0) > 0]
    print("rows with lastUpdatedAt>0:", len(nz), "- recency==lastUpdatedAt:", sum(1 for h in nz if h["recency"] == h["lastUpdatedAt"]))
    d = sorted((h["recency"] - h["lastUpdatedAt"]) for h in nz)
    print("recency-lastUpdatedAt (ms) on rows with lastUpdatedAt>0: min/median/max:", d[0], d[len(d)//2], d[-1])

    print("\n== candidate chats: age of last update (hours) ==")
    ages = sorted((now - max(h["lastUpdatedAt"] or 0, h["recency"] or 0)) / 3600000 for h in cand)
    for q in (0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0):
        print(f"  quantile {q:4.2f}: {ages[min(len(ages)-1, int(q*len(ages)))]:.1f} h")

    print("\n== hasBlockingPendingActions by category ==")
    def cat(h):
        return ("arch" if h["isArchived"] else "live", "sub" if h["isSubagent"] else "top", "draft" if h["j"].get("isDraft") else "nodraft")
    print(dict(C((cat(h), h["j"].get("hasBlockingPendingActions", "missing")) for h in hs if h["j"].get("hasBlockingPendingActions"))))


if __name__ == "__main__":
    main()
