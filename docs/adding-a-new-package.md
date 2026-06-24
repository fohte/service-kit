# Adding a new package

This document covers Node packages. Node packages publish to public npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) via `.github/workflows/release-please.yml`. npm requires the package to exist before trusted publishing can be configured, so the first publish is a one-time manual step.

## 1. Add `publishConfig` to `package.json`

The package root for the current Node package lives under `node/`. If you add a second Node package in a different directory, also add a matching `publish-<name>` job to `.github/workflows/release-please.yml` — the existing `publish-node` job is hardcoded to `pnpm -C node`.

Each `package.json` needs:

```json
{
  "name": "@fohte/<package-name>",
  "version": "0.0.0",
  "private": false,
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

Register the package in `release-please-config.json` and `.release-please-manifest.json` (each entry maps a path to a component name; tags are emitted as `<component>-v<version>`).

## 2. Publish a placeholder to claim the name on npm

```sh
npx setup-npm-trusted-publish @fohte/<package-name>
```

This publishes a minimal placeholder package so npm recognizes the name. See [`azu/setup-npm-trusted-publish`](https://github.com/azu/setup-npm-trusted-publish) for details.

If `npm login` is not set up locally, the tool also accepts `NPM_TOKEN` — a short-lived Granular Access Token scoped to `@fohte`. Treat its expiry as a one-shot credential and revoke (or let it expire) immediately after step 4.

## 3. Configure the trusted publisher on npmjs.com

Open the package's access page:

```
https://www.npmjs.com/package/@fohte/<package-name>/access
```

In the **Trusted Publisher** section, click **Add trusted publisher** and enter:

| Field                | Value                |
| -------------------- | -------------------- |
| Publisher            | GitHub Actions       |
| Organization or user | `fohte`              |
| Repository           | `service-kit`        |
| Workflow filename    | `release-please.yml` |
| Environment name     | (leave empty)        |

Save. Use the web UI; the CLI equivalent (`npm trust github ...`) currently returns `400 Bad Request` ([npm/cli#9377](https://github.com/npm/cli/issues/9377)).

## 4. Disallow token-based publishing

On the same access page, switch publishing access to **Require two-factor authentication and disallow tokens**. Subsequent publishes can then only come from the configured trusted publisher.

## 5. Ship the first real version

release-please will not open a release PR until at least one existing release tag pins the baseline. Seed it once by:

1. Disabling the `pr-required` ruleset for `main` in the repo settings (Settings → Rules → Rulesets).
2. Bumping the component's entry in `.release-please-manifest.json` to the target version (for example `0.1.0`), committing on `main`, and pushing the matching annotated tag (`<component>-v<version>`).
3. Re-enabling the ruleset.

Once the tag is on `main`, `release-please.yml` picks it up, opens (or updates) a release PR, and merging that PR triggers `publish-node`, which uses OIDC to publish with a provenance attestation.

If `publish-node` fails after the release tag is created (transient npm error, missing trusted publisher configuration, etc.), re-run the failed job from the Actions UI. `pnpm publish` skips versions already on the registry, so partial-success states are safe to retry.
