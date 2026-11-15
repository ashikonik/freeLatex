# Deploying freeLatex on a free cloud service

freeLatex is one container on one port: the API, the client's files and the
LaTeX compiler all live in the same image, and the server hands out the
client's files itself. A browser therefore talks to a single origin, and no
cross-origin rules or cookie handling are involved.

## Share from your own PC

A share link does not need a cloud service to work. The link is a URL, and
any URL that a co-editor's browser can reach will do — including one that
points at your own machine over the public internet.

The tunnel is [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
which offers a *quick tunnel*: no account, no card, no configuration. It
gives a public HTTPS address that forwards to a port on your machine.

```sh
# 1. The server, with the client attached.
#
#    STATIC_DIR is what makes the deep link work. Without it the server has
#    no client to hand out, and /p/{id} answers 404 instead of the
#    application.
PORT=3030 \
STATIC_DIR=client/dist \
  npm run dev:server

# 2. The tunnel, in another terminal.
cloudflared tunnel --url http://127.0.0.1:3030
```

The tunnel prints a public address:

```
https://approaches-scholars-clan-tion.trycloudflare.com
```

Open the application at that address, mint a share link from the project's
**Share** menu, and send the link. The co-editor opens it and works in the
same document, live.

Three things to know about this arrangement:

- **The address changes every time you restart the tunnel.** A link minted
  against the old address stops working. Mint the share link after the
  tunnel is up, and share the new link.
- **The tunnel lives as long as the process.** When your machine sleeps, or
  you close the terminal, the address stops answering. The Oracle
  deployment below has neither problem, which is why it is the better home
  for a document you care about.
- **Your machine is the server.** The compiler runs on your hardware, and
  anything the co-editor writes lands in your database. That is the point,
  but it also means your machine has to stay awake for as long as they are
  working.

`npm run share:public` does the first two steps together — it builds the
client, starts the server with `STATIC_DIR` set, and opens the tunnel.

## What a free tier has to provide

Most free tiers cannot run this application, and the reason is almost always
the same one. Two things are needed:

| Requirement | Why |
| --- | --- |
| **WebSocket support** | The collaborative editor's socket lives at `/ws/{room}`. Without it the editor falls back to polling: no live cursors, no shared document, and the co-editors do not really co-edit. |
| **A persistent disk** | The SQLite database and the projects' files live in `/app/data`. On a tier whose filesystem is wiped on every deploy, every document the owner writes disappears. |

Add to that a container that can hold a 775 MB image and a TeX engine that
wants about 190 MB of memory while it compiles, and the field narrows quickly.
(The 775 MB figure is the image without the in-browser preview. With it the
image is 2.03 GB; without the bibliography engine it is 623 MB.)

| Service | WebSockets | Persistent disk | Verdict |
| --- | --- | --- | --- |
| **Oracle Cloud Always Free** | yes (it is a real VM) | 200 GB block volume | **Workable — the best fit** |
| **Railway, free plan** | yes | 0.5 GB volume | Workable in principle, but 0.5 GB of RAM is too tight: the compiler alone peaks near 190 MB and the server another 41 MB |
| Render, free | yes | none | Not workable — no disk |
| Koyeb, free | yes | none (volumes are a paid feature) | Not workable — no disk |
| Fly.io | yes | volumes are paid | Not workable — there is no free tier any more |
| Hugging Face Spaces | yes | none unless a paid storage bucket is attached | Not workable — Docker Spaces are behind the paid plan |
| Google Cloud Run | yes | none | Not workable — no disk |
| Azure Container Apps | yes | none | Not workable — no disk |

## Oracle Cloud Always Free

Oracle's free tier gives a real virtual machine, and that is what makes it
the right home for this application: there is no platform in the way, so
there is no limit on the image, the disk is a real block volume, and the
reverse proxy can be configured as it should be.

### 1. Create the machine

In the console, under **Compute → Instances → Create instance**:

- **Shape:** `VM.Standard.A1.Flex` (Ampere, ARM).
- **OCPU / memory:** 2 OCPU and 12 GB. This is the whole free allocation, so
  it is also the ceiling — do not ask for more.
- **Image:** Oracle Linux 9, marked *Always Free Eligible*.
- **Boot volume:** the default 47 GB is enough.
- **Networking:** a VCN with a public IP. Open TCP 22, 80 and 443.
- **SSH key:** your own public key.

If the console says **out of host capacity**, the shape is simply not
available in that availability domain. Try another one — `eu-frankfurt-1`,
`uk-cardiff-1` and `us-ashburn-1` are usually the least crowded — or try at
a different hour. This is the usual reason a first attempt fails, and it is
not a fault in the setup.

### 2. Add a block volume

The boot volume is wiped when the machine is rebuilt. The documents must not
be, so a separate volume holds them:

- **Storage → Block Volumes → Create volume**, 50 GB or more, in the same
  availability domain as the machine.
- Attach it to the instance and enable the automatic boot policy.

### 3. Install Docker and mount the volume

```bash
ssh opc@<the-instance's-public-ip>

sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker opc
newgrp docker

# The volume appears as /dev/oracleoci/oraclevdb.
sudo mkdir -p /mnt/data/freelatex
sudo mount /dev/oracleoci/oraclevdb /mnt/data/freelatex
echo '/dev/oracleoci/oraclevdb /mnt/data/freelatex xfs defaults,nofail 0 2' \
  | sudo tee -a /etc/fstab

# The container runs as UID 1001, so the volume has to belong to it.
sudo chown -R 1001:1001 /mnt/data/freelatex
```

### 4. Run the container

The image is built on the machine, which is slow but needs no registry:

```bash
cd /opt/freeLatex    # wherever the repository was cloned
export ADMIN_API_KEY="$(openssl rand -hex 32)"
echo "$ADMIN_API_KEY" > /root/freelatex-admin-key

WITH_WASM=false docker compose -f docker/docker-compose.host.yml up -d --build
```

`WITH_WASM=false` leaves out the 727 MB of in-browser WebAssembly assets.
The editor then offers the **server-side Tectonic build**, which is the
same engine the image already carries. Set `WITH_WASM=true` if the instant
in-browser preview is wanted and there is disk to spare.

The key that was generated is the owner's credential — keep it, and do not
put it in the repository.

### 5. The bibliography engine

The image carries `biber`, the engine that builds the bibliography of a
`biblatex` document. Tectonic runs it by itself: it writes the control file,
calls the program and reruns the engine. Without it, a `biblatex` document
is refused with a message that says what is missing rather than with a TeX
error.

Two build flags control it:

| Flag | Effect |
| --- | --- |
| `WITH_BIBER=true` (the default) | The engine is in the image, and `biblatex` documents build. |
| `WITH_BIBER=false` | The engine is left out, and the image is 152 MB smaller. Classic BibTeX documents still build. |

The version is not a free choice, and this is worth knowing before the
engine is ever replaced by hand. Biber compares the version of the control
file against its own with **string equality**, not "at least". Tectonic's
bundle is frozen at TeX Live 2022, which carries `biblatex` 3.17 and writes a
control file of version 3.8 — and the only biber that accepts version 3.8
is biber **2.17**. The distributions ship other versions: Debian has 2.18
(bookworm) and 2.20 (trixie), Ubuntu has 2.17. A `biber` from the package
manager and a biber that works are therefore different things.

The image installs upstream's own Linux binary, which carries its libraries
with it, so the runtime image needs no Perl. `docker/Dockerfile` explains the
choice in full.

The build proves the pairing. `docker/biblatex-check.sh` compiles a
`biblatex` document with the very tools the image ships, and
`scripts/biber-probe.mjs` does the same through the server's own code. Both
run while the image is built, so an image that cannot build a `biblatex`
document never leaves the builder.

### 6. Put TLS in front

The editor is served over the internet, so it needs HTTPS. Caddy obtains and
renews the certificate on its own:

```bash
sudo dnf install -y 'dnf-command(copr)'
sudo dnf copr enable -y @caddy/caddy
sudo dnf install -y caddy

sudo cp docker/caddy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/freelatex.example.com/your-domain.example/' /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
```

The domain has to point at the instance's public IP. If it does not, the
certificate will not be issued and the proxy will not start.

### 7. Open the firewall

Oracle's default security list allows SSH only. **Networking → Virtual Cloud
Networks → VCN → Security Lists → Add Ingress Rules** for TCP 80 and 443
from `0.0.0.0/0`.

## Railway, free plan

Railway is the one hosted option that has both WebSockets and a persistent
disk. It is a reasonable second choice, but the memory is tight.

- The image is uploaded, so it must be under Railway's 4 GB limit — both
  variants fit.
- The container runs as UID 1001 and Railway's volume is owned by root, so
  the volume's permissions have to be relaxed, or the variable
  `RAILWAY_RUN_UID=0` has to be set.
- **0.5 GB of RAM is the real constraint.** The compiler peaks near 190 MB
  and the server another 41 MB; a document that is compiled while another is
  being compiled will not fit. The compiler's own limit of four concurrent
  builds should be lowered to one on this tier.
- The free plan gives no custom domain, so the address is a
  `*.up.railway.app` one, and the volume's data is deleted 30 days after
  the free plan expires.

## After the deployment

The owner signs in at the instance's address with the master key, creates a
project, and presses **Share** to mint a link. The link is a URL of the form
`/p/{projectId}?token=rw_...`; it is sent to the co-editors as it is, and
opening it takes them straight into the editor, with no account to create
and no key to hand out.

A link may be given an expiry date and may be revoked at any time from the
same panel. A read-only link lets the reader watch and follow the cursor
but not type.

## Keeping the instance alive

Oracle reclaims an Always Free instance that has been idle: if over a
seven-day window its CPU, network and memory all stay below 20% of the
allocation, it may be stopped and its disk released. An instance that is
being used to edit documents does not qualify. To be safe, run a small
pinger against the instance's health endpoint from elsewhere:

```bash
*/6 * * * * curl -fsS https://your-domain.example/api/health >/dev/null
```

A cron job on a second machine, or a free scheduled-job service, is enough.

## Checking that the deployment works

The health endpoint answers whether the server is up:

```bash
curl -fsS https://your-domain.example/api/health
```

The share probe checks the whole path — that a link opens the project, that
it reads the files, that the collaboration socket opens, and that a link
cannot reach a project it was not minted for:

```bash
node scripts/share-probe.mjs https://your-domain.example "$(cat /root/freelatex-admin-key)"
```

The probe expects the owner's master key, so it needs the instance to be in
single-user mode.
