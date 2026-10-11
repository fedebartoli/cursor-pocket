#!/usr/bin/env python3
"""
Fase 0 - campionatore in sola lettura (mode=ro) che registra i CAMBIAMENTI di stato delle chat.

Serve a osservare dal vivo come cambiano header, composerData e ultimo bubble quando una chat
parte, pone una domanda, riceve risposta, finisce. Scrive su un file solo metadati
(nomi di campo, valori booleani/numerici/stati, id abbreviati). Mai titoli, mai testi, mai tool params.

Uso:
  python3 research/phase0_sampler.py --out /tmp/cp-sampler.log --interval 0.5 --duration 7200
"""
import argparse, hashlib, json, os, signal, sqlite3, sys, time
from datetime import datetime, timezone

DB = os.path.expanduser("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")

HDR_FIELDS = ["lastUpdatedAt", "unfinishedRunAt", "hasBlockingPendingActions", "hasPendingPlan", "hasUnreadMessages",
              "isArchived", "isDraft", "lastReadAtMs", "conversationCheckpointLastUpdatedAt"]
CD_FIELDS = ["status", "isContinuationInProgress", "stopHookLoopCount", "unfinishedRunAt", "lastUpdatedAt",
             "lastReadAtMs", "hasUnreadMessages", "isAgentic"]


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


def short(cid):
    return cid[:8]


def hdr_sig(j, arch):
    s = {k: j.get(k, None) for k in HDR_FIELDS}
    s["isArchived"] = arch
    return s


def parse_iso(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def cd_sig(con, cid):
    cd = kv(con, f"composerData:{cid}")
    if not cd:
        return None
    s = {k: cd.get(k, None) for k in CD_FIELDS}
    gu = cd.get("chatGenerationUUID") or ""
    s["genUUID"] = hashlib.sha1(gu.encode()).hexdigest()[:6] if gu else ""
    s["queue"] = len(cd.get("queueItems") or [])
    s["genBubbles"] = len(cd.get("generatingBubbleIds") or [])
    hs = cd.get("fullConversationHeadersOnly") or []
    s["nBubbles"] = len(hs)
    last = {}
    if hs:
        h = hs[-1]
        last["type"] = h.get("type")
        last["created"] = h.get("createdAt")
        b = kv(con, f"bubbleId:{cid}:{h['bubbleId']}") or {}
        tf = b.get("toolFormerData") or {}
        ad = tf.get("additionalData")
        last["tool"] = tf.get("name")
        last["toolStatus"] = tf.get("status")
        last["adStatus"] = ad.get("status") if isinstance(ad, dict) else None
        last["hasText"] = bool((b.get("text") or "").strip())
    s["last"] = last
    return s


def diff(old, new):
    out = []
    for k in sorted(set(old or {}) | set(new or {})):
        a, b = (old or {}).get(k), (new or {}).get(k)
        if a != b:
            out.append(f"{k}:{a!r}->{b!r}")
    return out


def ts():
    return datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--duration", type=float, default=7200)
    ap.add_argument("--hot", type=int, default=6, help="quante chat recenti seguire a livello composerData")
    args = ap.parse_args()

    stop = {"v": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("v", True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__("v", True))

    con = connect()
    out = open(args.out, "a", buffering=1)

    def log(msg):
        out.write(f"{ts()} {msg}\n")

    hdr_prev, cd_prev = {}, {}
    watch = {}  # cid -> scadenza (chat nuove, sottoagenti inclusi, seguite per 20 minuti)
    t_end = time.time() + args.duration
    first = True
    log(f"# avvio campionatore pid={os.getpid()} interval={args.interval}")
    while time.time() < t_end and not stop["v"]:
        t0 = time.time()
        try:
            rows = con.execute("select composerId, isArchived, isSubagent, recency, value from composerHeaders").fetchall()
        except sqlite3.OperationalError as e:
            log(f"# errore lettura header: {e}")
            time.sleep(1)
            continue
        hot = []
        for cid, arch, sub, rec, val in rows:
            try:
                j = json.loads(val) if val else {}
            except Exception:
                continue
            sig = hdr_sig(j, arch)
            sig["sub"] = sub
            prev = hdr_prev.get(cid)
            if prev is not None and prev != sig:
                log(f"HDR {short(cid)} " + " ".join(diff(prev, sig)))
                watch[cid] = time.time() + 1200
            elif prev is None and not first:
                log(f"HDR {short(cid)} NUOVO " + json.dumps(sig, sort_keys=True))
                watch[cid] = time.time() + 1200
            hdr_prev[cid] = sig
            if not arch and (j.get("unfinishedRunAt") or j.get("hasBlockingPendingActions")):
                hot.append((rec or 0, cid))
            elif not arch and not sub:
                hot.append((rec or 0, cid))
        hot.sort(reverse=True)
        chosen = []
        seen = set()
        # tutte le chat in corso / bloccate + le piu' recenti + quelle osservate perche' nuove o cambiate
        for rec, cid in hot:
            j = hdr_prev[cid]
            if (j.get("unfinishedRunAt") or j.get("hasBlockingPendingActions")) and cid not in seen:
                chosen.append(cid); seen.add(cid)
        for cid, exp in list(watch.items()):
            if exp < time.time():
                del watch[cid]
            elif cid not in seen and not hdr_prev.get(cid, {}).get("isArchived"):
                chosen.append(cid); seen.add(cid)
        for rec, cid in hot:
            if len(chosen) >= args.hot + 4:
                break
            if cid not in seen:
                chosen.append(cid); seen.add(cid)
        for cid in chosen:
            try:
                s = cd_sig(con, cid)
            except sqlite3.OperationalError as e:
                log(f"# errore composerData {short(cid)}: {e}")
                continue
            prev = cd_prev.get(cid)
            if prev is None and s is not None and not first:
                log(f"CD  {short(cid)} INIZIO-OSSERVAZIONE " + json.dumps(s, sort_keys=True, default=str))
            if prev is not None and s is not None and prev != s:
                d = diff({k: v for k, v in prev.items() if k != 'last'}, {k: v for k, v in s.items() if k != 'last'})
                dl = diff(prev.get("last"), s.get("last"))
                lag = ""
                lc = s.get("last", {}).get("created")
                if lc and prev.get("last", {}).get("created") != lc:
                    p = parse_iso(lc)
                    if p:
                        lag = f" [lag_bubble_ms={int((time.time()-p)*1000)}]"
                log(f"CD  {short(cid)} " + " ".join(d) + ((" | last: " + " ".join(dl)) if dl else "") + lag)
            cd_prev[cid] = s
        first = False
        dt = time.time() - t0
        time.sleep(max(0.0, args.interval - dt))
    log("# fine campionatore")


if __name__ == "__main__":
    main()
