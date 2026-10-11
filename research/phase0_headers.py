#!/usr/bin/env python3
"""
Fase 0 - statistiche aggregate sugli header delle chat (SOLA LETTURA, mode=ro).
Stampa solo conteggi e valori enumerati: nessun titolo, nessun contenuto di chat.
"""
import collections, json, os, sqlite3

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")


def connect():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    return con


def shape(v, depth=0):
    """Descrive la forma di un valore JSON senza mostrarne il contenuto."""
    if isinstance(v, dict):
        return "{" + ",".join(sorted(v.keys())) + "}"
    if isinstance(v, list):
        return f"list[{len(v)}]"
    return type(v).__name__


def main():
    con = connect()
    rows = con.execute(
        "select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, "
        "value, subagentTypeName from composerHeaders").fetchall()
    print("righe composerHeaders:", len(rows))

    cols = ["composerId", "workspaceId", "createdAt", "lastUpdatedAt", "isArchived", "isSubagent", "recency",
            "checkpointAt", "value", "subagentTypeName"]
    heads = []
    for r in rows:
        d = dict(zip(cols, r))
        try:
            d["j"] = json.loads(d["value"])
        except Exception:
            d["j"] = {}
        heads.append(d)

    C = collections.Counter
    print("\n== colonne SQL ==")
    print("isArchived:", C(h["isArchived"] for h in heads))
    print("isSubagent:", C(h["isSubagent"] for h in heads))
    print("subagentTypeName (tipi):", C(h["subagentTypeName"] for h in heads).most_common(8))

    print("\n== agentLocation (forma e valori) ==")
    shapes = C(shape(h["j"].get("agentLocation")) for h in heads)
    print("forma:", shapes.most_common(10))
    locs = C(json.dumps(h["j"].get("agentLocation"), sort_keys=True)[:120] for h in heads)
    print("valori distinti (primi 12):")
    for k, n in locs.most_common(12):
        print("  ", n, k)

    print("\n== agentLocationHistory ==")
    print("forma:", C(shape(h["j"].get("agentLocationHistory")) for h in heads).most_common(6))

    print("\n== flag booleani nel JSON (valori) ==")
    for k in ["hasBlockingPendingActions", "hasUnreadMessages", "hasPendingPlan", "isDraft", "isProject", "isSpec",
              "isWorktree", "isBestOfNSubcomposer", "worktreeStartedReadOnly"]:
        print(f"{k}:", dict(C(h["j"].get(k, "<assente>") for h in heads)))

    print("\n== type / unifiedMode / forceMode ==")
    for k in ["type", "unifiedMode", "forceMode"]:
        print(f"{k}:", dict(C(str(h["j"].get(k, "<assente>")) for h in heads)))

    print("\n== workspaceIdentifier (forma) ==")
    print(C(shape(h["j"].get("workspaceIdentifier")) for h in heads).most_common(6))

    print("\n== recency vs lastUpdatedAt ==")
    eq = sum(1 for h in heads if h["recency"] == h["lastUpdatedAt"])
    print("recency == lastUpdatedAt:", eq, "su", len(heads))
    sample = [h for h in heads if h["recency"] != h["lastUpdatedAt"]][:5]
    for h in sample:
        print("  diff ms (recency - lastUpdatedAt):", (h["recency"] or 0) - (h["lastUpdatedAt"] or 0))
    print("tipo di recency:", C(type(h["recency"]).__name__ for h in heads))


if __name__ == "__main__":
    main()
