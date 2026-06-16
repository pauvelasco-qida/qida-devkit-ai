---
name: docker-expert
description: This skill should be used when the user asks to "write a Dockerfile", "dockerize my app", "optimize my Dockerfile", "add multi-stage builds", "reduce image size", "harden container security", "non-root user in container", "set up Docker Compose", "docker-compose configuration", "docker build is slow", "container won't start", "container failing", "docker secrets", "health check in Docker", "build cache not working", "cross-platform docker build", "distroless image", or any Docker containerization task.
category: devops
---

Advanced Docker containerization expertise covering Dockerfile optimization, security hardening, multi-stage builds, Compose orchestration, and production deployment patterns.

## Scope Boundaries

Stop and flag if the task is primarily outside Docker containerization:

- **Kubernetes** (pods, services, ingress, deployments)
- **GitHub Actions CI/CD** pipeline logic beyond the container build step
- **AWS ECS/Fargate** or cloud-specific container services
- **Database persistence strategies** beyond basic containerization

Output format:
```
This is primarily a [X] task, outside Docker scope. [Docker-relevant note, if any.]
```
If a matching expert skill is available in the environment, suggest it; otherwise just flag the boundary.

## Environment Analysis

Use internal tools first (Read, Grep, Glob). Fall back to shell only when needed.

```bash
# Docker environment
docker --version 2>/dev/null || echo "No Docker installed"
docker info | grep -E "Server Version|Storage Driver|Container Runtime" 2>/dev/null

# Project structure
find . -name "Dockerfile*" -type f | head -10
find . \( -name "*compose*.yml" -o -name "*compose*.yaml" \) -type f | head -5
find . -name ".dockerignore" -type f | head -3

# Container status
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null | head -10
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>/dev/null | head -10
```

Adapt approach based on findings:
- Match existing Dockerfile patterns and base images
- Respect existing multi-stage build conventions
- Account for dev vs production environment split
- Consider existing Compose/Swarm orchestration

## Problem Categories

Identify which category applies before acting:

| Category | Key Symptoms | Primary Reference |
|----------|-------------|-------------------|
| **Dockerfile optimization** | Slow builds, cache misses, large images | `references/dockerfile-patterns.md` |
| **Security hardening** | Root execution, exposed secrets, scan failures | `references/dockerfile-patterns.md` |
| **Compose orchestration** | Service startup order, network issues, env management | `references/compose-patterns.md` |
| **Image size** | Images >1GB, slow pulls/deploys | `references/dockerfile-patterns.md` |
| **Dev workflow** | Hot reload failures, debug port issues | `references/compose-patterns.md` |
| **Performance** | Resource exhaustion, slow runtime | `references/compose-patterns.md` |
| **Review** | Code review, audit | `references/review-checklist.md` |
| **Diagnostics** | Unknown failures | `references/diagnostics.md` |

## Core Expertise Areas

### 1. Dockerfile Optimization

Key principles (details in `references/dockerfile-patterns.md`):
- Copy dependency manifests before source code — cache dependencies separately
- Use multi-stage builds: `deps` → `build` → `runtime`
- Production stage: only copy compiled artifacts and production deps
- Consolidate RUN commands to minimize layers
- Clean package manager caches in the same RUN layer

### 2. Security Hardening

Non-negotiable security baselines:
- Create a non-root user with explicit UID/GID (1001 by default)
- Always set `USER <uid>` before CMD/ENTRYPOINT
- Never store secrets in ENV vars, ARGs, or image layers
- Use `--mount=type=secret` (BuildKit) for build-time secrets
- Pin base images by digest (`@sha256:`); add OCI labels (`org.opencontainers.image.*`) for provenance
- Implement HEALTHCHECK with a probe the image has (no `curl` on alpine/distroless — use wget or an exec probe)

### 3. Compose Orchestration

Production Compose patterns (details in `references/compose-patterns.md`):
- `depends_on` with `condition: service_healthy` — not just `service_started`
- Separate frontend/backend networks; mark backend as `internal: true`
- Use Docker secrets for sensitive values, not environment variables
- Define `deploy.resources.limits` to prevent exhaustion (`reservations` is Swarm-only)
- Restart policy: top-level `restart:` for plain Compose (`deploy.restart_policy` is Swarm-only)

### 4. Base Image Selection

Decision tree:
1. **Development**: `node:22` / `python:3.12` — full tooling (current LTS; avoid EOL `node:18`/`python:3.11`)
2. **Production (small, needs shell)**: `node:22-alpine` / `python:3.12-alpine`
3. **Production (security-critical)**: `gcr.io/distroless/*` — no shell, no package manager
4. **Minimal binaries**: `scratch` — static binaries only

### 5. Build Performance

Cache optimization patterns:
- `--mount=type=cache` for package manager caches (BuildKit)
- `.dockerignore` to minimize build context — always include `node_modules/`, `.git/`, `dist/`
- Multi-architecture: `docker buildx` with `--platform linux/amd64,linux/arm64`
- Supply chain: attach SBOM + provenance — `docker buildx build --sbom=true --provenance=mode=max`

## Validation Protocol

After implementing changes, validate:

```bash
# Lint the Dockerfile (if available)
hadolint Dockerfile 2>/dev/null || echo "No hadolint"

# Build validation
docker build --no-cache -t test-build . && echo "Build OK"
docker history test-build --no-trunc | head -5

# Security scan (if available)
docker scout quickview test-build 2>/dev/null || echo "No Docker Scout"
trivy image --severity HIGH,CRITICAL test-build 2>/dev/null || echo "No Trivy"

# Runtime validation
docker run --rm -d --name validation-test test-build
docker exec validation-test ps aux | head -3
docker exec validation-test id  # Verify non-root
docker stop validation-test

# Compose validation (v2 plugin syntax; v1 `docker-compose` is EOL)
docker compose config && echo "Compose config valid"
```

## Additional Resources

### Reference Files

- **`references/dockerfile-patterns.md`** — Multi-stage build patterns, security hardening templates, distroless examples, build cache techniques
- **`references/compose-patterns.md`** — Production Compose templates, networking, secrets, dev workflow overrides, resource management
- **`references/review-checklist.md`** — Complete Docker code review checklist across all categories
- **`references/diagnostics.md`** — Common failure diagnostics: build performance, security vulnerabilities, image size, networking, dev workflow
