# scaffold/ - the dashboard you deploy and finish

You are the AI running this build. This folder is the working dashboard
shell. **Wire data into it; do not rebuild it.** The owner's look, screens,
checks and honesty rules are already done and match the rest of the kit.

## What's here

| File | What it is | Your job |
|---|---|---|
| `dashboard.html` | The whole frontend: period selector (region-aware financial year + custom range), metric cards with comparisons and trend lines, Connections screen, Check your numbers (reconciliation) screen, Settings panel, unverified banner, honest empty states. | Deploy as-is. Don't restyle; the owner can change venue name and accent colour in Settings. |
| `worker.js` | The backend shell: serves the page, metrics API, OAuth begin/callback, token store with refresh built in (rotating refresh tokens handled). | Fill the three `>>> ADAPTER` blocks against current provider docs. Everything else should rarely need touching. |
| `wrangler.toml` | Worker config: KV binding for tokens, Text rule for the page. | Deploy via GitHub → Cloudflare; the `TOKENS` KV namespace is auto-provisioned (no manual create). |
| `package.json` | Names the deploy script and the plain-English descriptions Cloudflare shows for each value during the one-click deploy. | Ship as-is. |
| `.dev.vars.example` | Declares `DASHBOARD_PASSCODE` for the one-click button's wizard (an optional override). By default the owner sets the password on the dashboard's first-run screen. | Ship as-is. |

## The contract between page and Worker (already agreed)

`GET /api/metrics?cur=FROM:TO&prev=FROM:TO&yoy=FROM:TO&trend=YYYY-MM:YYYY-MM&tz=...&rollover=N`

The page computes all date ranges (venue timezone, owner's week start,
trading-day rollover) and asks for explicit ranges. The Worker returns raw
source data; the page computes the metrics per `kpi-spec.md` (the locked
definitions live in the page, in one place):

```
{
  sources: { accounting|pos|rostering: { configured, connected, org, sandbox, lastSync, error{plain} } },
  periods: { cur|prev|yoy: { accounting:{revenue,cogs,wagesSuper,overheads}|null,
                             pos:{count}|null, rostering:{cost}|null } },
  trend:   { months:[...], accounting:{revenue[],cogs[],wagesSuper[],overheads[]}|null,
             pos:{count[]}|null }
}
```

Numbers are plain numbers (no strings), money ex GST/sales tax, `null` for
no-data. A source that fails returns `null` for its slot and a plain-English
`error` in `sources` - one broken tool never blanks the whole board.

## Deploy order (matches playbook.md Milestone 3)

The path is **GitHub → Cloudflare**: the deploy runs server-side from the repo, so
nobody pastes code into an editor.

1. Push this `scaffold/` (tailored, renamed into the owner's repo) to the owner's
   GitHub repo — push over `github.com` with a fine-grained token (agent sandboxes
   often can't reach `api.github.com` or the GitHub CLI). **Set `name` in
   `wrangler.toml` to the repo name first — it sets the URL and must match the
   repo.** Then run `node selftest.mjs` and push only when green. Public by
   default; private works too.
2. **Default — Workers Builds:** in the owner's Cloudflare, **Workers & Pages →
   Create → Import a repository →** pick the repo → Create. Cloudflare builds
   **from that same repo** (no clone) with `npx wrangler deploy` and
   **auto-provisions the `TOKENS` KV namespace** from `wrangler.toml`. **After the
   first deploy, pin that namespace's id in `wrangler.toml`** (read it from the CF
   dashboard) so later deploys reuse it instead of re-provisioning and orphaning
   the saved password/tokens. Every later push redeploys automatically.
3. The owner opens the URL and sets the dashboard password on its **first-run
   screen** (saved hashed in KV — no Cloudflare Variables step). `SESSION_SECRET`
   generates itself in KV on first run; never set it. (Provider credentials later
   go under Settings → Variables and Secrets.)
4. Open the URL: every card says **Not configured** until adapters are wired —
   correct and honest at this stage.
5. Wire the accounting adapter first (Milestone 4), then POS, then rostering;
   every push redeploys automatically.

### One-click alternative: the "Deploy to Cloudflare" button

Faster (it prompts for the password in its wizard), but it **clones the repo into
a new repo** in the owner's account and builds from the clone — so a push token
scoped to the original repo won't reach the repo Cloudflare builds, and you'll be
re-scoping mid-build. Prefer the Import path above; if you use the button, scope
the token to all repos (or create it after), and put the owner's repo URL in:

```
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/REPO)
```

Verify current Cloudflare behaviour (Import flow, auto-provision, secret handling)
against the docs at build time.

## Conventions the shell enforces (don't fight them)

- **Tokens live in KV** (`TOKENS`), written only by the Worker. Client ids,
  client secrets and pasted API tokens live in **Worker secrets** (named in
  `wrangler.toml`'s comment block). Nothing secret in the repo, ever.
- **Refresh is automatic.** `getValidAccessToken()` refreshes ahead of
  expiry and persists the rotated refresh token (Xero rotates on every
  refresh). If you cache a token anywhere else, you will break this.
- **One retry on 401** then a plain-English "needs reconnecting" status -
  the Connections screen renders it with a Reconnect button.
- **Callback URLs** are `https://<worker-url>/auth/<source>/callback`. The
  Connections screen shows each one so the exact string is easy to register
  in the provider's app settings.
- **Honesty rules** are implemented in the page: not-configured cards,
  "—" for average spend with zero transactions, projected always labelled
  projected, unverified banner until the owner confirms each metric on the
  Check your numbers screen. Don't bypass them.
- The owner's editable bits (venue name, default period, week start,
  rollover hour, timezone, accent colour) live in the Settings screen and
  the browser's local storage - by design, no code and no redeploy for the
  owner to personalise.

## The no-API rungs (built in - see capability-matrix.md for when to use which)

- **`POST /api/ingest?source=pos|accounting|rostering`** - body is the
  exported file's text; auth `Authorization: Bearer <INGEST_TOKEN>` (a Worker
  secret you generate; the same value is the owner's "upload code"). The
  source's `parseExport()` turns the file into day rows; rows land in the KV
  day-store (`data:<source>:<YYYY-MM-DD>`, same-day overwrite = re-uploads
  are safe).
- **Upload panel** - appears automatically on the Connections screen for any
  source whose adapter has `parseExport()`. The owner picks the file, enters
  the upload code once (kept in their browser), done.
- **`email()` handler** - stub at the bottom of worker.js for the emailed-
  reports rung (owner's domain on their Cloudflare + Email Routing). Complete
  it with postal-mime when that rung is chosen.
- **`scheduled()` + `scheduledPull()`** - cron hook for pulling a tool's own
  stable export URL on a schedule; uncomment `[triggers]` in wrangler.toml.
- **Export-mode adapters** - set `mode: 'export'` and implement
  `fetchRange`/`fetchMonthly` with `h.readIngested(from, to)` /
  `h.monthlyIngested(fromMonth, toMonth)` instead of provider calls. The rest
  of the dashboard (cards, comparisons, trends, reconciliation) works
  unchanged on ingested data.

## Notes

- **The dashboard is password-protected.** The owner sets their password on the
  dashboard's **first-run screen** (stored hashed in KV); the one-click button can
  collect it in its wizard instead (env `DASHBOARD_PASSCODE`). The session-signing
  key (`SESSION_SECRET`) is generated and stored in KV automatically on first run,
  so you never set it. Until a password is set the dashboard shows its set-password
  screen, never an open page. With it set, `/`, the
  metrics API, the disconnect action and the OAuth start all require a signed
  session cookie (HttpOnly, 30 days); `POST /api/login` checks the passcode and
  `POST /api/logout` clears it. `/api/ingest` keeps its own bearer-token auth.
- "Same period last year" uses weekday-aligned comparison for weeks (364
  days) and calendar alignment for months and financial years - the heading
  on each card states what it compares against.
