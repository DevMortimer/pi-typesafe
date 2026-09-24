# Changelog

## Unreleased

- A bare Jev model id is mapped to the backend's own form before it is sent — on OpenRouter `jev-latest` goes as `~typesafe/jev-latest` and `jev-1.13` as `typesafe/jev-1.13`, for the client default and a per-request `model` alike — so OpenRouter no longer answers 400, and `/typesafe status` reports the model the configured backend actually sends.

## 0.7.3

### Changed

- Dependency updates: `typebox` 1.3.31 to 1.3.34 (runtime); `typescript` 6.0.3 to 7.0.2, `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 0.85.1 to 0.86.1, `@types/node` 22.20.3 to 22.20.4, and `tsx` 4.23.13 to 4.23.15 (development). No change to the public API.

## 0.7.2

### Fixed

- HTTP advice is backend-aware: `safeError(error, backend?)` names the backend's key variable on a 401 (`Check OPENROUTER_API_KEY.` on OpenRouter, `Check TYPESAFE_API_KEY.` by default), a 402 now says `Insufficient credits. Add credits at https://openrouter.ai/credits.` on OpenRouter and `Check your account balance.` elsewhere without marking the key unusable, and a 429 appends `Retry after <n> seconds.` when the response carries a numeric `Retry-After` header. One-argument `safeError` calls are unchanged.

## 0.7.1

### Fixed

- `listModels()` asks each backend for its own model list. It requested the SDK's `/v1/models` on every backend, so on OpenRouter it fetched an HTML page and always failed; it now uses `/api/v1/models` and reads the list from OpenRouter's `data` field (#11).
- `listModels()` on OpenRouter returns model ids (`vendor/model`), the values `model:` accepts, instead of display names.
- A public model list no longer proves a key. OpenRouter serves its list without checking the key, so a successful `listModels()` there leaves `authState({ backend: "openrouter" })` unverified rather than recording a garbage key as verified.

### Added

- `BackendConfig` gains optional `modelsPath`, `modelsField`, `modelsIdField`, and `modelsVerifyKey`, documented in the API reference.

## 0.7.0

### Fixed

- Key reporting and login can name the judgment backend: `keySituation(backend)`, `resolveApiKey(backend)`, `authState({ backend })`, and `ensureApiKey(ctx, { backend })` read the backend's own environment variable, `describeAuth` labels the key by backend and names the variable to set, and `AuthState` carries `backend`. Before, every surface reported the TypeSafe key, so an OpenRouter user saw "TypeSafe key: missing" while judgments ran, and `ensureApiKey` opened the TypeSafe login and verified the pasted key against api.typesafe.ai (#9).
- `createTypeSafe({ backend: "openrouter" })` no longer falls back to `TYPESAFE_API_KEY` or the login store when `OPENROUTER_API_KEY` is unset; a TypeSafe key was being sent to OpenRouter.

### Added

- `DEFAULT_BACKEND` export and a `label` on every `DECISIONS_BACKENDS` entry.

### Docs

- Document the `backend` option, `DECISIONS_BACKENDS`, and which key each backend reads in the README and the API reference; the OpenRouter backend shipped in 0.6.0 without either.

## 0.6.2

### Fixed

- Describe every field the agent authors in the `typesafe_evaluate` schema (`state`, `questions`, `type`, `instructions`, `criteria`, `model`) and show one request payload in the prompt guidelines, so the first call no longer has to fail to learn the shape (#6, #7).

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
