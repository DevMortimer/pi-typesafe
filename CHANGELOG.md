# Changelog

## Unreleased

<!-- Empty. Next release starts here. -->

## 0.6.0

### Added

- `backend` option on `TypeSafeOptions` to route judgments to different services (`"typesafe"` or `"openrouter"`).
- `DECISIONS_BACKENDS` registry mapping backend names to `{ host, keyEnv }` configs.
- Backend-specific env var resolution: `OPENROUTER_API_KEY` for openrouter, `TYPESAFE_API_KEY` for typesafe.
- Default model changes per backend: `jev-latest` for typesafe, `typesafe/jev-1.13` for openrouter.

## 0.5.0

- Initial tracked release.
