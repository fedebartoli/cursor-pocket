#!/usr/bin/env python3
"""
Fase 0 - ordine dei gruppi nella sidebar dell'Agents Window (SOLA LETTURA, mode=ro).

Cursor salva la configurazione della sidebar nella ItemTable del database globale, chiave
`cursor/glassSidebarSettings` (JSON). I gruppi manuali sono in `sectionOrderByGroupBy[groupBy]`.

Per groupBy == "workspace" gli id di sezione sono `__environment_instance_<hash>__`, dove <hash> e' la funzione
hash() di VS Code (int32 con segno) applicata alla chiave di gruppo `local:path:<cartella>` (o `local:home`).
Questo script ricostruisce quegli id dalle chat e verifica che coincidano con quelli salvati.

Non stampa percorsi, nomi di repository o titoli: solo conteggi e posizioni.
"""
import collections, json, os, sqlite3
from urllib.parse import unquote, urlparse

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")
WS = os.path.expanduser("~/Library/Application Support/Cursor/User/workspaceStorage")
C = collections.Counter


def connect():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    return con


# --- hash() di VS Code (vs/base/common/hash.ts), su code unit UTF-16 ---
def _i32(x):
    return ((x + 2**31) % 2**32) - 2**31


def _num(val, h):
    return _i32((h << 5) - h + val)


def vs_hash_str(s):
    h = _num(149417, 0)
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h = _num(data[i] | (data[i + 1] << 8), h)
    return h


def section_id(key):
    return f"__environment_instance_{vs_hash_str(key)}__"


def env_path(j):
    env = (j.get("agentLocation") or {}).get("environment") or {}
    uri = env.get("uri")
    if isinstance(uri, dict):
        if uri.get("path"):
            return uri["path"]
        if uri.get("external"):
            return unquote(urlparse(uri["external"]).path)
    return None


def ws_path(j):
    """Percorso della cartella da workspaceIdentifier (se presente)."""
    wi = j.get("workspaceIdentifier") or {}
    uri = wi.get("uri")
    if isinstance(uri, dict):
        if uri.get("path"):
            return uri["path"]
        if uri.get("external"):
            return unquote(urlparse(uri["external"]).path)
    return None


def main():
    import sys
    include_null_loc = "--include-null-location" in sys.argv
    con = connect()
    d = json.loads(con.execute("select value from ItemTable where key='cursor/glassSidebarSettings'").fetchone()[0])
    print("groupBy:", d["groupBy"], "| sortGroupsBy:", d["sortGroupsBy"], "| sortAgentsBy:", d["sortAgentsBy"])
    print("ipotesi: includere chat con agentLocation nullo:", include_null_loc)

    chats = []
    for cid, wsid, arch, sub, rec, val in con.execute(
            "select composerId, workspaceId, isArchived, isSubagent, recency, value from composerHeaders"):
        j = json.loads(val) if val else {}
        chats.append({"cid": cid, "ws": wsid, "arch": arch, "sub": sub, "rec": rec or 0, "j": j,
                      "loc": j.get("agentLocation"), "path": env_path(j) or (ws_path(j) if not j.get("agentLocation") else None)})

    # candidati di chiave -> id di sezione
    sections = collections.defaultdict(list)
    for c in chats:
        loc = c["loc"]
        if not loc and not include_null_loc:
            continue
        if loc and loc.get("type") not in ("local", "worktree"):
            continue
        key = f"local:path:{c['path']}" if c["path"] else "local:home"
        sections[section_id(key)].append(c)

    stored = d.get("sectionOrderByGroupBy", {}).get("workspace", [])
    print(f"\nid salvati (ordine manuale 'workspace'): {len(stored)} | sezioni ricostruite dalle chat: {len(sections)}")
    matched = 0
    for pos, sid in enumerate(stored):
        cs = sections.get(sid)
        if cs is None:
            print(f"  #{pos:2d}  NON ricostruito")
            continue
        matched += 1
        visible = [c for c in cs if not c["arch"] and not c["sub"] and not c["j"].get("isDraft")]
        print(f"  #{pos:2d}  ok   chat visibili={len(visible):3d} (totali={len(cs)})  "
              f"ultima attivita'={max((c['rec'] for c in cs), default=0)}")
    print(f"=> corrispondenze: {matched}/{len(stored)}")

    extra = [(sid, cs) for sid, cs in sections.items() if sid not in stored]
    vis_extra = [(sid, [c for c in cs if not c['arch'] and not c['sub'] and not c['j'].get('isDraft')]) for sid, cs in extra]
    print(f"\nsezioni con chat locali NON presenti nell'ordine salvato: {len(extra)}; "
          f"di cui con almeno una chat visibile: {sum(1 for _, v in vis_extra if v)}")


if __name__ == "__main__":
    main()
