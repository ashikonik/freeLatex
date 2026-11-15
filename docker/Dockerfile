# freeLatex — production image.
#
# The image holds three things: the server, the client's built files, and the
# Tectonic compiler. The server serves the client itself, so a deployment is
# one container and one origin — a browser talks to one address and no CORS
# or cookie handling is needed.
#
# The build is split into stages so that the tools used to build never reach
# the image that runs.

# ---------------------------------------------------------------- client
FROM node:22-bookworm-slim AS client

WORKDIR /build/client

# The dependencies are installed from the lock file alone, so that this layer
# is reused whenever only the source has changed.
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./

# The BusyTeX WebAssembly assets are not committed to the repository. They
# are fetched here so that the image ships the instant preview as well.
# They are large, so a build that does not need them can skip this stage
# with `--build-arg WITH_WASM=false`.
ARG WITH_WASM=true
RUN if [ "$WITH_WASM" = "true" ]; then npm run download-assets; fi

RUN npx vite build

# ---------------------------------------------------------------- server
FROM node:22-bookworm-slim AS server

WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
# better-sqlite3 is a native module, so it needs the toolchain that builds
# it. The build tools are dropped from the runtime image later.
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm ci

COPY server/ ./
RUN npx tsc -p tsconfig.build.json

# The dev dependencies are dropped here, so that the runtime stage copies
# only what the server runs on. Pruning in this stage rather than in the
# runtime one keeps the image from carrying two copies of the tree.
RUN npm prune --omit=dev && npm cache clean --force

# better-sqlite3 ships a prebuilt binary for every platform it supports,
# and the image needs only the one for this architecture.
RUN case "$(dpkg --print-architecture)" in \
      amd64) KEEP=linux-x64.node ;; \
      arm64) KEEP=linux-arm64.node ;; \
      *) KEEP=linux-x64.node ;; \
    esac \
  && PREBUILDS=node_modules/better-sqlite3/prebuilds \
  && if [ -d "$PREBUILDS" ]; then \
       find "$PREBUILDS" -name '*.node' ! -name "$KEEP" -delete; \
     fi

# ---------------------------------------------------------------- tectonic
FROM debian:bookworm-slim AS tectonic

# Tectonic is a single binary, so the compiler needs nothing from the image
# beyond the binary itself and the certificates it fetches with.
#
# The musl build is used because it is statically linked: the gnu build of
# the same version needs a newer glibc than the base image has, and the
# gnu build also pulls in the font and ICU libraries that the musl build
# carries with it.
ARG TECTONIC_VERSION=0.15.0
ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) ARCH=x86_64-unknown-linux-musl ;; \
      arm64) ARCH=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${ARCH}.tar.gz" \
      -o /tmp/tectonic.tar.gz \
  && tar -xzf /tmp/tectonic.tar.gz -C /tmp \
  && mv "/tmp/tectonic" /usr/local/bin/tectonic \
  && chmod +x /usr/local/bin/tectonic \
  && rm -f /tmp/tectonic.tar.gz \
  && /usr/local/bin/tectonic --version

# The compiler downloads its format bundle on the first run, which takes
# longer than the compilation budget a document is given. The bundle is
# fetched here instead, so that a fresh container can compile at once.
#
# The bundle is written into the image's own cache directory, and the runtime
# stage starts from that copy.
#
# Two documents are warmed, not one. The plain article covers the common
# case; the biblatex one pulls in the bibliography package and the fonts it
# wants, so that a container serving a biblatex document does not have to
# reach the network for them on its first build.
RUN mkdir -p /tectonic-cache && \
    printf '\\documentclass{article}\n\\begin{document}\nWarm the cache.\n\\end{document}\n' > /tmp/warm.tex && \
    XDG_CACHE_HOME=/tectonic-cache tectonic -X compile /tmp/warm.tex --outfmt pdf --outdir /tmp && \
    rm -f /tmp/warm.tex /tmp/warm.pdf \
  && test -d /tectonic-cache/Tectonic

# ---------------------------------------------------------------- biber
#
# Biber is the bibliography engine for biblatex documents. Tectonic runs it
# by itself: it writes the control file, invokes the program and reruns the
# engine. All the server has to do is make sure biber is on the PATH.
#
# The version is not a free choice. Biber compares the version of the
# control file against its own with string equality — not "at least" — and
# refuses to run when they differ. Tectonic's bundle is frozen at TeX Live
# 2022, which carries biblatex 3.17 and writes a control file of version
# 3.8. The only biber that accepts version 3.8 is biber 2.17.
#
# The distributions do not ship it: Debian has 2.18 (bookworm) and 2.20
# (trixie), Ubuntu has 2.17 (jammy), and both are Perl programs that drag
# in about thirty Perl modules. Upstream also builds a self-contained
# Linux binary that carries its own libraries, so the image needs neither
# Perl nor the modules — only the binary.
FROM debian:bookworm-slim AS biber

ARG BIBER_VERSION=2.17
ARG BIBER_URL=https://sourceforge.net/projects/biblatex-biber/files/biblatex-biber/2.17/binaries/Linux/biber-linux_x86_64.tar.gz

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "$BIBER_URL" -o /tmp/biber.tar.gz \
  && tar -xzf /tmp/biber.tar.gz -C /tmp \
  && install -m 0755 /tmp/biber /usr/local/bin/biber \
  && rm -rf /tmp/biber /tmp/biber.tar.gz \
  && biber --version

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime

# The runtime needs the certificates to reach the model providers and to
# fetch a project's packages, and the font configuration the compiler reads
# when it embeds a font in the document. Nothing else: the compiler and the
# bibliography engine are both self-contained binaries, and the server
# needs no shared library beyond libc.
#
# Biber is opt-in. A deployment that only builds classic BibTeX documents
# does not need it, and can leave it out with `--build-arg WITH_BIBER=false`.
ARG WITH_BIBER=true

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates fontconfig \
  && rm -rf /var/lib/apt/lists/*

# The application runs as an unprivileged user, because a server that compiles
# a document should not be able to write anywhere it likes.
RUN groupadd --system --gid 1001 freelatex \
  && useradd --system --uid 1001 --gid freelatex --create-home --home-dir /home/freelatex freelatex

ENV NODE_ENV=production \
    PORT=3030 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/public \
    XDG_CACHE_HOME=/home/freelatex/.cache

WORKDIR /app

# better-sqlite3 is a native module, so it is built where the toolchain is
# and the finished tree is copied here rather than rebuilt. The dev
# dependencies are dropped in the build stage, so only what the server runs
# on is copied.
COPY --from=server --chown=freelatex:freelatex /build/server/node_modules ./node_modules
COPY --from=server --chown=freelatex:freelatex /build/server/package.json ./
COPY --from=server --chown=freelatex:freelatex /build/server/dist ./dist
COPY --from=client --chown=freelatex:freelatex /build/client/dist ./public
COPY --from=tectonic /usr/local/bin/tectonic /usr/local/bin/tectonic

# The bibliography engine is copied in rather than installed here: the one
# that pairs with the compiler's biblatex is a specific version, and it is
# built in its own stage so that the runtime image carries no Perl.
COPY --from=biber /usr/local/bin/biber /usr/local/bin/biber

# The compiler's format bundle was fetched while the image was built. The
# runtime stage starts from that copy, so a document compiles at once.
COPY --from=tectonic --chown=freelatex:freelatex /tectonic-cache /home/freelatex/.cache

# The biblatex path is checked while the image is built: a document that
# asks for biber is compiled with the very tools the image ships. A build
# that cannot do that fails here rather than in a reader's document.
#
# Two checks, because there are two halves. The shell check proves that the
# compiler and the engine fit together; the probe proves that the server
# finds the engine and gets a document with a bibliography out of it.
#
# The checks run as the application user, against the very cache the
# server will use. Anything the compiler downloads while they run — the
# bibliography package and the fonts it wants — is therefore already in
# the cache the server starts from, and already owned by the user that
# will read it.
COPY docker/biblatex-check.sh /usr/local/bin/biblatex-check
COPY scripts/biber-probe.mjs /usr/local/bin/biber-probe
RUN mkdir -p /app/data && chown freelatex:freelatex /app/data
USER freelatex
RUN if [ "$WITH_BIBER" = "true" ]; then \
      /usr/local/bin/biblatex-check \
      && node /usr/local/bin/biber-probe /app/dist; \
    fi

EXPOSE 3030

# The health check asks the server whether it is up, so that a container
# that has started but cannot serve is reported as failing rather than as
# healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3030)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
