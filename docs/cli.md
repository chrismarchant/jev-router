# CLI reference

`bin/jev-router.js` (npm bin: `jev-router`). JSON on stdout (pretty by default, `--compact` for one line); errors on stderr with exit 1; unknown command exits 2. Any `--value` starting with `@` is read from that file.

```
jev-router models [--timeout-ms N]
jev-router ask      --state <text|json|@file> --questions <json|@file> [--model M] [--assets <json|@file>] [--headers <json|@file>] [--timeout-ms N] [--compact]
jev-router fan-out  --state … --questions … [--min-confidence F] [--noul-confidence] [--compact]
jev-router plan     --task <text|@file> --candidates <json|@file> [--files <json|@file>] [--lanes <json|@file>] [--weights <json>] [--max-candidates N] [--model M]
jev-router route    --item <text|json|@file> --destinations <json|@file> [--threshold F] [--confidence-floor F] [--model M]
jev-router review   --output <text|json|@file> --criteria <json|@file> [--rubric <json>] [--pass-threshold F] [--fail-below F] [--model M]
jev-router batch    --items <json|@file> [--concurrency N] [--model M]
jev-router box      --image <path|base64> --instructions <text> [--format png|jpg|jpeg] [--model M]
jev-router draft-options --topic <text> [--context <text>] [--count N] [--model M]   # needs MISTRAL_API_KEY
jev-router help
```

Positional shorthand: `ask --state`/`plan --task`/`route --item`/`review --output`/`draft-options --topic` also accept the first positional argument. `--model` on Jev commands defaults to `TYPESAFE_MODEL`/`jev-latest`; on `draft-options` to `JEV_ROUTER_DRAFT_MODEL`/`mistral-small-latest`.

Examples: [examples/README.md](../examples/README.md) and [docs/examples.md](examples.md).
