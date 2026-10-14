#!/usr/bin/env python3
"""
Phase 0 - chat -> folder/workspace resolution (READ ONLY).
Measures coverage of three sources, in priority order:
  1. agentLocation.environment.uri (chats created in the Agents Window)
  2. workspaceIdentifier.uri
  3. workspaceStorage/<workspaceId>/workspace.json (`folder` or `workspace` field)
Prints counts and shapes only: no paths.
"""
import collections, json, os, sqlite3
from urllib.parse import unquote, urlparse

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")
WS = os.path.expanduser("~/Library/Application Support/Cursor/User/workspaceStorage")
C = collections.Counter


def uri_path(uri):
    if isinstance(uri, dict):
        if uri.get("path"):
            return uri["path"]
        if uri.get("external"):
            return unquote(urlparse(uri["external"]).path)
    return None


def ws_json(wsid):
    p = os.path.join(WS, wsid, "workspace.json")
    if not os.path.isfile(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    cands = []
    for cid, wsid, lu, val in con.execute(
            "select composerId, workspaceId, lastUpdatedAt, value from composerHeaders where isArchived=0 and isSubagent=0"):
        j = json.loads(val)
        if j.get("isDraft") or not (lu or 0):
            continue
        cands.append((cid, wsid, j))
    print("candidate chats (not archived, not subagents, not drafts, with activity):", len(cands))

    src = C()
    wsj_shapes = C()
    unresolved_ws = set()
    for cid, wsid, j in cands:
        env = ((j.get("agentLocation") or {}).get("environment") or {})
        if uri_path(env.get("uri")):
            src["1_agentLocation.environment.uri"] += 1
            continue
        wi = j.get("workspaceIdentifier") or {}
        if uri_path(wi.get("uri")):
            src["2_workspaceIdentifier.uri"] += 1
            continue
        wj = ws_json(wsid)
        if wj:
            wsj_shapes[tuple(sorted(wj.keys()))] += 1
            if "folder" in wj or "workspace" in wj:
                src["3_workspace.json"] += 1
                continue
        env_id = env.get("id")
        if env_id == "empty-window":
            src["4_empty-window"] += 1
        elif "configPath" in wi:
            src["5_configPath (multi-root)"] += 1
        else:
            src["6_UNRESOLVED"] += 1
            unresolved_ws.add(wsid)
    for k, n in sorted(src.items()):
        print(f"  {n:4d}  {k}")
    print("workspace.json shapes used:", dict(wsj_shapes))
    print("unresolved workspaces (distinct):", len(unresolved_ws))

    # Folders in workspaceStorage and how often they resolve
    entries = [e for e in os.listdir(WS) if os.path.isdir(os.path.join(WS, e))]
    kinds = C()
    for e in entries:
        wj = ws_json(e)
        kinds["missing workspace.json" if wj is None else ("folder" if "folder" in wj else ("workspace" if "workspace" in wj else "other"))] += 1
    print("\nworkspaceStorage: folders =", len(entries), "->", dict(kinds))

    # Unresolved: do they have a folder in workspaceStorage?
    in_storage = sum(1 for w in unresolved_ws if os.path.isdir(os.path.join(WS, w)))
    print("of unresolved, with folder in workspaceStorage:", in_storage, "of", len(unresolved_ws))


if __name__ == "__main__":
    main()
