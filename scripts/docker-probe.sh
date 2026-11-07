#!/usr/bin/env bash
#
# docker-probe.sh — check that a freeLatex container serves the whole
# application: the API, the client's page, and a real LaTeX compilation.
#
# Usage: ./scripts/docker-probe.sh [image] [port]
#
# The script starts the container, asks it for a project, writes a document
# into it, compiles the document and reads the PDF back. A failure at any
# point is a failure of the script.

set -euo pipefail

IMAGE="${1:-freelatex:test}"
PORT="${2:-13030}"
KEY="probe-secret-key"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f freelatex-probe >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- starting ${IMAGE} on port ${PORT} ---"
cleanup
docker run -d --name freelatex-probe -p "${PORT}:3030" \
  -e ADMIN_API_KEY="${KEY}" "${IMAGE}" >/dev/null

# The server needs a moment to bind its port.
for _ in $(seq 1 30); do
  if curl -fsS "${BASE}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "--- health ---"
curl -fsS "${BASE}/api/health"
echo

echo "--- the client's page ---"
curl -fsS -o /dev/null -w "status=%{http_code} type=%{content_type}\n" "${BASE}/"

echo "--- the compiler ---"
docker exec freelatex-probe tectonic --version

echo "--- a project ---"
PROJECT=$(curl -fsS -X POST "${BASE}/api/projects" \
  -H "authorization: Bearer ${KEY}" \
  -H 'content-type: application/json' \
  -d '{"title":"Docker probe"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "project=${PROJECT}"

echo "--- a document ---"
curl -fsS -X PUT "${BASE}/api/projects/${PROJECT}/files/main.tex" \
  -H "authorization: Bearer ${KEY}" \
  -H 'content-type: application/json' \
  -d '{"content":"\\documentclass{article}\n\\begin{document}\nHello from Docker.\n\\end{document}\n"}' >/dev/null
echo "written"

echo "--- a compilation ---"
curl -fsS -X POST "${BASE}/api/projects/${PROJECT}/compile" \
  -H "authorization: Bearer ${KEY}" \
  -H 'content-type: application/json' \
  -d '{"mainFile":"main.tex"}' \
  -o /tmp/freelatex-probe.pdf \
  -w "status=%{http_code} type=%{content_type} size=%{size_download} time=%{time_total}s\n"

if head -c 5 /tmp/freelatex-probe.pdf | grep -q '%PDF'; then
  echo "the PDF is a real PDF"
else
  echo "the answer is not a PDF:" >&2
  head -c 400 /tmp/freelatex-probe.pdf >&2
  exit 1
fi

echo "--- the size of the image ---"
docker images "${IMAGE}" --format "{{.Size}}"

echo "--- everything works ---"
