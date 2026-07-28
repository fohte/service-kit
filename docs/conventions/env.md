# Env conventions

Audience: implementers of the kit, and operators who integrate it into a service.

Conventions for the environment-variable parsing layer shared by `@fohte/service-kit` (Node) and `fohte-service-kit` (Rust crate, not yet implemented). Treat this document as the source of truth: when the Node or Rust implementation changes, update both implementations and this document in the same PR.

## Design policy

### Fail fast, but report every issue at once

Validate every field before failing, instead of stopping at the first invalid or missing variable. A service with three misconfigured env vars should see all three on its first failed startup, not one per restart.

### Inject the env source, don't read `process.env` directly

Every parser takes the env source as an explicit argument, matching `@fohte/service-kit/observability`'s `initObservability(env, options)` convention. This keeps parsing testable without mutating global state and lets a service load config from a source other than `process.env` (e.g. a `.env.test` snapshot) without changing call sites.

### Treat an empty string the same as unset

An env var set to `""` is treated as absent by every parser (required parsers fail, optional parsers fall through to their default). Shells and process managers routinely export empty-string placeholders for unset variables, and that should not observably differ from the variable being absent.

## Node

### API

`@fohte/service-kit/env` exports typed field parsers plus `parseEnv`, which aggregates every field's `Result` into either a single parsed object or a single typed error listing every issue.

```ts
import {
  optionalEnum,
  optionalInt,
  parseEnv,
  requireString,
} from '@fohte/service-kit/env'

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

const result = parseEnv({
  port: optionalInt(process.env, 'PORT', 8080, { min: 1, max: 65_535 }),
  logLevel: optionalEnum(process.env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
  slackBotToken: requireString(process.env, 'SLACK_BOT_TOKEN'),
})

if (result.isErr()) {
  // result.error is an EnvValidationError; result.error.issues lists every
  // failing variable, not just the first one encountered.
}
```

### Field parsers

Each parser reads a single key from an `EnvSource` (`Readonly<Record<string, string | undefined>>`, e.g. `process.env`) and returns a [neverthrow](https://github.com/supermacro/neverthrow) `Result<T, string>`, where the `Err` value is a human-readable issue message.

| Parser                                              | Behavior when unset or empty        | Behavior when set                                            |
| --------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `requireString(env, key)`                           | `Err`                               | `Ok(value)`                                                  |
| `optionalString(env, key, defaultValue?)`           | `Ok(defaultValue)` (or `undefined`) | `Ok(value)`                                                  |
| `requireInt(env, key, constraints?)`                | `Err`                               | `Ok(parsed)` if integer and within `constraints`, else `Err` |
| `optionalInt(env, key, defaultValue, constraints?)` | `Ok(defaultValue)`                  | `Ok(parsed)` if integer and within `constraints`, else `Err` |
| `requireEnum(env, key, allowed)`                    | `Err`                               | `Ok(value)` if in `allowed`, else `Err`                      |
| `optionalEnum(env, key, allowed, defaultValue)`     | `Ok(defaultValue)`                  | `Ok(value)` if in `allowed`, else `Err`                      |

`constraints` is `{ min?: number; max?: number }`, checked against the parsed integer.

### `parseEnv` and `EnvValidationError`

`parseEnv(fields)` takes a record mapping output keys to the `Result`s returned by the field parsers above, and returns `Result<T, EnvValidationError>`:

- Every field is evaluated; there is no short-circuiting on the first `Err`.
- On success, `Ok` carries a plain object with the same keys as `fields`, each holding its parser's unwrapped value.
- On failure, `Err` carries an `EnvValidationError` whose `issues: readonly string[]` lists every failing field's message, in the order the fields were given.

## Rust

The Rust implementation will come later. Concrete API names will be appended to this document at implementation time. The design policy above (aggregate-then-fail, injected env source, empty-string-as-unset) applies equally once the crate exists.
