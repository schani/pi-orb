# Pi wrapper policy

Extracted from @earendil-works/pi-coding-agent 1.0.0 installed source maps. Research revision: 9b3c19da5cffc4c5e8b6bd74c45abc1ab6bfcd16. Upstream paths: packages/coding-agent/src/extensions/{codemode/tool.ts,codemode/execute.ts,tool-search/tool.ts}, packages/coding-agent/src/core/usage-totals.ts (SHA-256 8b18dd04d65e90af9b331cd5aa23d7891aab8a296f38a6026ce17a098d674ee9).

Source SHA-256:
```json
{
  "codemode-tool.ts": "67216b67186567278527edc5c6544cbb7e52a515a4887b4cf433299f8d1e9113",
  "tool-search-tool.ts": "b3b34e9a8ba06aafb2342f11b279f7c584d23b5cc5a5695a30e3758f35c133d7",
  "codemode-execute.ts": "36dac616e4bed8e162954a8e55aeabaefcea7acaf99c549f4db7c8863a9eddeb"
}
```

Adaptations: structural metadata types; only mode; exclude models/TUI/SDK lifecycle; host-provided scoped spilling; typed adapter boundaries; empty resources-only namespaces; bounded call metadata with argument keys rather than values. Namespace discovery accepts a live inventory callback; nested summaries retain execution-wait state. Namespace instructions are advertised by the first-party adapter after discovery, including deferred/resources-only servers, rather than added to the vendored inline catalog selector. Public pi-codemode parser, declarations and sandbox remain dependencies, not copied. The first-party bounded-worker.js imports the public worker entry and caps output messages before host collection; it does not copy or modify the sandbox.
