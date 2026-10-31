# npm beta publication — 31 October 2026

Published elf-tokens@1.0.0-beta.1 with public access under the beta tag, using the built tarball and browser authorization. The initial registry conflict was transient; the final publish exited successfully. The built beta passed a fresh-install smoke test including detached bridge shutdown. The package inventory contained 167 files with no forbidden private/state entries. All 60 extension tests passed; the prepublish build passed. Mintlify config passed the public JSON schema and navigation/assets checks.

Public docs source: https://github.com/nonyonah/elf-docs (main, docs.json at root). Domain: https://elf-docs.riftlabs.xyz. Mintlify must be connected to that repository/root; the previous domain deployment still served the Starter Kit at last inspection.

The extension README is extension/README.md and its license is extension/LICENSE (same MIT text as the repository). Marketplace publication requires the final publisher ID and a separately packaged/tested VSIX.
