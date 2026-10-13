# PR integration

Rebased onto `1a5ce96`. Its image-viewer test added two ambient `getComputedStyle` calls, but E2E TypeScript has no DOM globals: TS2304 at lines 722/727. The same base commit's CI failed: https://github.com/schani/pi-orb/actions/runs/38439785390.

Use the evaluated element's `ownerDocument.defaultView` to access the browser API. Both existing outline assertions remain unchanged. Full workspace typecheck passes after correction. No image-viewer behavior change.
