# Contributing to rrweb

We want to make contributing to this project as easy and transparent as
possible.

## Our Development Process

The majority of development on rrweb will occur through GitHub. Accordingly,
the process for contributing will follow standard GitHub protocol.

## Pull Requests

We actively welcome your pull requests (PRs)!

1. Fork the repo and create your branch from `master`.
2. If you've added code that should be tested, add tests
3. Ensure the test suite passes or ask for help as to why tests are failing
4. Use [conventional commit](https://www.conventionalcommits.org/) messages in your PR title (e.g. `feat:`, `fix:`, `chore:`) so that release-please can generate changelogs automatically.
5. If you've changed APIs, update the documentation.
6. Make sure your code lints and typechecks.

## Issues

We use GitHub issues to track public bugs. Please ensure your description is
clear and has sufficient instructions to be able to reproduce the issue.

## Run locally

- Install dependencies: `npm install`
- Build all packages: (in `/`) `npm run build:all` or `npm run dev`
- Run recorder on a website: (in `/packages/rrweb`) `npm run repl`
- Run a cobrowsing/mirroring session locally: (in `/packages/rrweb`) `npm run live-stream`
- Build individual packages: `npm run build` or `npm run dev`
- Test: `npm test` or `npm run test:watch`
- WebKit (Safari engine) tests: `npm run test:webkit` (in `/packages/rrweb` or `/packages/rrweb-snapshot`)

### WebKit tests

The monkey-patched MutationObserver tests are excluded from the regular `npm test` run because they require a Playwright WebKit browser binary. They are run separately via `npm run test:webkit`.

**Install the browser once, then run directly:**

```sh
npx playwright install webkit
cd packages/rrweb && npm run test:webkit
cd packages/rrweb-snapshot && npm run test:webkit
```

You can also run these tests against Chromium (the default when `BROWSER` is not set):

```sh
npx playwright install chromium
cd packages/rrweb && npx vitest run --config vitest.config.webkit.ts
```

Set `BROWSER=webkit` to run against WebKit specifically.

- Lint: `npm run lint`
- Rewrite files with prettier: `npm run format` or `npm run format:head`

## Coding style

See [documentation](docs/development/coding-style.md)

## License

rrweb is [MIT licensed](https://github.com/rrweb-io/rrweb/blob/master/LICENSE).

By contributing to rrweb, you agree that your contributions will be licensed
under its MIT license.
