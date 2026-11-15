#!/bin/sh
# Start the built server with the client attached, wait for it to answer, and
# leave it running in the background. The share probe talks to this one.
set -eu

port=${1:-3040}
root=/home/biloi/Projects/freeLatex

cd "$root/server"
PORT="$port" \
HOST=127.0.0.1 \
STATIC_DIR="$root/client/dist" \
DATA_DIR="$root/server/data" \
ADMIN_API_KEY=share-probe-key \
AUTH_MODE=single \
  node dist/index.js > /tmp/freelatex-probe-server.log 2>&1 &

echo $! > /tmp/freelatex-probe-server.pid

i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    echo "the server is up on $port"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "the server did not start:" >&2
cat /tmp/freelatex-probe-server.log >&2
exit 1
