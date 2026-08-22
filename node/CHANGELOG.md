# Changelog

## [0.1.12](https://github.com/fohte/service-kit/compare/node-v0.1.11...node-v0.1.12) (2026-08-22)


### Features

* **node/octo-sts:** add octo-sts client generated from proto ([#84](https://github.com/fohte/service-kit/issues/84)) ([2e6b8e8](https://github.com/fohte/service-kit/commit/2e6b8e8479938acd93df642c98e375aa28c4e26f))

## [0.1.11](https://github.com/fohte/service-kit/compare/node-v0.1.10...node-v0.1.11) (2026-08-13)


### Bug Fixes

* **node/observability:** stop duplicate traceparent injection ([#81](https://github.com/fohte/service-kit/issues/81)) ([a8908e2](https://github.com/fohte/service-kit/commit/a8908e241f259d58957488a6a20ca8aca76a0dcc))

## [0.1.10](https://github.com/fohte/service-kit/compare/node-v0.1.9...node-v0.1.10) (2026-08-13)


### Bug Fixes

* **node/observability:** always use W3C trace propagation ([#78](https://github.com/fohte/service-kit/issues/78)) ([dc18fbc](https://github.com/fohte/service-kit/commit/dc18fbc44b5694392eb498cf9a246e27c452e7bc))

## [0.1.9](https://github.com/fohte/service-kit/compare/node-v0.1.8...node-v0.1.9) (2026-08-09)


### Bug Fixes

* **node/observability:** disable the openai auto-instrumentation ([#76](https://github.com/fohte/service-kit/issues/76)) ([8bfc732](https://github.com/fohte/service-kit/commit/8bfc732774027a2ff9c37bddd32ecb3685ca6252))

## [0.1.8](https://github.com/fohte/service-kit/compare/node-v0.1.7...node-v0.1.8) (2026-08-08)


### Bug Fixes

* **node/shutdown:** fix import unresolved in the published package ([#74](https://github.com/fohte/service-kit/issues/74)) ([9cfde4c](https://github.com/fohte/service-kit/commit/9cfde4c27c75d98f5999f06a24b83d24909a1f9c))

## [0.1.7](https://github.com/fohte/service-kit/compare/node-v0.1.6...node-v0.1.7) (2026-08-02)


### Features

* **node/langchain-genai:** add execute_tool span ([#71](https://github.com/fohte/service-kit/issues/71)) ([aa6e905](https://github.com/fohte/service-kit/commit/aa6e9055870cf252b808944f3bc3223a30d3bc4c))
* **node/langchain-genai:** add GenAI tracing middleware ([#69](https://github.com/fohte/service-kit/issues/69)) ([ca5dba9](https://github.com/fohte/service-kit/commit/ca5dba96fc024237d30292cab260791d4ee64e55))

## [0.1.6](https://github.com/fohte/service-kit/compare/node-v0.1.5...node-v0.1.6) (2026-07-29)


### Features

* **node/env:** add env parser with aggregated validation errors ([#56](https://github.com/fohte/service-kit/issues/56)) ([2c352c4](https://github.com/fohte/service-kit/commit/2c352c4a4eb78a336950b0671716c55b244b4a61))
* **node/logger:** add logger with redaction ([#68](https://github.com/fohte/service-kit/issues/68)) ([eee6b83](https://github.com/fohte/service-kit/commit/eee6b83a443317a054377814259fd1e46d3c0e09))
* **node/retry:** add backoff retry helper ([#59](https://github.com/fohte/service-kit/issues/59)) ([ea1c57d](https://github.com/fohte/service-kit/commit/ea1c57db7eeeebdb27c470c152486ef6049166b0))
* **node/shutdown:** add a graceful shutdown handler ([#66](https://github.com/fohte/service-kit/issues/66)) ([7a02aca](https://github.com/fohte/service-kit/commit/7a02aca036918b25d8b5559caac389ee493bb205))
* **node:** add otel-register entry and bootstrap helper ([#62](https://github.com/fohte/service-kit/issues/62)) ([a23b80c](https://github.com/fohte/service-kit/commit/a23b80cbf07b7b83179fbf7daa71a4f47f81455f))


### Bug Fixes

* **node:** move OTel/Sentry packages to dependencies ([#67](https://github.com/fohte/service-kit/issues/67)) ([9517786](https://github.com/fohte/service-kit/commit/9517786eeab86360c343b42334e8078588082f32))

## [0.1.5](https://github.com/fohte/service-kit/compare/node-v0.1.4...node-v0.1.5) (2026-07-27)


### Bug Fixes

* **node:** widen pre-1.0 OpenTelemetry peerDependencies ranges ([#43](https://github.com/fohte/service-kit/issues/43)) ([2ba779d](https://github.com/fohte/service-kit/commit/2ba779d21c70fd6be9a3c147e0674c6eca49aa73))

## [0.1.4](https://github.com/fohte/service-kit/compare/node-v0.1.3...node-v0.1.4) (2026-07-08)


### Features

* **node/observability:** support exporting metrics over OTLP ([#37](https://github.com/fohte/service-kit/issues/37)) ([b4b4de1](https://github.com/fohte/service-kit/commit/b4b4de1424fc5197b66d661b95f138a3454a7e2c))

## [0.1.3](https://github.com/fohte/service-kit/compare/node-v0.1.2...node-v0.1.3) (2026-07-02)


### Bug Fixes

* **node/observability:** propagate W3C traceparent when Sentry is initialized ([#32](https://github.com/fohte/service-kit/issues/32)) ([fe33ad1](https://github.com/fohte/service-kit/commit/fe33ad1a4a96d00a35df7e71fd3ebd754c278127))

## [0.1.2](https://github.com/fohte/service-kit/compare/node-v0.1.1...node-v0.1.2) (2026-07-01)


### Bug Fixes

* **node/observability:** stop trace exporter from silently dropping spans against base-URL endpoints ([#30](https://github.com/fohte/service-kit/issues/30)) ([577f5dc](https://github.com/fohte/service-kit/commit/577f5dcaefa902fff9dd9fbe75a018643ae26b79))

## [0.1.1](https://github.com/fohte/service-kit/compare/node-v0.1.0...node-v0.1.1) (2026-06-26)


### Bug Fixes

* **node:** resolve path aliases in build output with tsc-alias ([#26](https://github.com/fohte/service-kit/issues/26)) ([de29b65](https://github.com/fohte/service-kit/commit/de29b65b3e58f312fed359e7d91000bc74273678))

## [0.1.0](https://github.com/fohte/service-kit/compare/node-v0.1.0...node-v0.1.0) (2026-06-25)


* **node:** trigger release ([c560e60](https://github.com/fohte/service-kit/commit/c560e6083562c4fddf86913037912ad46427d489))


### Features

* **node:** add initObservability entry point ([#12](https://github.com/fohte/service-kit/issues/12)) ([998f2f4](https://github.com/fohte/service-kit/commit/998f2f4a6cb9c8d7e3d845004e576036a756009d))
* **node:** add observability builders ([#11](https://github.com/fohte/service-kit/issues/11)) ([e3668f2](https://github.com/fohte/service-kit/commit/e3668f2313c24b538ae7dd0352097a0e9328b2bc))
* **node:** scaffold the @fohte/service-kit package ([#7](https://github.com/fohte/service-kit/issues/7)) ([35e2a3f](https://github.com/fohte/service-kit/commit/35e2a3f2348d19e82f73b6f38eb8dc181177e73d))
