# Contributing

Issues and pull requests are welcome.

## Ground rules

- **The policy engine decides, not the model.** Any change that lets model output or email content influence a risk level or an execute/suggest decision will not be merged.
- **Level 3 stays level 3.** No setting, flag or override may make a dangerous action automatic.
- **Discovery is read-only.** Code that runs during onboarding may only call tools that `isDiscoverySafe()` accepts.
- **No new built-in integrations when an MCP server can do it.** Executors are the user's own MCP servers. Built-ins are limited to things MCP cannot do well (Claude Code worktrees, macOS Reminders).

## Workflow

```bash
npm install
npm run typecheck
npm test
```

Add tests for anything that touches `src/policy`, `src/pipeline/router.ts` or `src/models/router.ts`.
