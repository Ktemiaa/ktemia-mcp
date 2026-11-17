# Publishing

Both packages are published by hand, from a clean checkout, after the same
checks CI runs. Read this end to end before the first release: a version number
cannot be reused on either registry, so a mistake is corrected by publishing
another version, never by replacing one.

## One-time setup

### npm (`@ktemia/mcp`)

`@ktemia` is a **scope**, and a scope has to exist before anything can be
published into it. It does not exist yet.

1. Sign in at [npmjs.com](https://www.npmjs.com/) as the account that should
   own the package. Use an organisation account, not a personal one: a personal
   account cannot be handed over later without transferring the whole login.
2. Create the organisation named `ktemia`
   ([npmjs.com/org/create](https://www.npmjs.com/org/create)). The free plan
   covers public packages. This is what makes the `@ktemia/*` scope yours.
3. Turn on 2FA for the account. npm requires it for publishing, and without it
   the publish step fails after the package has already been built.
4. Authorise this machine:

   ```bash
   npm login
   npm whoami          # should print the account name
   npm org ls ktemia   # should list you as owner
   ```

A scoped package is **private by default**, which is why the publish command
below passes `--access public` explicitly. Forgetting it on a free plan fails
with a payment-required error.

### PyPI (`ktemia-mcp`)

1. Create an account at [pypi.org](https://pypi.org/account/register/) and
   verify the email address.
2. Enable 2FA. PyPI requires it to create API tokens.
3. Create an API token at
   [pypi.org/manage/account/token](https://pypi.org/manage/account/token/).
   Scope it to "Entire account" for the first upload - a project-scoped token
   cannot be created for a project that does not exist yet. After the first
   release, create a token scoped to `ktemia-mcp` and delete the broad one.
4. Keep the token out of your shell history. Put it in a gitignored file and
   read it at publish time:

   ```bash
   echo 'UV_PUBLISH_TOKEN=pypi-...' >> python/.env.local
   ```

PyPI names are first-come and cannot be renamed. `ktemia-mcp` was unclaimed as
of the first release; if it has since been taken, publish under a different
name and update the install commands in both READMEs rather than trying to
reclaim it.

Consider publishing the first release to [TestPyPI](https://test.pypi.org/)
first (`--publish-url https://test.pypi.org/legacy/`), which is a separate
registry with separate accounts. It is the only way to see exactly how the
project page renders without burning a real version number.

## Pre-flight

Run everything here from a **clean checkout**, so nothing local leaks into a
published artifact:

```bash
git status --porcelain     # must be empty
git log --oneline -1       # the commit you intend to ship
```

```bash
# TypeScript
cd typescript
npm ci
npm run typecheck
npm test
npm run build

# Python
cd ../python
uv sync
uv run pytest
uv build
uvx twine check dist/*
```

Then confirm the artifacts are what you think they are:

```bash
cd ../typescript && npm pack --dry-run
cd ../python && tar tzf dist/*.tar.gz
```

Check each one:

- `README.md` and `LICENSE` are present. npm does not follow symlinks, so a
  symlinked README silently publishes without one.
- `dist/tools.json` (npm) and `src/ktemia_mcp/tools.json` (sdist) are present.
  Without the shared spec the server cannot start.
- No `.env`, `.env.local`, or anything matching `sk_live_`.

`python/tests/test_parity.py` asserts the version matches across all five
places it is written down, including the `X-Ktemia-Client` header, so run it
before bumping anything.

## Release

Bump the version in **five** files, which the parity test will verify:

- `typescript/package.json`
- `typescript/src/client.ts` (`VERSION`)
- `python/pyproject.toml`
- `python/src/ktemia_mcp/__init__.py` (`__version__`)
- `python/src/ktemia_mcp/client.py` (`VERSION`)

```bash
cd python && uv run pytest tests/test_parity.py   # catches a missed file
git commit -am "Release 0.1.0"
git tag v0.1.0
```

Publish npm first, because it is the one that can fail on account setup:

```bash
cd typescript
npm publish --access public --dry-run   # last look
npm publish --access public
```

Then PyPI. `UV_PUBLISH_TOKEN` is read from the environment, so the token never
has to appear in the command:

```bash
cd ../python
rm -rf dist && uv build
set -a; source .env.local; set +a
uv publish --dry-run     # last look
uv publish
```

```bash
git push && git push --tags
```

## Verify like a user

Do not trust the registry pages. Run the commands from the READMEs, in a
throwaway directory, with no local checkout on the path:

```bash
cd "$(mktemp -d)"
KTEMIA_API_KEY=your-key npx -y @ktemia/mcp     # Ctrl-C once it idles
KTEMIA_API_KEY=your-key uvx ktemia-mcp
```

Both should sit silently waiting for JSON-RPC. Then check a real host sees the
tools:

```bash
claude mcp add ktemia-check -e KTEMIA_API_KEY=your-key -- uvx ktemia-mcp
claude mcp list        # expect: ✔ Connected
claude mcp remove ktemia-check
```

A registry can take a minute to serve a new version, and `npx`/`uvx` cache
aggressively. If you get the old version, `npx --yes @ktemia/mcp@0.1.0` and
`uvx ktemia-mcp@0.1.0` pin it explicitly.

## If something is wrong

Neither registry lets you replace a version. Publish a patch instead.

- **npm**: `npm unpublish @ktemia/mcp@0.1.0` works only within 72 hours and
  only if nothing depends on it. Prefer
  `npm deprecate @ktemia/mcp@0.1.0 "use 0.1.1"`, which leaves installs working.
- **PyPI**: there is no unpublish. You can only "yank" a release
  (`pypi.org/manage/project/ktemia-mcp/releases/`), which hides it from new
  installs while keeping it resolvable for anything that pinned it.

Because a bad release is this hard to undo, the pre-flight above is not
optional.
