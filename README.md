# Trawlarr

Trawlarr is a media library transformation engine. It drives every file in a
media library toward a _known-good state_ defined by a user-authored
flowchart of processing steps — transcodes, remuxes, tag fixes, cleanup — and
converges the library toward that state as files, tools, and rules change
over time.

Trawlarr runs the community's existing Tdarr flow plugins unmodified. It is a
new implementation of the plugin host, built from a from-scratch design, not
a fork or a derivative of Tdarr's server or UI code.

## License

Trawlarr is MIT licensed. See [LICENSE](./LICENSE).

Trawlarr contains no code from
[Unmanic](https://github.com/Unmanic/unmanic). It began life as a fork of a
project maintained by [Josh.5](https://github.com/josh5), and this codebase
credits that lineage, but this repository is a ground-up rewrite: nothing
here is copied from that fork, from Tdarr, or from Tdarr_Plugins.

Compatibility with Tdarr is **interoperability, not derivation**: Trawlarr
implements the plugin contract (the shape of `args`, plugin metadata,
inputs/outputs) that the community's flow plugins already expect, so those
plugins run unmodified against a different, independently written host. No
Tdarr source is present in this repository.

## Plugins run as the service user — there is no sandbox

Installing a community plugin means downloading and executing that plugin
author's JavaScript directly, in the same process and with the same
privileges as the Trawlarr service itself. Trawlarr does not sandbox, isolate,
or restrict plugin code in any way. A plugin can read and write anything the
service user can, and can perform arbitrary I/O and network access.

Only install plugins from sources you trust. Trawlarr does not — and, as
currently designed, cannot — protect you from a malicious or compromised
plugin.

## Status

This repository currently contains only the workspace toolchain and the
`@trawlarr/core` package skeleton. The domain logic, the SQLite persistence
layer, and the plugin execution engine are being built out in subsequent
tasks; see [`docs/superpowers/specs/2026-08-10-trawlarr-design.md`](./docs/superpowers/specs/2026-08-10-trawlarr-design.md) for the design spec and [`docs/superpowers/plans/2026-08-10-trawlarr-p0-p1-engine.md`](./docs/superpowers/plans/2026-08-10-trawlarr-p0-p1-engine.md) for the implementation plan.

## Development

Requires Node.js 22 (LTS) and [pnpm](https://pnpm.io/) 9.

Node 22 is pinned in `.nvmrc`: if you use [nvm](https://github.com/nvm-sh/nvm), running `nvm use` will select the correct version. `better-sqlite3` ships prebuilt native binaries for Node 22; newer releases may not have prebuilds available yet and compilation would fail.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm audit:licenses
```
