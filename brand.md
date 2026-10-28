# Elf brand

Elf keeps code and Figma design systems connected.

The official mascot is `assets/brand/elf-mascot.png`. This is the original transparent artwork, copied unchanged. Its most frequent opaque saturated violet, sampled from the source pixels, is **#6F3CFA**.

| Role | Light | Dark |
| --- | --- | --- |
| Primary action | #6F3CFA | #794AFC |
| Primary hover | #592BD5 | #6F3CFA |
| On primary | #FFFFFF | #FFFFFF |
| Focus indicator | #6F3CFA | #B49CFF |

Dark-mode shades are derived interface variants, not additional sampled brand colors. White on the light primary measures 5.67:1; white on the dark primary measures 5.00:1. Keep neutral surfaces and semantic success/warning/error colors. Existing typography stays unchanged.

Use the full mascot in Settings, onboarding, Figma plugin headers, and the extension listing/icon. The native extension uses a simplified monochrome elf silhouette for the activity bar and the full-color mascot for its project row. Respect the editor theme for native controls and status colors; do not introduce a webview just for branding.

Run `npm run build:brand` to regenerate local Settings/extension image copies and embed the mascot into both Figma plugin UIs. The plugin image is inline, requiring no external host or additional network permissions. Keep this build idempotent and package the generated images with releases. The canonical artwork must not be replaced by an AI recreation.

The status-bar mascot uses the same single-color silhouette as a registered product icon (`elf-mascot`). The committed `extension/media/elf-mascot.woff` is generated from `extension/media/elf.svg` by `scripts/build-status-icon.py` using FontTools as a build-time-only utility. No Python or font generator is needed by extension users. Settings uses a 32px mascot; onboarding uses 40px. Disconnect actions use the destructive red fill, separate from the brand violet and error text color.
