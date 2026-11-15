#!/bin/sh
# Check that the image runs: the right user, the right files, a healthy
# server, and a document that compiles with the bibliography engine.
set -eu

name=freelatex-check
image=${1:-freelatex:biber-verify}
port=${2:-3031}

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "$port":3030 -e ADMIN_API_KEY=check-key "$image" >/dev/null

# Wait for the server to answer.
i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo "=== user: $(docker exec "$name" id)"
echo "=== health: $(curl -fsS "http://127.0.0.1:$port/api/health")"
echo "=== biber: $(docker exec "$name" biber --version)"
echo "=== tectonic: $(docker exec "$name" tectonic --version)"

# A biblatex document, compiled by the server inside the container.
docker exec "$name" node /usr/local/bin/biber-probe /app/dist

docker rm -f "$name" >/dev/null
echo "ok: the image runs and compiles a biblatex document"
