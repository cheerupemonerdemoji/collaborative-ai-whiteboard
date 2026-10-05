#!/bin/sh
# Smoke test for the public machine (agent) API. Needs only curl and ordinary Internet access.
#
# Required environment variables (values come from your secret store; this script never prints them):
#   WHITEBOARD_API_BASE        the agent API address, e.g. https://<agent-api-host>
#   CF_ACCESS_CLIENT_ID        Cloudflare Access service-token id
#   CF_ACCESS_CLIENT_SECRET    Cloudflare Access service-token secret
#   WHITEBOARD_TOKEN           board-scoped whiteboard token
#   WHITEBOARD_BOARD_ID        the board the token is limited to
# Optional:
#   WHITEBOARD_WRITE_TEST=1    also create, read back, and archive one temporary record (needs the write scope)
#
# Exit status is 0 only if every step behaved as expected.
set -u

for name in WHITEBOARD_API_BASE CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET WHITEBOARD_TOKEN WHITEBOARD_BOARD_ID; do
	eval "value=\${$name:-}"
	[ -n "$value" ] || { echo "missing environment variable: $name" >&2; exit 2; }
done

headers=$(mktemp) || exit 2
body=$(mktemp) || exit 2
trap 'rm -f "$headers" "$body"' EXIT INT TERM
chmod 600 "$headers" "$body"
# Credentials go through a private header file, not the command line, so they never appear in a process list.
{
	printf 'CF-Access-Client-Id: %s\n' "$CF_ACCESS_CLIENT_ID"
	printf 'CF-Access-Client-Secret: %s\n' "$CF_ACCESS_CLIENT_SECRET"
	printf 'Authorization: Bearer %s\n' "$WHITEBOARD_TOKEN"
} > "$headers"

failures=0
base=${WHITEBOARD_API_BASE%/}
board=$WHITEBOARD_BOARD_ID

# request LABEL EXPECTED_STATUS METHOD PATH [JSON_BODY]
request() {
	label=$1; expected=$2; method=$3; path=$4; data=${5:-}
	if [ -n "$data" ]; then
		status=$(curl -sS -m 30 -o "$body" -w '%{http_code}' -X "$method" -H "@$headers" -H 'Content-Type: application/json' --data "$data" "$base$path")
	else
		status=$(curl -sS -m 30 -o "$body" -w '%{http_code}' -X "$method" -H "@$headers" "$base$path")
	fi
	if [ "$status" = "$expected" ]; then result=ok; else result=FAIL; failures=$((failures + 1)); fi
	printf '%-5s %-52s expected %s got %s\n' "$result" "$label" "$expected" "$status"
}

request "health (Cloudflare Access + origin reachable)" 200 GET /api/health
request "read semantic context" 200 GET "/api/rooms/$board/semantic-context"

if [ "${WHITEBOARD_WRITE_TEST:-}" = "1" ]; then
	id="engineering_entity:smoke-$(date +%s)-$$"
	request "create one temporary record" 200 POST "/api/rooms/$board/actions" \
		"{\"actions\":[{\"tool\":\"create_entity\",\"id\":\"$id\",\"entityType\":\"task\",\"title\":\"TEMP agent API smoke test (safe to delete)\",\"status\":\"open\"}]}"
	request "read the record back" 200 GET "/api/rooms/$board/semantic-context?ids=$id"
	if grep -q "\"id\":\"$id\"" "$body"; then echo "ok    record is present in the read-back"; else echo "FAIL  record missing from the read-back"; failures=$((failures + 1)); fi
	request "archive the temporary record" 200 POST "/api/rooms/$board/actions" \
		"{\"actions\":[{\"tool\":\"update_status\",\"id\":\"$id\",\"status\":\"archived\"}]}"
	echo "temporary record id: $id"
fi

if [ "$failures" -eq 0 ]; then echo "PASS"; else echo "FAILED ($failures)"; exit 1; fi
