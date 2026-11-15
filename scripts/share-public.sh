#!/bin/sh
# Share a freeLatex running on this machine with anyone, over the public
# internet, without a cloud account and without a card.
#
# It does three things:
#
#   1. builds the client, so that the server has something to hand out —
#      without it the deep link /p/{id} answers 404 instead of the
#      application;
#   2. starts the server with STATIC_DIR set;
#   3. opens a cloudflared quick tunnel, which gives a public HTTPS address
#      with no account and no configuration.
#
# The address the tunnel prints changes every time it is started, so mint
# the share link after this has run.
#
# Usage: sh scripts/share-public.sh [port]
set -eu

port=${1:-3030}
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. On Arch:" >&2
  echo "  sudo pacman -S cloudflared" >&2
  echo "On Debian and Ubuntu:" >&2
  echo "  sudo apt install cloudflared" >&2
  exit 1
fi

echo "building the client..."
cd "$root/client"
npx vite build >/dev/null

echo "starting the server on port $port..."
cd "$root/server"
PORT="$port" \
HOST=127.0.0.1 \
STATIC_DIR="$root/client/dist" \
  node dist/index.js &
server_pid=$!

# Stop the server when this script is interrupted, so that a closed
# terminal does not leave it running.
trap 'kill "$server_pid" 2>/dev/null || true' INT TERM

i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
  echo "the server did not start." >&2
  exit 1
fi

echo
echo "the application is at http://127.0.0.1:$port"
echo "opening the tunnel..."
echo
cloudflared tunnel --url "http://127.0.0.1:$port"

echo
echo "the tunnel has closed. The server is still running; press Ctrl-C to stop it."
wait "$server_pid"
