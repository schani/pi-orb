---
name: hosting
description: Publish files from an orb at durable authenticated URLs with the pi-orb host command.
---

# Host files

Publish a file and print its URL:

```bash
pi-orb host file.html design/index.html
```

Use `pi-orb host ls` to inspect published paths and `pi-orb host rm <path>` to remove one. Re-publishing a path replaces it. For a folder URL, publish its entry point as `<folder>/index.html` so relative assets resolve beneath that folder.

If an upload reports an unknown outcome, retry with the same request identity shown in the command guidance; do not choose a new identity until its outcome is known.
