FROM pi-orb-runtime:dev

# Locked Linux Vite/esbuild closure; host dependencies may contain macOS binaries.
RUN npm ci --workspace @pi-orb/orb-runtime --include-workspace-root=true --ignore-scripts \
  && node scripts/apply-dependency-patches.mjs
