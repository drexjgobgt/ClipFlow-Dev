# Release process

This document records how ClipFlow releases work today, why automatic updates
are currently disabled, and what must be done to turn them back on.

Last verified: 2026-10-27, with the `v1.6.0` release.

---

## 1. Current state: auto-update is off

`src-tauri/tauri.conf.json` has `bundle.createUpdaterArtifacts: false`. A release
therefore ships plain installers and **no** `latest.json` updater manifest and no
`.sig` files.

The in-app **Check for Updates** button detects the missing manifest, shows
*"Automatic updates unavailable"*, and opens the Releases page. It does not
surface the raw plugin error.

Verified end to end for `v1.6.0`:

```
https://github.com/drexjgobgt/ClipFlow-Dev/releases/latest/download/latest.json
-> HTTP 404
```

This is intentional and must stay until a valid key pair exists (see §3).

## 2. Why: the signing key does not match

`tauri-action` signs the updater artifacts with
`TAURI_SIGNING_PRIVATE_KEY`. Tauri expects that secret to hold a **base64
minisign** private key. The repository secret does not.

Evidence, gathered from the failed workflow runs:

| Run | Date | Error |
| :-- | :-- | :-- |
| `v1.4.2` | 2026-10-15 | `failed to decode secret key: incorrect updater private key password: Missing comment in secret key` |
| `v1.5.0` | 2026-10-23 | `failed to decode secret key: incorrect updater private key password: Missing comment in secret key` |
| `v1.6.0` | 2026-10-27 | `failed to decode base64 secret key: failed to decode base64 key: Invalid symbol 45, offset 3.` |

Symbol 45 is `-`. The third error means the secret begins with `---`, i.e. it
holds a PEM-style key. The secret was replaced on **2026-10-24T03:12:25Z** (in the
same change that rotated the public key), so the earlier and later errors differ.

The public key embedded in `tauri.conf.json` decodes to:

```
untrusted comment: minisign public key: CE965E075DC5F3A8
```

No private key in CI corresponds to it. **Every** automated release run
(`v1.4.2`, `v1.5.0`, `v1.6.0`) failed at the signing step for this reason. The
entries that do appear on the Releases page were published without a working
signature chain.

Consequence: even with a valid key configured now, users running a build that
embeds `CE965E075DC5F3A8` cannot verify a manifest signed by a *different* key.
Rotating the key therefore forces one manual reinstall for existing users. Plan
for that explicitly in the release notes of the first release after the fix.

## 3. Restoring automatic updates

Do this on a machine that will keep the private key safe. Never commit it —
`.tauri/` is already git-ignored.

1. Generate a key pair:

   ```bash
   npx tauri signer generate -w ~/.tauri/clipflow.key
   ```

   The command prints the **public** key and writes the private key file plus a
   `.key.pub` file.

2. Store the private key in GitHub. The value must be the **entire contents of
   the file**, which is base64 minisign text — not a PEM block, and not the path
   to the file:

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/clipflow.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # only if you set one
   ```

3. Put the printed public key into `src-tauri/tauri.conf.json` at
   `plugins.updater.pubkey`.

4. Set `bundle.createUpdaterArtifacts` back to `true`.

5. Re-add the env block to the `tauri-action` step in
   `.github/workflows/release.yml`:

   ```yaml
   env:
     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
     TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
     TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
   ```

6. Tag a release and confirm it publishes `latest.json` plus `.sig` files for
   every artifact. If `.sig` files are missing, signing silently did not run.

## 4. Every release: fix the release notes by hand

`.github/workflows/release.yml` still generates the old body:

> Automatic updates are delivered through this release.

That is false while §1 is in effect. Until the workflow is updated (§5), rewrite
the body after each release:

```bash
gh release edit vX.Y.Z --notes-file path/to/notes.md
```

The body used for `v1.6.0` is a good template: a downloads table, a prominent
"automatic updates are disabled" section with the reason and the manual-download
path, then the changelog highlights.

Also confirm the portable asset name. `uploadPlainBinary: true` publishes the raw
binary as `clipflow_windows_x64.exe`; rename it to match the documented
`ClipFlow_vX.Y.Z_Portable.exe` convention:

```bash
gh api -X PATCH repos/drexjgobgt/ClipFlow-Dev/releases/assets/<numeric-id> \
  -f name="ClipFlow_vX.Y.Z_Portable.exe"
```

Numeric asset ids come from
`gh api repos/drexjgobgt/ClipFlow-Dev/releases/tags/vX.Y.Z --jq '.assets[].id'`.

## 5. Pending workflow changes

These were prepared but could not be pushed: the `gh` token in use has scopes
`gist`, `read:org`, `repo` only, and GitHub rejects any commit that touches
`.github/workflows/` without the `workflow` scope:

```
! [remote rejected] main -> main (refusing to allow an OAuth App to create or
  update workflow `.github/workflows/release.yml` without `workflow` scope)
```

The working-copy edit was reverted so the tree does not block later pushes.
Re-apply it once a workflow-scoped token is available:

```bash
gh auth refresh -h github.com -s workflow
```

The changes to make:

1. **Gate the release on the Rust tests.** The workflow runs
   `npm run typecheck && npm test` but never `cargo test`, so a tag can publish
   a build whose 43 Rust tests fail. Add:

   ```yaml
   - name: Rust tests
     run: cargo test --manifest-path src-tauri/Cargo.toml
   ```

2. **Drop the signing env var** from the `tauri-action` step while
   `createUpdaterArtifacts` is `false`. Leaving it is harmless — a bogus key is
   ignored when no updater artifacts are built, which is why `v1.6.0` succeeded
   — but it misleads readers into thinking signing still happens.

3. **Rewrite `releaseBody`** so it no longer claims updates are delivered.

4. **Replace the header comment** with a short pointer to this document.

## 6. Release checklist

- [ ] `npm run typecheck` and `npm test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] Version bumped in `package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json`
- [ ] `CHANGELOG.md` entry written
- [ ] `git tag -a vX.Y.Z` on the intended commit and push the tag
- [ ] Release workflow green
- [ ] Release notes rewritten per §4 (and the auto-update caveat kept while §1 holds)
- [ ] Portable asset renamed per §4
- [ ] Confirm the expected assets are present and no `.sig` file appeared by accident
