Offline helper for the authorized, scoped, read-only lookup. Run only where the existing private DB route and IAM access already work. No proxy, tunnel, or new resource.

Manifest JSON: exactly two entries for **one provider**, one per project. DD:

```json
[
  {"projectId":"4661f85f-e70f-4ccd-b50d-2524496cb02a","connectionId":"c25b1857-1896-45cf-a427-a90cee36d125","service":"DD","url":"https://mcp.us5.datadoghq.com/v1/mcp"},
  {"projectId":"35f581fb-7bbf-4542-a1e8-0d047657a71d","connectionId":"e2c2ee5c-0fc9-4133-8f41-d333ed5e46c9","service":"DD","url":"https://mcp.us5.datadoghq.com/v1/mcp"}
]
```

CF uses URL `https://mcp.cloudflare.com/mcp` and IDs `1cfa006b-da21-4c11-9b5b-95cd28a9bf1b` (dedicated) and `406a3aeb-7e46-492e-b56a-07364453d511` (GlideOS). Never put credentials in the manifest.

`node scripts/native-mcp-exploration/live-qualification/oauth-public-lookup.mjs /path/to/dd-manifest.json playground-dev-6ae7 pi-orb-database-url 2 pi-orb-credential`

Run only after verifying the numeric DB secret version and prefix. Arguments are nonsecret metadata. DB URL is fetched in memory from the exact Secret Manager version. Session defaults and transactions are read-only; the first-party OAuth store checks active project and exact catalog URL/ID on both sides of the exact numeric credential-version read. Output contains fixed failure stage/reason codes and public registration metadata only. A public client ID identifies downstream registration, **not** an upstream UI grant or qualification. No revocation occurs.

Offline tests: `node --test scripts/native-mcp-exploration/live-qualification/oauth-public-lookup.test.mjs`.
