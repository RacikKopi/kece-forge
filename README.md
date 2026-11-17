# kece-forge

Forge GitHub-compatible: git smart HTTP, REST v3, GraphQL, dan MCP — satu
proses, tanpa dependensi, Node.js stdlib saja.

## Jalankan

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

Server bind port ephemeral, register ke `$MAKEFUN_ENV_URL`, lalu menunggu
sinyal selesai. Token dipakai sebagai Bearer untuk semua endpoint; login
viewer diambil dari token (override lokal: `MAKEFUN_VIEWER_LOGIN`).

## Yang didukung

1. **Git smart HTTP** — `/{owner}/{repo}.git`
   - `upload-pack` protokol v2 (`ls-refs`, `fetch`, shallow/deepen) dan v0
   - `receive-pack` v0, fast-forward only, `unpack ok`
   - Pack polos (tanpa delta) — cukup untuk clone/fetch client
2. **REST v3** — `/api/v3`
   - Repos, branches, commits, contents, labels, issues, pulls (squash merge)
   - Semua reply JSON + `X-GitHub-Request-Id`; 401 tanpa token, 404 JSON
3. **GraphQL** — `/api/graphql`
   - `viewer`, `repository`, `node`, `__type`, issues/pulls dengan cursor,
     5 mutation (create/close issue, create/merge PR, add comment)
4. **MCP** — `/mcp`
   - `server/discover` (2026-07-28), `initialize`, 6 tools:
     `create_repo`, `get_repo`, `create_issue`, `list_issues`,
     `create_pull_request`, `merge_pull_request`

## Catatan desain

- Store in-memory, satu file `app.ts`. Timestamp commit deterministik
  (epoch tetap + counter) supaya replay identik.
- Nomor issue dan PR berbagi satu urutan per repo, seperti GitHub.
- Pack di-cache per repo sampai ada perubahan — clone berulang cepat.
- Semua error dijawab JSON, server tidak pernah mati karena request rusak.
