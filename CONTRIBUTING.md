# Contributing

Issues and pull requests are welcome.

## Ground rules

- **The policy engine decides, not the model.** Any change that lets model output or email content influence a risk level or an execute/suggest decision will not be merged.
- **Level 3 stays level 3.** No setting, flag or override may make a dangerous action automatic.
- **Discovery is read-only.** Code that runs during onboarding may only call tools that `isDiscoverySafe()` accepts.
- **No new built-in integrations when an MCP server can do it.** Executors are the user's own MCP servers. Built-ins are limited to things MCP cannot do well (Claude Code worktrees, macOS Reminders).

## Workflow

```bash
npm ci            # also enables the git hooks
npm test          # unit + integration + e2e
npm run test:all  # plus the real installer and the menu bar app
```

The pre-commit hook runs typecheck and the main suites; the pre-push hook and CI run everything on macOS and Linux. A change is not done until all of them pass.

Every change needs tests at the right layer: unit for logic, integration when it crosses a process or the file system, e2e when it changes what the `ibo` command or the daemon does. Changes to `src/policy`, `src/pipeline/router.ts` or `src/models/router.ts` always need unit tests.
