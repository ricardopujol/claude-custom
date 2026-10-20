# Contributing

This is how the project is worked on. It's more process than a small project usually has, because most of the code is written by Claude Code and the process is what keeps that honest.

## Layout

The repo is meant to sit in a container folder: `<root>\dev` is the checkout on `develop`, and every other branch you work on is a sibling folder of `dev`, made with `git worktree add`. The app opens a container as one window with a tab per worktree.

```
git worktree add ..\feat-my-change -b feat/my-change develop
```

Work in the worktree for your branch, not in `dev`. Don't use `git stash`: the stash is shared by every worktree of a repo, so a pop in one can apply another branch's changes. Commit unfinished work to its own branch instead.

## Branches and commits

- `main` is always deployable. `develop` is where work lands. Each change is a short-lived `feat/*`, `fix/*` or `chore/*` branch from `develop`.
- Open a pull request into `develop`. Nothing is pushed to `develop` or `main` directly.
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `build:`.
- Merge pull requests with a merge commit, not a squash.

## Tests

```
npm ci
npm test
```

`npm test` runs `node --test` with two files at a time, behind a machine-wide lock so that several test runs and Electron probes can't pin the CPU together. The lock is a script in `~\.claude\scripts\`. If it isn't on your machine, `npm test` says so once and runs anyway.

Write the failing test first. A fix for a review finding goes in the same commit as the test that fails without it. For a module with an invariant worth stating, add a property test with `fast-check`.

## Probes

Some things no unit test can see, such as whether a script loads in the renderer's one shared global scope, or what a panel looks like in a real window. Those have a probe in `verify/`: a re-runnable script that starts a real window with a real host and checks it. Each probe's header says what it checks and what it touches.

- Start Electron only through `verify/lib/launch-electron.js`. It takes the same lock, strips the environment variables a probe mustn't inherit, and stops the process tree it started by PID.
- Never stop a process by name. Stop only PIDs you started, with `host/kill-tree.js`.
- Never open a window with `offscreen: true`. It hangs `capturePage` here.
- A probe that spawns Electron from inside a Claude Code session must remove `ELECTRON_RUN_AS_NODE` from the environment first, or the child starts as plain Node.

`CLAUDE.md` lists the other traps this codebase has already paid for. Read it before you change anything under `app/`.

## Review

What gets reviewed depends on what the pull request changes:

- Documentation, comments, configuration and dependency bumps: no reviewer. Passing tests are the gate.
- Code that carries no logic (markup, styling, wiring, renames): one code review.
- Code that carries logic (parsers, validators, state machines, cache keys, money, time or unit maths): a logic review and a code review, in parallel.

Give a reviewer the diff (`git diff develop...HEAD`), not just the branch name. A finding fixed with its test needs no second review; at most one re-review round per pull request.

## Building the installer

`npm run build:helper` then `npm run dist`. The configuration is `build\electron-builder.yml`. A test checks that it leaves out `test`, `verify`, `forge`, `documentation`, `reports` and `.harness` (apart from the built hook helper).
