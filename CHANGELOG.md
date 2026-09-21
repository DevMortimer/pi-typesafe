# Changelog

## Unreleased

<!-- Empty. Next release starts here. -->

## 0.6.1

### Fixed

- Send OpenRouter judgments to `/api/alpha/decisions` instead of the TypeSafe SDK's default `/v1/systemone` path, while preserving caller-supplied transports (#2).
- Keep the lockfile's root package version aligned with the published package.
- Build declarations before checking public-API examples so `npm run check` works from a clean checkout.

### Added

- Contributor CI for supported Node versions on Linux and macOS, workflow lint, installed-package smoke tests, and a combined `CI passed` check.
- Verified package artifacts, tag-triggered draft GitHub releases, weekly dependency updates, and contributor/release guidance; npm publication remains manual.

## 0.6.0

### Added

- `backend` option on `TypeSafeOptions` to route judgments to different services (`"typesafe"` or `"openrouter"`).
- `DECISIONS_BACKENDS` registry mapping backend names to `{ host, keyEnv }` configs.
- Backend-specific env var resolution: `OPENROUTER_API_KEY` for openrouter, `TYPESAFE_API_KEY` for typesafe.
- Default model changes per backend: `jev-latest` for typesafe, `typesafe/jev-1.13` for openrouter.

## 0.5.0

- Initial tracked release.
