# Dockerfile Patterns

## Multi-Stage Build (Node.js)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
WORKDIR /app
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/dist ./dist
COPY --from=build --chown=nextjs:nodejs /app/package*.json ./
USER nextjs
EXPOSE 3000
# alpine has no curl — BusyBox wget is built in (see Health Check Strategies)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --start-interval=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
```

## Security Hardening

```dockerfile
FROM node:22-alpine
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
WORKDIR /app
COPY --chown=appuser:appgroup package*.json ./
RUN npm ci --omit=dev
COPY --chown=appuser:appgroup . .
USER 1001
EXPOSE 3000
```

Key rules:
- Always use explicit UID/GID, not symbolic names only
- `--chown` on every COPY to avoid root-owned files
- Never `RUN chmod -R 777` or `RUN chown -R root`
- Avoid `sudo` entirely — if a step needs it, the image design is wrong
- `npm ci --omit=dev` for production installs (`--only=production` is deprecated since npm 7)

## Digest Pinning

A tag like `node:22-alpine` is mutable — it can change under you, breaking reproducibility
and slipping in unreviewed base-image changes. Pin by digest for reproducible, tamper-evident
builds; the digest only moves when you explicitly update it.

```dockerfile
FROM node:22-alpine@sha256:<digest> AS build
```

Get the current digest:
```bash
docker buildx imagetools inspect node:22-alpine --format '{{.Manifest.Digest}}'
```

Let Renovate or Dependabot raise PRs that bump the digest, so pins stay patched without manual
tracking.

## OCI Image Labels

Standard metadata so registries and scanners can trace an image back to its source/commit:

```dockerfile
ARG VCS_REF
ARG VERSION
LABEL org.opencontainers.image.source="https://github.com/org/repo" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"
```

`docker buildx build` auto-populates several of these from Git context; supply the rest via
`--build-arg VCS_REF=$(git rev-parse --short HEAD)`.

## Minimal Production Image (Distroless)

```dockerfile
# gcr.io/distroless has no shell, no package manager — minimal attack surface
FROM gcr.io/distroless/nodejs22-debian12
COPY --from=build /app/dist /app
COPY --from=build /app/node_modules /app/node_modules
WORKDIR /app
EXPOSE 3000
CMD ["index.js"]
```

> Distroless has **no shell and no curl/wget** — a `CMD curl ...` healthcheck silently fails.
> Use an exec-form probe via the app runtime (see Health Check Strategies) or a
> Compose/orchestrator-level healthcheck.

### When to use distroless vs alpine

| Criterion | Alpine | Distroless |
|-----------|--------|-----------|
| Need shell for debugging | ✓ | ✗ |
| Security-critical prod | ✗ | ✓ |
| Size priority | Alpine (~5MB) | Distroless (~20-50MB) |
| Package manager needed | ✓ | ✗ |
| CVE surface | Low | Minimal |

## Build Cache Optimization

### Package manager caches (BuildKit)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
```

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS deps
WORKDIR /app
COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
```

### Faster cache reuse with COPY --link

`COPY --link` writes copied files as an independent layer that survives changes to earlier
layers (and base-image bumps), so rebuilds and `--cache-from` reuse more cache:

```dockerfile
COPY --link --from=build /app/dist ./dist
```

Use it for artifact copies in the runtime stage. Requires BuildKit and the
`# syntax=docker/dockerfile:1` header.

### Build-time secrets (BuildKit)

```dockerfile
# syntax=docker/dockerfile:1
FROM alpine
RUN --mount=type=secret,id=api_key \
    API_KEY=$(cat /run/secrets/api_key) && \
    # Use API_KEY — never persisted in image layer
    echo "secret consumed"
```

Invoke with: `docker build --secret id=api_key,src=./secret.txt .`

## .dockerignore Best Practices

Always include:

```
node_modules/
.git/
.gitignore
dist/
build/
*.log
.env
.env.*
coverage/
.nyc_output/
.DS_Store
Thumbs.db
*.md
tests/
docs/
```

> Caution: `*.md`, `tests/`, and `docs/` are aggressive — drop them if the build COPYs those
> (a README baked into the image, a dedicated test stage, or docs generated at build time).

## Health Check Strategies

The image must actually contain the probe binary. `curl` is **not** in `*-alpine` or distroless
images, and distroless has no shell at all — so the common `CMD curl -f ...` healthcheck silently
fails on the very images this skill recommends. Pick the form that matches the base:

Alpine (BusyBox `wget` is built in, no extra package):
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --start-interval=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
```
`--start-interval` (Docker 25+) probes more frequently during `start-period` for faster readiness.

Shell image that genuinely needs curl — install it explicitly:
```dockerfile
RUN apk add --no-cache curl
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

Distroless (no shell — use the app runtime in exec form):
```dockerfile
# healthcheck.js: http.get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1))
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD ["node", "healthcheck.js"]
```

TCP port check (BusyBox `nc`, shell images):
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD nc -z localhost 3000 || exit 1
```

Script-based (complex checks, shell images only):
```dockerfile
COPY health-check.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/health-check.sh
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/health-check.sh"]
```

For orchestrated stacks, prefer a Compose/Swarm-level `healthcheck` (see `compose-patterns.md`)
so the probe sits next to `depends_on: condition: service_healthy`.

## Multi-Architecture Builds

```bash
docker buildx create --name multiarch-builder --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t myapp:latest \
  --push .
```

Attach SBOM + provenance attestations for supply-chain traceability (BuildKit):
```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --sbom=true \
  --provenance=mode=max \
  -t myapp:latest --push .
```
`docker scout` and Trivy read the attached SBOM directly — no separate scan artifact needed.

Add to Dockerfile for platform-aware builds:
```dockerfile
ARG TARGETPLATFORM
ARG BUILDPLATFORM
RUN echo "Building on $BUILDPLATFORM for $TARGETPLATFORM"
```

## Python Multi-Stage

```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

FROM python:3.12-slim AS runtime
RUN addgroup --gid 1001 appgroup && \
    adduser --uid 1001 --gid 1001 --no-create-home appuser
WORKDIR /app
COPY --from=builder /root/.local /home/appuser/.local
COPY --chown=appuser:appgroup . .
USER appuser
ENV PATH=/home/appuser/.local/bin:$PATH
CMD ["python", "-m", "app"]
```

### venv variant (PEP 668-safe)

Debian 12 (`python:3.12-slim`) marks its system environment "externally managed" (PEP 668),
which can make `pip install` refuse to run. A virtualenv sidesteps that and copies cleanly
between stages as a single self-contained directory:

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder
WORKDIR /app
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

FROM python:3.12-slim AS runtime
RUN addgroup --gid 1001 appgroup && \
    adduser --uid 1001 --gid 1001 --no-create-home appuser
COPY --from=builder /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY --chown=appuser:appgroup . .
USER appuser
CMD ["python", "-m", "app"]
```
