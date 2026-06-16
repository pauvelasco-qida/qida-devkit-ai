# docker

Docker containerization expertise for Claude Code: Dockerfile optimization, security
hardening, multi-stage builds, Compose orchestration, and production deployment patterns.

## What it does

Ships the `docker-expert` skill. Claude loads it automatically when a task involves
Docker — no command to run. It applies current (2025+) best practices: multi-stage
builds, non-root users, digest-pinned base images, BuildKit cache/secret mounts,
SBOM + provenance attestations, and the Swarm-vs-plain-Compose distinctions that
silently bite (`deploy.reservations`/`restart_policy`/`replicas` are Swarm-only).

The skill triggers on phrases like:

- "write a Dockerfile", "dockerize my app", "optimize my Dockerfile"
- "add multi-stage builds", "reduce image size", "distroless image"
- "harden container security", "non-root user in container", "docker secrets"
- "set up Docker Compose", "health check in Docker", "build cache not working"
- "container won't start", "docker build is slow", "cross-platform docker build"

It defers out-of-scope work to other experts (Kubernetes, GitHub Actions, ECS/Fargate,
DB persistence) rather than guessing.

## Reference files

Loaded on demand by the skill (`skills/docker-expert/references/`):

| File | Covers |
|------|--------|
| `dockerfile-patterns.md` | Multi-stage builds, security hardening, distroless, digest pinning, OCI labels, BuildKit cache/secrets, healthchecks, multi-arch + SBOM |
| `compose-patterns.md` | Production Compose, networking, secrets, dev overrides, resource limits, Swarm caveats |
| `review-checklist.md` | Docker code-review checklist across all categories |
| `diagnostics.md` | Build/security/size/network/startup failure diagnosis |

## Installation

From the qida-devkit-ai marketplace:

```
/plugin marketplace add <path-or-url-to-qida-devkit-ai>
/plugin install docker@qida-devkit-ai
```

Or test locally:

```bash
claude --plugin-dir /path/to/qida-devkit-ai/plugins/docker
```
