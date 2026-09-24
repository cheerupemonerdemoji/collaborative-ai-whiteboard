#!/usr/bin/env bash
# Disaster-recovery drill for Collaborative AI Canvas.
#
# Restores a backup archive into a throwaway directory, starts a second
# application instance against it on a spare port, and proves the restored data
# is actually usable: accounts load, an existing board's canvas is readable, a
# new account can be created, a board can be made, and canvas writes and history
# still work.
#
# Production is never touched. The drill runs entirely under a temporary
# directory and a separate port, and the disposable machine token it mints for
# the read check exists only for the life of the drill.
#
# Usage: scripts/dr-drill.sh [archive] [port]
#        archive defaults to the newest archive in the backup directory.

set -euo pipefail

REPO="${REPO:-/home/app/collaborative-ai-canvas}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/collaborative-ai-canvas}"
ARCHIVE="${1:-}"
PORT="${2:-8799}"
EXISTING_BOARD="${EXISTING_BOARD:-demo}"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(ls -1t "$BACKUP_DIR"/canvas-backup-*.tar.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "FATAL: no archive to drill. Pass one explicitly." >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/canvas-dr-XXXXXX)"
SERVER_PID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1 ($3)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 (expected $2, got $3)"
    FAIL=$((FAIL + 1))
  fi
}

echo "archive: $ARCHIVE"
echo "workdir: $WORK"
echo

echo "== 1. verify the archive before trusting it =="
python3 "$REPO/scripts/backup-canvas-data.py" verify "$ARCHIVE"
echo

echo "== 2. restore into an isolated directory =="
python3 "$REPO/scripts/backup-canvas-data.py" restore "$ARCHIVE" \
  --target "$WORK/data" --config-target "$WORK/config"
echo

echo "== 3. start a throwaway instance on port $PORT =="
# A disposable read-only machine token, scoped to one board. Generated here,
# used here, destroyed with the workdir. Only its SHA-256 hash is ever stored.
TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32)[:43])')"
export DRILL_TOKEN="$TOKEN"
python3 - "$WORK/config/api-tokens.json" "$EXISTING_BOARD" <<'PY'
import hashlib, json, os, sys
token = os.environ["DRILL_TOKEN"]
path, board = sys.argv[1], sys.argv[2]
json.dump({"clients": [{
    "name": "dr-drill",
    "tokenHash": hashlib.sha256(token.encode()).hexdigest(),
    "rooms": [board],
    "permissions": ["read"],
}]}, open(path, "w"))
os.chmod(path, 0o600)
PY

ORIGIN="http://127.0.0.1:$PORT"
env -u CANVAS_AUTH_DB_FILE \
  NODE_ENV=production \
  HOST=127.0.0.1 PORT="$PORT" \
  CANVAS_DATA_DIR="$WORK/data" \
  CANVAS_CLIENT_DIR="$REPO/dist/client" \
  CANVAS_API_TOKENS_FILE="$WORK/config/api-tokens.json" \
  CANVAS_ALLOWED_ORIGINS="$ORIGIN" \
  CANVAS_ALLOW_OPEN_REGISTRATION=true \
  node "$REPO/dist/server/index.js" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS -m 2 "$ORIGIN/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo

echo "== 4. restored instance behaviour =="
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }

check "health endpoint" 200 "$(code "$ORIGIN/api/health")"
check "anonymous /api/boards denied" 401 "$(code "$ORIGIN/api/boards")"
check "anonymous /api/auth/me denied" 401 "$(code "$ORIGIN/api/auth/me")"
check "cross-origin mutation denied" 403 \
  "$(code -X POST -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
      -d '{}' "$ORIGIN/api/boards")"

# Restored account state is present and readable by the application.
USERS=$(python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select count(*) from users').fetchone()[0])" "$WORK/data/auth.sqlite")
BOARDS=$(python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select count(*) from boards').fetchone()[0])" "$WORK/data/auth.sqlite")
echo "  restored accounts: $USERS   restored boards: $BOARDS"
[ "$USERS" -ge 1 ] && PASS=$((PASS + 1)) || { echo "  FAIL  no accounts restored"; FAIL=$((FAIL + 1)); }

# The pre-existing board's canvas loads out of the restored room database.
CANVAS=$(curl -s -m 10 -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/rooms/$EXISTING_BOARD/canvas")
OBJECTS=$(printf '%s' "$CANVAS" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('objects',[])))" 2>/dev/null || echo "ERR")
check "restored board '$EXISTING_BOARD' canvas readable" 200 \
  "$(code -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/rooms/$EXISTING_BOARD/canvas")"
echo "  restored board '$EXISTING_BOARD' shape count: $OBJECTS"
check "scoped token cannot write" 403 \
  "$(code -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d '{"actions":[{"tool":"create_text","id":"shape:nope","text":"no","x":0,"y":0}]}' \
      "$ORIGIN/api/rooms/$EXISTING_BOARD/actions")"
echo

echo "== 5. the restored instance is a working whiteboard =="
JAR="$WORK/cookies"
REG=$(curl -s -m 20 -c "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -d '{"login":"dr-drill-user","displayName":"DR Drill","password":"drill drill drill drill"}' \
  "$ORIGIN/api/auth/register")
check "new account created on restored data" "true" \
  "$(printf '%s' "$REG" | python3 -c "import json,sys;print(str('user' in json.load(sys.stdin)).lower())" 2>/dev/null || echo false)"

check "board created" 200 \
  "$(code -b "$JAR" -c "$JAR" -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
      -d '{"name":"DR Drill Board","id":"dr-drill-board"}' "$ORIGIN/api/boards")"

check "canvas write accepted" 200 \
  "$(code -b "$JAR" -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
      -d '{"actions":[{"tool":"create_text","id":"shape:drill","text":"restored","x":10,"y":10}]}' \
      "$ORIGIN/api/rooms/dr-drill-board/actions")"

READBACK=$(curl -s -m 10 -b "$JAR" "$ORIGIN/api/rooms/dr-drill-board/canvas" |
  python3 -c "import json,sys;d=json.load(sys.stdin);print(next((o['text'] for o in d['objects'] if o['id']=='shape:drill'),'MISSING'))" 2>/dev/null || echo ERR)
check "canvas write read back" "restored" "$READBACK"

HIST=$(curl -s -m 10 -b "$JAR" "$ORIGIN/api/boards/dr-drill-board/history" |
  python3 -c "import json,sys;print(len(json.load(sys.stdin).get('events',[])))" 2>/dev/null || echo 0)
echo "  history events recorded on the new board: $HIST"
[ "$HIST" -ge 1 ] && PASS=$((PASS + 1)) || { echo "  FAIL  no history recorded"; FAIL=$((FAIL + 1)); }

check "checkpoint created" 200 \
  "$(code -b "$JAR" -X POST -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
      -d '{"label":"drill"}' "$ORIGIN/api/boards/dr-drill-board/checkpoints")"

# Live collaboration. The server accepts the upgrade and then closes refused
# sockets with 1008, so "still open a moment later" is the real signal and an
# anonymous attempt is checked alongside it to keep that signal meaningful.
COOKIE="$(awk 'NF >= 7 && $(NF-1) == "canvas_session" { print "canvas_session=" $NF }' "$JAR")"
ws_probe() { # ws_probe <board> [cookie]
  node -e '
const WebSocket = require(process.argv[1]);
const socket = new WebSocket(process.argv[2], {
  headers: Object.assign({ origin: process.argv[4] }, process.argv[3] ? { cookie: process.argv[3] } : {}),
});
let settled = false;
const done = (v) => {
  if (settled) return;
  settled = true;
  console.log(v);
  try { socket.terminate(); } catch {}
  process.exit(0);
};
socket.on("open", () => setTimeout(() => done("open"), 500));
socket.on("close", (code) => done("closed:" + code));
socket.on("error", (error) => done("error:" + error.message));
setTimeout(() => done("timeout"), 8000);
' "$REPO/node_modules/ws" "ws://127.0.0.1:$PORT/api/connect/$1?sessionId=drillsession01" "${2-}" "$ORIGIN"
}
check "authenticated websocket accepted" "open" "$(ws_probe dr-drill-board "$COOKIE")"
check "anonymous websocket refused" "closed:1008" "$(ws_probe dr-drill-board)"

echo
echo "== 6. production untouched =="
check "production service still active" "active" "$(systemctl --user is-active collaborative-ai-canvas)"
check "production health" 200 "$(code http://127.0.0.1:8787/api/health)"
check "drill board absent from production data" "absent" \
  "$(test -e "$HOME/.local/share/collaborative-ai-canvas/rooms/dr-drill-board.sqlite" && echo present || echo absent)"

echo
echo "== result =="
echo "passed: $PASS   failed: $FAIL"
if [ "$FAIL" -ne 0 ]; then
  echo "--- throwaway server log (tail) ---"
  tail -20 "$WORK/server.log" || true
  exit 1
fi
echo "DR DRILL PASSED"
