# Rules for any AI or person working in this repository

MitoForge is one person's real training and food history. A bad change here can hide or lose his data on his phone. Read this file first.

## Who decides

- Brent is the only person who merges to `main`. Open a pull request. Never push to `main`.
- `main` is published to his phone by GitHub Pages the moment it changes.
- One AI tool works on the repo at a time. Before starting, look at the open pull requests. If another one touches the same area, say so and wait.
- Keep each pull request small and about one thing. Say in plain words what changes for him.

## Protect his data

- All user data lives in the browser's `localStorage` under keys that start with `mf_` (for example `mf_<profileId>_log`). Do not rename or remove a key, and do not change the shape of an existing entry. Add new fields instead.
- Never overwrite or rewrite his saved data without first copying the old value to a backup key.
- Never delete his entries. Deletions go through the app's delete-and-undo path so they sync correctly.
- No real data, tokens, API keys or Drive links in the repository, in tests, or in pull request text. Test data is made up.
- The Drive sync token and the coach API key must stay out of backups and out of Drive.

## Every pull request

1. Raise the build label (`MF_BUILD_LABEL` in `index.html`). The app compares the running build with the live page to offer updates.
2. If you change which files the offline shell caches, raise `CACHE` in `sw.js`.
3. Run the checks and make sure they pass:
   ```
   node tests/syntax-check.mjs
   node drive-sync/sync.test.js
   node drive-sync/merge-sync.test.js
   node drive-sync/inbox.test.js
   node drive-sync/delete-sync.test.js
   ```
   The same checks run automatically on every pull request. Do not ask Brent to merge while one is red.
4. Phone-size browser checks are in `tests/`. They need Playwright and a local server. Run the one for the area you changed, and describe what you saw.
5. Do not claim something works unless you ran it. Say what you could not test.

## Working in `index.html`

The file is very large (about 1.5 MB). Do not read it whole. Search for the function or key you need and read only that part. If an edit would need more than a few hundred lines, stop and ask Brent first.

## If something goes wrong

Say so at once and plainly. Do not hide a failing check. The tag `known-good-2026-11-22` marks the last version he confirmed working, and one revert returns the app to it.
