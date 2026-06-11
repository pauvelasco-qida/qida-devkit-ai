# qida-devkit-ai

Internal Claude Code plugin marketplace for Qida app development.

## Structure

```
qida-devkit-ai/
├── .claude-plugin/
│   └── marketplace.json      # Marketplace manifest (lists all plugins)
├── plugins/
│   └── qida-dev/             # One directory per plugin
│       ├── .claude-plugin/
│       │   └── plugin.json   # Plugin manifest
│       ├── commands/         # Slash commands (.md files)
│       ├── agents/           # Subagents (.md files)
│       ├── skills/           # Skills (one dir per skill, with SKILL.md)
│       └── hooks/            # hooks.json + scripts
└── README.md
```

## Install the marketplace

From GitHub:

```
/plugin marketplace add pauvelasco-qida/qida-devkit-ai
```

Or from a local clone:

```
/plugin marketplace add <path-to-your-clone-of-qida-devkit-ai>
```

Then install plugins:

```
/plugin install qida-dev@qida-devkit-ai
```

Verify with `/hello-qida`.

## Add a new plugin

1. Create `plugins/<plugin-name>/.claude-plugin/plugin.json` with at least a `name` field (kebab-case).
2. Add components in `commands/`, `agents/`, `skills/`, or `hooks/` at the plugin root (not inside `.claude-plugin/`). They are auto-discovered.
3. Register the plugin in `.claude-plugin/marketplace.json` under `plugins` with `"source": "./plugins/<plugin-name>"`.
4. Refresh with `/plugin marketplace update qida-devkit-ai`.

### Conventions

- kebab-case for all plugin, command, agent, and skill names.
- Use `${CLAUDE_PLUGIN_ROOT}` for any path inside hook commands or scripts — never absolute paths.
- Bump `version` in `plugin.json` (semver) when changing a plugin.

## Plugins

| Plugin | Description |
|---|---|
| `qida-dev` | Core development conventions and commands for Qida apps |
| `qida-base` | QidaBase local-dev commands: faker dev stack and ScreeningCall DB operations |
| `git-guard` | Branch protection: blocks pushes to main/master/develop from Claude and installs a reusable git pre-push hook |
