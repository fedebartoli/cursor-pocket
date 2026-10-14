#!/usr/bin/env python3
"""
Phase 0 - aggregate statistics on chat headers (READ ONLY, mode=ro).
Prints counts and enumerated values only: no titles or chat content.
"""
import collections, json, os, sqlite3

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")


def connect():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    return con


def shape(v, depth=0):
    """Describe the shape of a JSON value without showing its content."""
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
    print("composerHeaders rows:", len(rows))

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
    print("\n== SQL columns ==")
    print("isArchived:", C(h["isArchived"] for h in heads))
    print("isSubagent:", C(h["isSubagent"] for h in heads))
    print("subagentTypeName (types):", C(h["subagentTypeName"] for h in heads).most_common(8))

    print("\n== agentLocation (shape and values) ==")
    shapes = C(shape(h["j"].get("agentLocation")) for h in heads)
    print("shape:", shapes.most_common(10))
    locs = C(json.dumps(h["j"].get("agentLocation"), sort_keys=True)[:120] for h in heads)
    print("distinct values (first 12):")
    for k, n in locs.most_common(12):
        print("  ", n, k)

    print("\n== agentLocationHistory ==")
    print("shape:", C(shape(h["j"].get("agentLocationHistory")) for h in heads).most_common(6))

    print("\n== boolean flags in JSON (values) ==")
    for k in ["hasBlockingPendingActions", "hasUnreadMessages", "hasPendingPlan", "isDraft", "isProject", "isSpec",
              "isWorktree", "isBestOfNSubcomposer", "worktreeStartedReadOnly"]:
        print(f"{k}:", dict(C(h["j"].get(k, "<missing>") for h in heads)))

    print("\n== type / unifiedMode / forceMode ==")
    for k in ["type", "unifiedMode", "forceMode"]:
        print(f"{k}:", dict(C(str(h["j"].get(k, "<missing>")) for h in heads)))

    print("\n== workspaceIdentifier (shape) ==")
    print(C(shape(h["j"].get("workspaceIdentifier")) for h in heads).most_common(6))

    print("\n== recency vs lastUpdatedAt ==")
    eq = sum(1 for h in heads if h["recency"] == h["lastUpdatedAt"])
    print("recency == lastUpdatedAt:", eq, "of", len(heads))
    sample = [h for h in heads if h["recency"] != h["lastUpdatedAt"]][:5]
    for h in sample:
        print("  diff ms (recency - lastUpdatedAt):", (h["recency"] or 0) - (h["lastUpdatedAt"] or 0))
    print("recency type:", C(type(h["recency"]).__name__ for h in heads))


if __name__ == "__main__":
    main()
