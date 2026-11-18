# Publishing

Both packages are released together by pushing a version tag. GitHub Actions
(`.github/workflows/publish.yml`) then runs the tests and publishes
`@ktemia/mcp` to npm and `ktemia-mcp` to PyPI. Nobody publishes from a laptop,
and there is no registry token in this repo, in GitHub secrets, or on anyone's
machine.

A version number cannot be reused on either registry. A mistake is corrected by
publishing another version, never by replacing one.

## How authentication works

Both registries use **trusted publishing** over OpenID Connect. Each registry
is told once which repository, workflow file, and (for PyPI) environment may
publish. At release time GitHub issues the workflow a short-lived identity
token, and the registry checks it against that record. `id-token: write` in
the workflow is what allows this, so removing it breaks every release.

Both registries also attach a provenance attestation that ties each published
file to the commit and workflow run that built it:

- npm: `https://registry.npmjs.org/-/npm/v1/attestations/@ktemia%2fmcp@<version>`
- PyPI: shown on the project page under each file's details

The records live on the registries:

| Registry | Where the trusted publisher is configured | Values |
| -------- | ----------------------------------------- | ------ |
| npm | `@ktemia/mcp` → Settings → Trusted publishing | repo `Ktemiaa/ktemia-mcp`, workflow `publish.yml` |
| PyPI | organization `ktemia` → Publishing (or the project's Publishing page) | repo `Ktemiaa/ktemia-mcp`, workflow `publish.yml`, environment `pypi` |

Renaming `publish.yml`, renaming the `pypi` environment, or moving the repo
breaks publishing until the matching record is updated. Every field is
compared exactly, so a typo such as `pypl` for `pypi` is rejected as an
invalid publisher.

## Release

1. **Bump the version in five places.** The parity test fails if any of them
   disagree:

   - `typescript/package.json`, then `npm install --package-lock-only` in
     `typescript/` so `package-lock.json` follows
   - `typescript/src/client.ts` (`VERSION`)
   - `python/pyproject.toml`
   - `python/src/ktemia_mcp/__init__.py` (`__version__`)
   - `python/src/ktemia_mcp/client.py` (`VERSION`)

   Both packages always carry the same version, even when only one changed.

2. **Run the checks locally:**

   ```bash
   cd typescript && npm ci && npm run typecheck && npm test && npm run build
   cd ../python && uv run pytest && uvx ruff check src tests scripts
   rm -rf dist && uv build && uvx twine check dist/*
   uv run --isolated --no-project --with dist/*.whl python scripts/smoke_wheel.py
   ```

   To also check the tool schemas against the live API spec:
   `KTEMIA_CONTRACT_TEST=1 uv run pytest tests/test_contract.py`.

3. **Commit and push to `main`, then wait for CI to pass.**

4. **Tag the commit CI passed on:**

   ```bash
   git tag -a v0.1.4 -m "0.1.4: <one line on what changed>"
   test "$(git rev-parse v0.1.4^{commit})" = "$(git rev-parse origin/main)"
   git push origin v0.1.4
   ```

   Push the commit before the tag. The workflow runs from the tagged commit, so
   a tag pushed ahead of a workflow change publishes with the old workflow. Do
   not move a tag once it is pushed: cut the next version instead.

5. **Watch the run:** `gh run watch` on the `Publish` run. Each job checks
   that the tag matches its package version before uploading, and the PyPI job
   checks that the exact wheel it is about to upload serves all seven tools.

npm and PyPI both take a few minutes to serve a new version after the run
succeeds. npm in particular says "Your package is being processed" and keeps
showing the previous `latest` for a while. That is normal.

## Verify like a user

Do not trust the registry pages. Run the published packages the way a client
would, in a throwaway directory:

```bash
cd "$(mktemp -d)"
KTEMIA_API_KEY=your-key npx -y @ktemia/mcp@0.1.4   # should idle; Ctrl-C
KTEMIA_API_KEY=your-key uvx ktemia-mcp@0.1.4
```

Then check that a real host sees the tools:

```bash
claude mcp add ktemia-check -e KTEMIA_API_KEY=your-key -- uvx ktemia-mcp
claude mcp list        # expect: ✔ Connected
claude mcp remove ktemia-check
```

`npx` and `uvx` cache aggressively, so pin the version as above when checking
a release that just went out.

## If something is wrong

Neither registry lets you replace a version. Publish a patch instead.

- **npm**: `npm unpublish` works only within 72 hours and only if nothing
  depends on the version. Prefer
  `npm deprecate @ktemia/mcp@<bad> "use <good>"`, which warns on install and
  leaves pinned installs working.
- **PyPI**: there is no unpublish. You can only yank a release
  (`pypi.org/manage/project/ktemia-mcp/releases/`), which hides it from new
  installs while keeping it resolvable for anything that pinned it.

If a publish job fails after the other one succeeded, fix the cause and
re-run only the failed job from the Actions page. Re-running uses the same
tagged commit, so both registries end up with the same code.
