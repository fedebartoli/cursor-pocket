#!/usr/bin/env python3
"""
Phase 0 - Agents Window sidebar group order (READ ONLY, mode=ro).

Cursor stores sidebar configuration in the global database ItemTable, key
`cursor/glassSidebarSettings` (JSON). Manual groups are in `sectionOrderByGroupBy[groupBy]`.

For groupBy == "workspace", section ids are `__environment_instance_<hash>__`, where <hash> is VS Code's
hash() (signed int32) applied to the group key `local:path:<folder>` (or `local:home`).
This script reconstructs those ids from chats and checks they match the saved ones.

Does not print paths, repo names, or titles: counts and positions only.
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


# --- VS Code hash() (vs/base/common/hash.ts), on UTF-16 code units ---
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
    """Folder path from workspaceIdentifier (if present)."""
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
    print("hypothesis: include chats with null agentLocation:", include_null_loc)

    chats = []
    for cid, wsid, arch, sub, rec, val in con.execute(
            "select composerId, workspaceId, isArchived, isSubagent, recency, value from composerHeaders"):
        j = json.loads(val) if val else {}
        chats.append({"cid": cid, "ws": wsid, "arch": arch, "sub": sub, "rec": rec or 0, "j": j,
                      "loc": j.get("agentLocation"), "path": env_path(j) or (ws_path(j) if not j.get("agentLocation") else None)})

    # key candidates -> section id
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
    print(f"\nsaved ids (manual 'workspace' order): {len(stored)} | sections reconstructed from chats: {len(sections)}")
    matched = 0
    for pos, sid in enumerate(stored):
        cs = sections.get(sid)
        if cs is None:
            print(f"  #{pos:2d}  NOT reconstructed")
            continue
        matched += 1
        visible = [c for c in cs if not c["arch"] and not c["sub"] and not c["j"].get("isDraft")]
        print(f"  #{pos:2d}  ok   visible chats={len(visible):3d} (total={len(cs)})  "
              f"last activity={max((c['rec'] for c in cs), default=0)}")
    print(f"=> matches: {matched}/{len(stored)}")

    extra = [(sid, cs) for sid, cs in sections.items() if sid not in stored]
    vis_extra = [(sid, [c for c in cs if not c['arch'] and not c['sub'] and not c['j'].get('isDraft')]) for sid, cs in extra]
    print(f"\nsections with local chats NOT in saved order: {len(extra)}; "
          f"with at least one visible chat: {sum(1 for _, v in vis_extra if v)}")


if __name__ == "__main__":
    main()
