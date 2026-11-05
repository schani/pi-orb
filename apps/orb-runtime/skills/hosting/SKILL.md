---
name: hosting
description: Publish and share HTML explainers, design documents, or other files from an orb at durable authenticated URLs with pi-orb host.
---

# Host files

When the user asks for a file they can open or share, including an HTML explainer or design document,
publish it and return the exact URL printed by the successful command:

```bash
pi-orb host file.html design/index.html
```

A repository-relative path is not a hosted URL. Do not present it as one.

Use `pi-orb host ls` to inspect published paths and `pi-orb host rm <path>` to remove one. Re-publishing a path replaces it. For a folder URL, publish its entry point as `<folder>/index.html` so relative assets resolve beneath that folder.

If an upload reports an unknown outcome, retry with the same request identity shown in the command guidance; do not choose a new identity until its outcome is known.
