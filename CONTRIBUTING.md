# Contributing

## `main` is protected

Every change goes through a pull request — CI must pass and a review is required
before anything merges, including from the maintainer's own tooling. See the main
`realtime-collab-doc-editor` project's CONTRIBUTING.md for the full fork → branch →
PR workflow if you're new to this; the mechanics are identical here.

## Before you open a PR

1. **Read the README's "hardest decisions" section.** It explains why the Lua
   scripts are structured the way they are, and what trade-off each algorithm makes.
   A PR that "simplifies" the Redis logic back into separate GET/SET calls will
   reintroduce the exact race condition this project exists to prevent.
2. **Run the two correctness scripts locally** before pushing:
   `npm run test:multi-instance` and `npm run test:boundary-burst`. Both spin up
   their own throwaway processes and don't need anything else running first (besides
   Redis).
3. **If you're touching a rate-limiting algorithm**, the change needs to stay
   atomic — the whole check-and-update sequence has to happen inside the Lua script,
   not split across multiple Redis calls from the Node side.

## License

MIT
