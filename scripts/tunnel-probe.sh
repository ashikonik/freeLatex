#!/bin/sh
# Prove that a share link works over the public internet, through a
# cloudflared quick tunnel.
#
# It opens a tunnel against a server that is already running, mints a share
# link through the API, and then asks the public address the same questions
# the share probe asks of a local one: does the deep link serve the
# application, does the API accept the share token, and does the
# collaboration socket open?
set -eu

base=${1:-http://127.0.0.1:3040}
key=${2:-share-probe-key}
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

log=/tmp/freelatex-tunnel.log
rm -f "$log"

cloudflared tunnel --url "$base" > "$log" 2>&1 &
tunnel_pid=$!
trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT INT TERM

# Wait for the tunnel to print its address.
public=""
i=0
while [ "$i" -lt 60 ]; do
  public=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)
  if [ -n "$public" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ -z "$public" ]; then
  echo "the tunnel did not open:" >&2
  cat "$log" >&2
  exit 1
fi

echo "the tunnel is open at $public"

# The tunnel prints its address before it is registered, so the first
# requests come back with a 530. Waiting for the address to answer is what
# makes the rest of the check meaningful.
ready=""
i=0
while [ "$i" -lt 30 ]; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "$public/api/health" 2>/dev/null || true)
  if [ "$status" = "200" ]; then
    ready=yes
    break
  fi
  i=$((i + 1))
  sleep 2
done

if [ -z "$ready" ]; then
  echo "the tunnel did not come up:" >&2
  cat "$log" >&2
  exit 1
fi

echo "the tunnel is answering"

# Mint a share link through the API.
project=$(curl -fsS -X POST "$base/api/projects" \
  -H "authorization: Bearer $key" \
  -H 'content-type: application/json' \
  -d '{"title":"Tunnel probe"}')
project_id=$(printf '%s' "$project" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

share=$(curl -fsS -X POST "$base/api/projects/$project_id/share" \
  -H "authorization: Bearer $key" \
  -H 'content-type: application/json' \
  -d '{"permission":"rw"}')
token=$(printf '%s' "$share" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

if [ -z "$project_id" ] || [ -z "$token" ]; then
  echo "could not mint a share link:" >&2
  printf '%s\n%s\n' "$project" "$share" >&2
  exit 1
fi

echo "the link is $public/p/$project_id?token=$token"

# 1. The deep link serves the application.
status=$(curl -fsS -o /tmp/tunnel-page.html -w '%{http_code}' \
  "$public/p/$project_id?token=$token")
if [ "$status" = "200" ] && grep -q '<div id="root">' /tmp/tunnel-page.html; then
  echo "  ok   the deep link serves the application over the public address"
else
  echo " FAIL the deep link answered $status" >&2
  exit 1
fi

# 2. The API accepts the share token over the public address.
status=$(curl -fsS -o /dev/null -w '%{http_code}' \
  "$public/api/projects/$project_id?token=$token")
if [ "$status" = "200" ]; then
  echo "  ok   the API accepts the share token over the public address"
else
  echo " FAIL the API answered $status" >&2
  exit 1
fi

# 3. The collaboration socket opens over the public address.
#
# The socket library lives in the server's dependencies, so the check is
# run from the repository root where that tree is reachable.
if node --input-type=module -e "
  import ws from '$root/server/node_modules/ws/index.js';
  const url = process.argv[1];
  const socket = new ws.WebSocket(url);
  const timer = setTimeout(() => { socket.close(); process.exit(1); }, 20000);
  socket.on('open', () => { clearTimeout(timer); socket.close(); process.exit(0); });
  socket.on('error', () => { clearTimeout(timer); process.exit(1); });
" "wss://${public#https://}/ws/${project_id}.$(printf 'main.tex' | base64 | tr '+/' '-_')?token=$token"; then
  echo "  ok   the collaboration socket opens over the public address"
else
  echo " FAIL the collaboration socket did not open" >&2
  exit 1
fi

echo "ok: a share link works over the public internet"
