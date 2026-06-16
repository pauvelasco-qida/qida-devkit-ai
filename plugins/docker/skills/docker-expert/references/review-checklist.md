# Docker Code Review Checklist

## Dockerfile Optimization & Multi-Stage Builds

- [ ] Dependencies copied before source code (layer caching)
- [ ] Multi-stage builds separate build and runtime environments
- [ ] Production stage only includes necessary artifacts
- [ ] `.dockerignore` exists and covers `node_modules/`, `.git/`, `dist/`, `.env*`
- [ ] Base image appropriate: Alpine/distroless for production, full for development
- [ ] RUN commands consolidated where beneficial; cache cleaned in same layer
- [ ] No `apt-get install` without `rm -rf /var/lib/apt/lists/*` in same layer
- [ ] `npm ci --omit=dev` used instead of `npm install` (deterministic, no dev deps in prod; `--only=production` is deprecated)
- [ ] Base image on a supported version (no EOL: `node:18`, `python:3.11` past EOL)

## Container Security Hardening

- [ ] Non-root user created with explicit UID/GID (not default `nobody`)
- [ ] `USER <uid>` set before CMD/ENTRYPOINT
- [ ] Secrets not in ENV vars, ARGs, or image layers
- [ ] No hardcoded credentials anywhere in Dockerfile
- [ ] Base image pinned by digest (`@sha256:...`), not a mutable tag or `:latest`
- [ ] HEALTHCHECK implemented with a probe the base image actually has (no `curl` on alpine/distroless)
- [ ] Minimal attack surface: only necessary packages installed
- [ ] OCI labels set (`org.opencontainers.image.source`/`revision`/`version`)
- [ ] Dockerfile passes `hadolint`; image scanned (Trivy / `docker scout`) with no critical CVEs
- [ ] SBOM + provenance attestations attached for published images (`buildx --sbom --provenance`)

## Docker Compose & Orchestration

- [ ] `depends_on` uses `condition: service_healthy` (not just `service_started`)
- [ ] All services have `healthcheck` defined
- [ ] Backend networks marked `internal: true`
- [ ] Sensitive values use Docker secrets, not `environment:` block
- [ ] `deploy.resources.limits` defined (prevent resource exhaustion)
- [ ] Restart policy set: top-level `restart:` (plain Compose) or `deploy.restart_policy` (Swarm only)
- [ ] No reliance on `deploy.reservations`/`replicas` outside Swarm (silently ignored by `docker compose up`)
- [ ] Volumes named (not anonymous) for persistent data
- [ ] Dev overrides in separate `docker-compose.override.yml`

## Image Size & Performance

- [ ] Final image size checked: Node <200MB, Python <200MB, Go <50MB (targets, not limits)
- [ ] Build cache optimization implemented (`--mount=type=cache`)
- [ ] Build context minimal (`.dockerignore` covers non-essential files)
- [ ] Multi-stage: build tools absent from production image
- [ ] Package manager cache cleaned in same RUN layer

## Development Workflow Integration

- [ ] Development target separate from production (`target: development`)
- [ ] Anonymous volume for `node_modules` / compiled artifacts
- [ ] Debug port exposed in dev config
- [ ] Hot reload configured with source bind-mount
- [ ] Dev-only tools (nodemon, watchdog) not in production stage

## Networking & Service Discovery

- [ ] Port exposure limited: only necessary ports published to host
- [ ] Service names follow DNS-safe conventions (no underscores)
- [ ] Internal services on `internal: true` network
- [ ] Health check endpoints exist in application code (`/health`, `/ready`)
- [ ] No port conflicts with common dev services (3000, 5432, 6379, 8080)
