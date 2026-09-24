#!/usr/bin/env bash
# Measures how board history grows relative to live board state.
#
# Drives a throwaway instance with realistic traffic (batched creates, then
# edits and moves on existing shapes) and reports the size of the live record
# store against history events and checkpoints at each step. Production is not
# touched: the instance runs on its own data directory and port.
set -euo pipefail

REPO="${REPO:-/home/app/collaborative-ai-canvas}"
PORT="${PORT:-8801}"
ROUNDS="${ROUNDS:-16}"
BATCH="${BATCH:-30}"

WORK="$(mktemp -d /tmp/canvas-growth-XXXXXX)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/data" "$WORK/client"
echo '<!doctype html><html><body>canvas</body></html>' > "$WORK/client/index.html"
ORIGIN="http://127.0.0.1:$PORT"

env -u CANVAS_AUTH_DB_FILE NODE_ENV=production HOST=127.0.0.1 PORT="$PORT" \
  CANVAS_DATA_DIR="$WORK/data" CANVAS_CLIENT_DIR="$WORK/client" \
  CANVAS_ALLOWED_ORIGINS="$ORIGIN" CANVAS_ALLOW_OPEN_REGISTRATION=true \
  node "$REPO/dist/server/index.js" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do curl -fsS -m 2 "$ORIGIN/api/health" >/dev/null 2>&1 && break; sleep 0.25; done

JAR="$WORK/cookies"
curl -s -m 20 -c "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"login":"growth","displayName":"Growth","password":"measure measure measure"}' \
  "$ORIGIN/api/auth/register" >/dev/null
curl -s -m 20 -b "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"name":"Growth","id":"growth"}' "$ORIGIN/api/boards" >/dev/null

DB="$WORK/data/rooms/growth.sqlite"

report() { # report <label> <shapes>
  python3 - "$DB" "$1" "$2" <<'PY'
import os, sqlite3, sys
path, label, shapes = sys.argv[1], sys.argv[2], sys.argv[3]
con = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
usage = {name: size for name, size in con.execute(
    "SELECT name, sum(pgsize) FROM dbstat GROUP BY name")}
def counts(table):
    return con.execute('SELECT count(*) FROM "%s"' % table).fetchone()[0]
live = usage.get("documents", 0) + usage.get("sqlite_autoindex_documents_1", 0) + usage.get("tombstones", 0)
events = usage.get("history_events", 0) + sum(v for k, v in usage.items() if k.startswith("history_events_"))
checks = usage.get("history_checkpoints", 0) + sum(v for k, v in usage.items() if k.startswith("history_checkpoints_"))
ec, cc = counts("history_events"), counts("history_checkpoints")
print("%-10s shapes=%-6s file=%-8d live=%-7d events=%-7d(%3d) checkpoints=%-8d(%2d) history/live=%.1fx"
      % (label, shapes, os.path.getsize(path), live, events, ec, checks, cc,
         (events + checks) / live if live else 0))
con.close()
PY
}

echo "== phase 1: creating shapes =="
shapes=0
for round in $(seq 1 "$ROUNDS"); do
  actions=$(python3 -c "
import json,sys
base=int(sys.argv[1]); n=int(sys.argv[2])
print(json.dumps({'actions':[{'tool':'create_shape','id':'shape:s%d'%(base+i),'type':'rectangle','text':'node %d'%(base+i),'x':(base+i)%900*7,'y':((base+i)//30)*80,'width':120,'height':60} for i in range(n)]}))
" "$shapes" "$BATCH")
  curl -s -m 30 -b "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    -d "$actions" "$ORIGIN/api/rooms/growth/actions" >/dev/null
  shapes=$((shapes + BATCH))
  [ $((round % 4)) -eq 0 ] && report "create" "$shapes"
done

echo "== phase 2: editing existing shapes (no new objects) =="
for round in $(seq 1 "$ROUNDS"); do
  actions=$(python3 -c "
import json,sys,random
total=int(sys.argv[1]); n=int(sys.argv[2]); r=int(sys.argv[3])
random.seed(r)
ids=random.sample(range(total), min(n,total))
print(json.dumps({'actions':[{'tool':'move_shape','id':'shape:s%d'%i,'x':random.randint(0,5000),'y':random.randint(0,3000)} for i in ids]}))
" "$shapes" "$BATCH" "$round")
  curl -s -m 30 -b "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    -d "$actions" "$ORIGIN/api/rooms/growth/actions" >/dev/null
  [ $((round % 4)) -eq 0 ] && report "edit" "$shapes"
done

echo "== phase 3: forcing checkpoints =="
for round in $(seq 1 6); do
  curl -s -m 30 -b "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    -d "{\"label\":\"cp$round\"}" "$ORIGIN/api/boards/growth/checkpoints" >/dev/null
done
report "final" "$shapes"

echo
echo "== per-row averages =="
python3 - "$DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
usage = {n: s for n, s in con.execute("SELECT name, sum(pgsize) FROM dbstat GROUP BY name")}
ec = con.execute("SELECT count(*) FROM history_events").fetchone()[0]
cc = con.execute("SELECT count(*) FROM history_checkpoints").fetchone()[0]
ejson = con.execute("SELECT sum(length(changes_json)) FROM history_events").fetchone()[0] or 0
cjson = con.execute("SELECT sum(length(snapshot_json)) FROM history_checkpoints").fetchone()[0] or 0
print("events:      %d rows, %d bytes of changes_json  -> %.0f bytes/event" % (ec, ejson, ejson / max(ec, 1)))
print("checkpoints: %d rows, %d bytes of snapshot_json -> %.0f bytes/checkpoint" % (cc, cjson, cjson / max(cc, 1)))
print("checkpoint reasons:", dict(con.execute("SELECT reason, count(*) FROM history_checkpoints GROUP BY reason")))
print("event types:", dict(con.execute("SELECT event_type, count(*) FROM history_events GROUP BY event_type ORDER BY 2 DESC")))
con.close()
PY
