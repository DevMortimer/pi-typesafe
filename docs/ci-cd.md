# CI and continuous delivery

The `CI` workflow runs on every pull request to `main`, pushes to `main`, merge
queue checks, `v*` tags, and manual runs from the Actions page. There are no path
filters: documentation-only PRs also report the required check. Like pi-warden,
this project prepares draft releases but does not automatically publish to npm.

## Contributor checks

- **Workflow lint** runs actionlint 1.7.12 and ShellCheck on the workflow commands.
- **Check (ubuntu-latest, Node 22.19.0)** tests the minimum supported Node version.
- Linux also runs Node **24** and **26**; macOS runs Node **24**. Each job installs
  the lockfile with `npm ci`, then runs `npm run check`: build, typecheck, and
  offline tests. Build runs first because the public-API example resolves this
  package's exports through `dist/`; this also checks the generated declarations
  from a clean checkout. Native Windows is not in this matrix; the existing credential and
  usage tests assert POSIX file permissions.
- **Package** builds an actual npm tarball and installs it outside the checkout
  with install scripts disabled. It checks root and calibration imports without
  optional Pi peers, verifies all declared JavaScript and type declaration
  files, then checks the extension, UI helpers, and Pi loader with the peer
  versions from `package-lock.json`. It also checks package/lockfile version
  agreement.
- **CI passed** runs even when another job fails or is skipped, and fails unless
  all three prerequisites succeeded. This is the stable check to require in the
  `main` branch rules; do not require only **Package**, which can be skipped.

No TypeSafe or OpenRouter credentials are needed. Tests do not call either
service. CI does not run `test:live` or any other billable checks. Package
installation needs access to npm; offline tests themselves use fake transports.

Actions use full commit SHAs, checkout does not retain credentials, and check
jobs have read-only repository permissions. Jobs have time limits; newer PR
runs cancel superseded runs. Fork PRs use `pull_request`, never
`pull_request_target`, and do not receive repository secrets. Dependabot opens
weekly action and dependency updates; they run the same checks and are not
merged automatically.

Run the normal gate locally with:

```bash
npm ci
npm run check
npm pack --dry-run # builds and lists the publishable files
```

For the complete installed-package smoke test, use the workflow's **Package**
steps or dispatch `CI` from the Actions page after this workflow is on `main`.
Successful runs retain an `npm-package` artifact for 14 days. It contains the
verified tarball and `SHA256SUMS`; tag runs also include release notes.

## Release delivery

A tag run must pass the same checks. Before packaging, it must also prove:

1. The tagged commit is an ancestor of `origin/main`.
2. The package has a stable `X.Y.Z` version and the tag is exactly `vX.Y.Z`.
3. Both root version fields in `package-lock.json` match `package.json`.
4. `CHANGELOG.md` has a nonempty `## X.Y.Z` section, not just an HTML comment.

Only a **push of a version tag** can start **Draft release**. The job downloads
that run's checked artifact, verifies the tarball checksum, and creates a draft
GitHub release with the notes, tarball, and checksum. PRs, branch pushes, merge
queues, and manual runs cannot create a release. A manual run on a tag can check
it, but does not publish or create a draft.

Only the draft job has `contents: write`. It uses the built-in GitHub token,
does not check out or execute repository code, and uses `--verify-tag` so it
cannot create a tag. No npm token or other new repository secret is required.
An existing release for the tag makes creation fail rather than overwrite it;
inspect any existing draft and assets before retrying a failed delivery.

## Maintainer steps

1. In GitHub's `main` branch rules, require **CI passed** and PR review. This PR
   does not change repository settings; the checks are not a merge restriction
   until a maintainer enables the rule.
2. For a release, update the version with `npm version patch --no-git-tag-version`
   (or the chosen minor version), so `package.json` and `package-lock.json` stay
   aligned. Move the release notes below a matching `## X.Y.Z` heading and leave
   `## Unreleased` at the top. Commit these release files together. Normal
   contributor PRs leave the version bump to the maintainer.
3. Merge only after review and a passing **CI passed**. Pull the merged `main`,
   ensure the checkout is clean, and run `npm ci` and `npm run check`.
4. Create and push the matching tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Wait for its `CI` run and review the draft. Download its tarball and
   `SHA256SUMS` to an empty directory, then run `sha256sum --check SHA256SUMS`
   (`shasum -a 256 --check SHA256SUMS` on macOS).
6. Publish that verified tarball yourself with `npm publish ./pi-typesafe-X.Y.Z.tgz`,
   using maintainer credentials and the normal npm authentication checks. Then
   publish the GitHub draft manually. Do not publish a PR artifact or run
   `npm publish` from an unreviewed branch.

Merging this workflow creates no tag, npm publication, or published GitHub
release. The existing manual `npm publish` process can still be used from a
reviewed, checked release commit; publishing the tagged tarball is preferred
because it is the exact package tested by the release workflow.
