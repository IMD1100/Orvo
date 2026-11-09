# Bencho Generate action

Source: https://github.com/cabralorenzo/bencho/tree/main/blocks/generate

Retrieved 2026-11-07 from the official repository. MIT copyright notice and complete licence are preserved in `LICENSE`. The original TSX and CSS are retained unchanged under `original/` for provenance and are not bundled into the app.

- Generate.tsx Git blob: `d603a6205c8810abfe02474cc8513e4601bba27e`
- Generate.css Git blob: `b2ced30135532f7148ec438e4a3d7bb620f9d671`
- LICENSE Git blob: `01852dfec9e48b34f06289cb583385c586d882bc`

`src/components/bencho/GenerateAction.tsx` extracts the original block's `gen-go` button markup and its pill material from `Generate.css`, composing the installed BoardUI Button. The original full block is an image-generation demonstration, so its placeholder picture, image filters, random percentage progression, synthetic timer, and canvas-specific absolute positioning are excluded. The adapted button triggers the real Python/native FX workflow. Its busy state reflects the actual request, with no invented progress percentage.

Bencho `--fill-on` and `--fill-slab` map to BoardUI `--color-text-primary` and `--color-background-primary-default`. Focus, hover, disabled and active colors use BoardUI semantic tokens. BoardUI retains keyboard behavior, composite typography and press behavior; the upstream scale animation is omitted. No new runtime dependency is required. No Bencho name/logo or licensed photographs are used in the product UI.

## Toast Stack

Adapted from https://github.com/cabralorenzo/bencho/tree/main/blocks/toast-stack (MIT, Copyright 2026 Lorenzo Cabra). The original component and stylesheet are preserved under `original/`; its card stylesheet and stacking interaction are adapted to real application notifications and BoardUI theme tokens. CSS transitions replace Framer Motion; demo messages are excluded. Notification history remains in the existing menu.

## Eye Tracker and Label Input

The original Eye Tracker `Watcher.tsx` and `Watcher.css` are used from https://github.com/cabralorenzo/bencho/tree/main/blocks/eye-tracker (MIT, Copyright 2026 Lorenzo Cabra). The surrounding layout, theme tokens and tracking boundary are adapted for the AI panel; the showcase chat bubble is hidden.

The multiline input retains BoardUI's Textarea and adapts the floating-label interaction from https://github.com/cabralorenzo/bencho/tree/main/blocks/label-input (MIT, Copyright 2026 Lorenzo Cabra). The original files are preserved under `original/`; its demonstration email/password field cannot directly serve as the controlled multiline prompt.

## Additional interaction adaptations

Rolling Counter, Create Menu, Action Node, Dynamic Island, Magnetic Select and Upload Dropzone are adapted from the matching MIT-licensed blocks at https://github.com/cabralorenzo/bencho (Copyright 2026 Lorenzo Cabra). These blocks are showcase demos; adaptations preserve the application's real state, keyboard controls, native audio drop and editable FX parameters, rather than demo data or simulated uploads.

## Liquid toggle

Effect toggles use the original Liquid toggle from https://github.com/cabralorenzo/bencho/tree/main/blocks/liq-toggle (MIT, Copyright 2026 Lorenzo Cabra), with controlled state and accessibility labels added for the application. Original files remain in `original/`.
