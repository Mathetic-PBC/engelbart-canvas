# E2B template migration — 2026-09-26

Rebuilt the existing runner recipes and pinned cache profile under the project
selected by the user's replacement `E2B_API_KEY`. The destination template
inventory was initially empty. All three new templates are **private** and
reported `ready` by the E2B API.

## Templates

Namespace: `davids-project-0bce`. The short aliases resolve correctly with the
replacement key; Canvas does not need hardcoded template IDs.

| Alias | Template ID | Build ID | API-reported diskSizeMB |
| --- | --- | --- | ---: |
| `engelbart-runner` | `2wbsvjd5unxqk6f89f9x` | `d3a860e8-c5a1-4269-a1e0-c8abb687508e` | 14775 |
| `engelbart-canvas-cached` | `f98p5bqyt6juyvwwnc1e` | `47edff8b-259c-4805-a7ee-ae7bdabc80e5` | 15055 |
| `engelbart-runner-docker` | `4kiy08wup29wsv6yitvq` | `467ae1d5-e66b-4f44-8a67-9b6463d9a12d` | 15320 |

All three retain **8 vCPU / 8192 MiB RAM**. Disk was allocated using the project's
default instead of explicitly requesting the prior 25 GiB of minimum free space.
Fresh sandbox `df -BM /` measurements showed 10257, 10231, and 10255 MiB available
respectively. This is **free space**, not a claim that the entire disk is 10 GiB.
Large dependency trees, Docker images, or datasets still need sufficient disk;
these checks do not guarantee capacity for every repository.

The existing effective Canvas configuration was already correct and was not edited:

```dotenv
E2B_TEMPLATE=engelbart-canvas-cached
E2B_DOCKER_TEMPLATE=engelbart-runner-docker
```

These are template names, not additional API keys. New builds resolve them in
the new project. Existing sandbox IDs and running machines do not move between
accounts; this migration did not stop or transfer them. Restarting an app in an
old sandbox is not the same as creating a new build.

## Build-source repair

The previous default source `/private/tmp/engelbart-new-project/hc` no longer
existed. The base/Docker builder now safely reuses the preserved
`../engelbart-web/sandbox/.hc` snapshot when needed, verifying its existing
instrumentation patch rather than deleting or patching it twice. An explicit
`HC_SOURCE` can still select another compatible checkout.

The preserved runtime is `human-compact 0.20.4`; its `project_run.py` SHA-256
remained `c36bd6abbfb362d520f562857703113de4f7820ec59b574c586624ce0d6b4652`.
No agent prompts, runtime pipeline, cache profile, persistence, or UI changed.
The existing recipe installs current tool versions, so these are fresh builds,
not byte-for-byte copies of the old template images. Verified versions:

- Node 22.23.3, npm 10.9.9, Python 3.11.6.
- Claude Code 2.1.283, Railpack 0.40.0, pnpm 12.6.0, Bun 1.4.2, uv 0.12.19.
- Docker variant: Docker 29.8.1, Compose 5.5.1, Supabase CLI 2.118.0.

## Verification

- Base and Docker source dry-runs, syntax checks, and diff whitespace checks passed.
- All 9 cache tests passed, including optional disk-target validation.
- Fresh instances of all three aliases resolved to their expected new template
  IDs and resource allocations. Runner imports, instrumentation capability,
  headless Chromium, and expected runner files passed. No application repository
  was baked into the images.
- The cached variant retained `prefer-offline=true`, about 322 MiB of npm cache,
  7 MiB of pip cache, and the original pinned seed profile
  `c0f1d0ec8e7f363619160720a55334cd78e1336a2759e3d1c610902fd1b4140d`.
- The Docker variant started its daemon and successfully pulled/executed the
  `hello-world` container. A complete Compose/Supabase application was not tested.
- A fresh `mqo00/rope` run used the ordinary Canvas manager/worker and local
  Claude subscription, with API fallback disabled for this test process only.
  It used `f98p5bqyt6juyvwwnc1e`, completed dependency installation, started the
  app, and saved a `ready` preview in **72.281 seconds**. An independent check
  confirmed public **HTTP 200 HTML**. This is a smoke test, not a controlled
  performance comparison; secret-dependent MongoDB/OpenAI features were not tested.
- The smoke test used an isolated temporary library database. The running Canvas
  app, user database, account settings, and pre-existing previews were untouched.

Only these four test sandboxes were stopped. Subsequent API reads returned 404
for each, confirming they were no longer present:

| Test | Sandbox ID |
| --- | --- |
| Base runtime | `i7fbi2x69myb70m7c76t2` |
| Cached runtime | `ikuxktluppqbuxkq8zjf7` |
| Docker runtime | `imq719djslv09gak6usso` |
| Rope live preview | `ii1sa4xdoff5ngewx4j13` |

Local build logs, verification JSON, and the complete smoke report are saved in
`/private/tmp/engelbart-template-migration-uVaIGm/`. That diagnostic directory is
temporary; the essential results and IDs are retained in this document. The
test preview is intentionally no longer running. No credentials are recorded here.

For future builds and explicit disk targets, see [sandbox-cache.md](sandbox-cache.md).
