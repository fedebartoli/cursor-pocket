#!/usr/bin/env python3
"""
Fase 0 - risoluzione chat -> cartella/workspace (SOLA LETTURA).
Misura la copertura di tre sorgenti, in ordine di priorita':
  1. agentLocation.environment.uri (chat create nella Agents Window)
  2. workspaceIdentifier.uri
  3. workspaceStorage/<workspaceId>/workspace.json (campo `folder` o `workspace`)
Stampa solo conteggi e forme: nessun percorso.
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
    print("chat candidate (non archiviate, non sottoagenti, non bozze, con attivita'):", len(cands))

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
            src["6_NON RISOLTA"] += 1
            unresolved_ws.add(wsid)
    for k, n in sorted(src.items()):
        print(f"  {n:4d}  {k}")
    print("forme workspace.json usate:", dict(wsj_shapes))
    print("workspace non risolti (distinti):", len(unresolved_ws))

    # Cartelle in workspaceStorage e relativa risolubilita'
    entries = [e for e in os.listdir(WS) if os.path.isdir(os.path.join(WS, e))]
    kinds = C()
    for e in entries:
        wj = ws_json(e)
        kinds["manca workspace.json" if wj is None else ("folder" if "folder" in wj else ("workspace" if "workspace" in wj else "altro"))] += 1
    print("\nworkspaceStorage: cartelle =", len(entries), "->", dict(kinds))

    # workspace non risolti: hanno cartella in workspaceStorage?
    in_storage = sum(1 for w in unresolved_ws if os.path.isdir(os.path.join(WS, w)))
    print("di quelli non risolti, con cartella in workspaceStorage:", in_storage, "su", len(unresolved_ws))


if __name__ == "__main__":
    main()
