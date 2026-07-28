/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'   // Xero's token endpoint wants HTTP Basic client auth (client_secret_basic)
    },

    /* Resolve + cache the connected Xero organisation (tenant). status() always
       re-checks live so a reconnect to a different org is picked up; fetchRange/
       fetchMonthly read the KV cache status() just wrote (status always runs first
       in apiMetrics), so they don't burn an extra API call per period requested. */
    async _tenant(env, h, opts) {
      if (!opts || !opts.fresh) {
        const cached = await env.TOKENS.get('xero:tenant');
        if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      }
      const conns = await h.fetchJson('https://api.xero.com/connections', {});
      if (!Array.isArray(conns) || !conns.length) {
        const e = new Error('no Xero organisation connected'); e.status = 401; throw e;
      }
      const t = { id: conns[0].tenantId, name: conns[0].tenantName || '' };
      await env.TOKENS.put('xero:tenant', JSON.stringify(t));
      return t;
    },

    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens) return { connected: false };
      const t = await this._tenant(env, h, { fresh: true });
      return { connected: true, org: t.name, sandbox: /demo company/i.test(t.name || '') };
    },

    async fetchRange(env, h, q) {
      const t = await this._tenant(env, h);
      const qs = new URLSearchParams({ fromDate: q.from, toDate: q.to });
      const data = await h.fetchJson(
        'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + qs.toString(),
        { headers: { 'Xero-Tenant-Id': t.id, 'Accept': 'application/json' } }
      );
      const rows = (data && data.Reports && data.Reports[0] && data.Reports[0].Rows) || [];
      return plSinglePeriod(rows);
    },

    async fetchMonthly(env, h, q) {
      const t = await this._tenant(env, h);
      const months = monthList(q.fromMonth, q.toMonth);
      const byMonth = {};
      /* Xero caps `periods` at 12 - split longer ranges into <=12-month chunks
         and stitch them (capability-matrix.md). */
      for (let i = 0; i < months.length; i += 12) {
        const chunk = months.slice(i, i + 12);
        const lastMo = chunk[chunk.length - 1];
        const [y, m] = lastMo.split('-').map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const toDate = lastMo + '-' + String(lastDay).padStart(2, '0');
        const qs = new URLSearchParams({ toDate, periods: String(chunk.length), timeframe: 'MONTH' });
        const data = await h.fetchJson(
          'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + qs.toString(),
          { headers: { 'Xero-Tenant-Id': t.id, 'Accept': 'application/json' } }
        );
        const rows = (data && data.Reports && data.Reports[0] && data.Reports[0].Rows) || [];
        const perPeriod = plMultiPeriod(rows, chunk.length, chunk);
        chunk.forEach((mo) => { byMonth[mo] = perPeriod[mo] || null; });
      }
      const out = { months, revenue: [], cogs: [], wagesSuper: [], overheads: [] };
      months.forEach((mo) => {
        const v = byMonth[mo];
        out.revenue.push(v ? v.revenue : null);
        out.cogs.push(v ? v.cogs : null);
        out.wagesSuper.push(v ? v.wagesSuper : null);
        out.overheads.push(v ? v.overheads : null);
      });
      return out;
    }
  }
};

/* ---------------- Xero P&L parsing helpers (accounting adapter) ---------- */
const WAGE_RE = /wages|salaries|superannuation|super|payroll|annual leave|long service|workcover/i;

function plAmount(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}
/* Section total for ONE amount column (single-period report): prefer the
   section's own SummaryRow total; fall back to summing its Row lines. */
function plSectionTotal(sectionRows) {
  const rows = sectionRows || [];
  const summary = rows.find((r) => r.RowType === 'SummaryRow');
  if (summary && summary.Cells && summary.Cells.length > 1) {
    return plAmount(summary.Cells[summary.Cells.length - 1].Value);
  }
  return rows.filter((r) => r.RowType === 'Row').reduce((s, r) => {
    if (!r.Cells || r.Cells.length < 2) return s;
    return s + plAmount(r.Cells[r.Cells.length - 1].Value);
  }, 0);
}
function plWagesSplit(sectionRows) {
  const total = plSectionTotal(sectionRows);
  let wages = 0;
  for (const r of (sectionRows || [])) {
    if (r.RowType !== 'Row' || !r.Cells || r.Cells.length < 2) continue;
    const label = String(r.Cells[0].Value || '');
    if (WAGE_RE.test(label)) wages += plAmount(r.Cells[r.Cells.length - 1].Value);
  }
  return { total, wages };
}
function plSectionKind(title) {
  const t = String(title || '').trim().toLowerCase();
  if (t === 'income' || t === 'trading income' || t === 'revenue') return 'income';
  if (t.indexOf('cost of sales') !== -1 || t.indexOf('cost of goods') !== -1) return 'cogs';
  if (t.indexOf('operating expenses') !== -1 || t === 'expenses' || t.indexOf('less operating expenses') !== -1) return 'opex';
  return null; /* Other Income and anything else is deliberately never added */
}
/* Single-period P&L (fromDate/toDate, no periods param -> exactly one amount
   column). Revenue = Income/Trading Income/Revenue section (Other Income
   excluded). Cost of goods = Cost of Sales section. Overheads = Operating
   Expenses less the wage/super lines (kept out per kpi-spec.md). */
function plSinglePeriod(rows) {
  let revenue = 0, cogs = 0, wagesSuper = 0, opExGross = 0;
  for (const row of (rows || [])) {
    if (row.RowType !== 'Section') continue;
    const kind = plSectionKind(row.Title);
    const sectionRows = row.Rows || [];
    if (kind === 'income') revenue += plSectionTotal(sectionRows);
    else if (kind === 'cogs') cogs += plSectionTotal(sectionRows);
    else if (kind === 'opex') {
      const { total, wages } = plWagesSplit(sectionRows);
      opExGross += total;
      wagesSuper += wages;
    }
  }
  return { revenue, cogs, wagesSuper, overheads: opExGross - wagesSuper };
}
/* Multi-period P&L (periods+timeframe+toDate -> one amount column per period).
   Map columns to calendar months using the report's own header labels rather
   than assuming a fixed order (Xero's column order for this parameter combo
   isn't documented as stable) - falls back to "most recent first" (the order
   Xero's own UI defaults to) only if the header labels don't parse as dates. */
function plHeaderMonths(rows, nPeriods) {
  const header = (rows || []).find((r) => r.RowType === 'Header');
  if (!header || !header.Cells || header.Cells.length < 2) return null;
  const labels = header.Cells.slice(1, 1 + nPeriods).map((c) => c.Value);
  const months = labels.map((label) => {
    const d = new Date(label);
    if (isNaN(d.getTime())) return null;
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  });
  return (months.length === nPeriods && months.every((m) => m)) ? months : null;
}
function plColumnTotals(sectionRows, nCols) {
  const rows = sectionRows || [];
  const summary = rows.find((r) => r.RowType === 'SummaryRow');
  if (summary && summary.Cells && summary.Cells.length > 1) {
    return Array.from({ length: nCols }, (_, i) => plAmount(summary.Cells[i + 1] && summary.Cells[i + 1].Value));
  }
  const totals = Array.from({ length: nCols }, () => 0);
  for (const r of rows) {
    if (r.RowType !== 'Row' || !r.Cells) continue;
    for (let i = 0; i < nCols; i++) totals[i] += plAmount(r.Cells[i + 1] && r.Cells[i + 1].Value);
  }
  return totals;
}
function plColumnWages(sectionRows, nCols) {
  const totals = Array.from({ length: nCols }, () => 0);
  for (const r of (sectionRows || [])) {
    if (r.RowType !== 'Row' || !r.Cells) continue;
    const label = String(r.Cells[0].Value || '');
    if (!WAGE_RE.test(label)) continue;
    for (let i = 0; i < nCols; i++) totals[i] += plAmount(r.Cells[i + 1] && r.Cells[i + 1].Value);
  }
  return totals;
}
function plMultiPeriod(rows, nPeriods, chunkMonthsAscending) {
  const colMonths = plHeaderMonths(rows, nPeriods) || chunkMonthsAscending.slice().reverse();
  const nCols = colMonths.length;
  const revenue = Array.from({ length: nCols }, () => 0);
  const cogs = Array.from({ length: nCols }, () => 0);
  const wagesSuper = Array.from({ length: nCols }, () => 0);
  const opExGross = Array.from({ length: nCols }, () => 0);
  for (const row of (rows || [])) {
    if (row.RowType !== 'Section') continue;
    const kind = plSectionKind(row.Title);
    if (!kind) continue;
    const sectionRows = row.Rows || [];
    const totals = plColumnTotals(sectionRows, nCols);
    if (kind === 'income') totals.forEach((v, i) => { revenue[i] += v; });
    else if (kind === 'cogs') totals.forEach((v, i) => { cogs[i] += v; });
    else if (kind === 'opex') {
      totals.forEach((v, i) => { opExGross[i] += v; });
      plColumnWages(sectionRows, nCols).forEach((v, i) => { wagesSuper[i] += v; });
    }
  }
  const out = {};
  colMonths.forEach((mo, i) => {
    out[mo] = { revenue: revenue[i], cogs: cogs[i], wagesSuper: wagesSuper[i], overheads: opExGross[i] - wagesSuper[i] };
  });
  return out;
}

Object.assign(ADAPTERS, {
  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'token',
    oauth: {},

    async _call(env, path, host, init) {
      const token = env.POS_API_TOKEN || '';
      const res = await fetch('https://' + host + path, {
        ...(init || {}),
        headers: {
          'Authorization': 'Bearer ' + token,
          'Square-Version': '2026-06-18',
          'Content-Type': 'application/json',
          ...((init && init.headers) || {})
        }
      });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    },

    /* Square's Sandbox/Production toggle produces separate tokens and separate
       hosts (capability-matrix.md) - try Production first (the expected case
       once the owner copies a Production token), fall back to Sandbox only so
       the dashboard can flag it rather than just erroring. status() always
       re-checks live; fetchRange/fetchMonthly read the cache status() just
       wrote (status always runs first in apiMetrics). */
    async _resolveHost(env, opts) {
      if (!opts || !opts.fresh) {
        const cached = await env.TOKENS.get('square:host');
        if (cached) return cached;
      }
      try {
        await this._call(env, '/v2/locations', 'connect.squareup.com');
        await env.TOKENS.put('square:host', 'connect.squareup.com');
        return 'connect.squareup.com';
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          await this._call(env, '/v2/locations', 'connect.squareupsandbox.com');
          await env.TOKENS.put('square:host', 'connect.squareupsandbox.com');
          return 'connect.squareupsandbox.com';
        }
        throw e;
      }
    },
    async _locationIds(env, host) {
      const cached = await env.TOKENS.get('square:locations');
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      const data = await this._call(env, '/v2/locations', host);
      const ids = ((data && data.locations) || []).map((l) => l.id).filter(Boolean);
      await env.TOKENS.put('square:locations', JSON.stringify(ids));
      return ids;
    },
    /* Count COMPLETED orders only (excludes voided/cancelled by construction;
       refunds are separate objects and never subtract from this count),
       paginating through every page of results. Hard-capped at MAX_PAGES so
       a very high-volume venue can never blow the Worker's per-request
       subrequest/resource limit (a crashed request beats nothing, but a
       capped-and-labelled undercount beats a crash). */
    async _countOrders(env, host, locationIds, startAt, endAt, maxPages) {
      let count = 0, cursor = null, pages = 0, capped = false;
      const cap = maxPages || 40;
      do {
        const body = {
          location_ids: locationIds,
          limit: 500,
          query: {
            filter: {
              date_time_filter: { closed_at: { start_at: startAt, end_at: endAt } },
              state_filter: { states: ['COMPLETED'] }
            }
          }
        };
        if (cursor) body.cursor = cursor;
        const data = await this._call(env, '/v2/orders/search', host, { method: 'POST', body: JSON.stringify(body) });
        count += ((data && data.orders) || []).length;
        cursor = (data && data.cursor) || null;
        pages++;
        if (pages >= cap && cursor) { capped = true; break; }
      } while (cursor);
      return { count, capped };
    },

    /* Short KV cache around the (possibly expensive) live count - repeated
       dashboard loads/reconciliation checks for the SAME range then read from
       here instead of re-running the full paginated search every time. This
       is what actually protects against the resource-limit crash under
       normal, repeated use (a fresh live count still happens once per range
       per 15 minutes). */
    async _cachedRangeCount(env, host, locationIds, startAt, endAt) {
      const key = 'poscache:range:' + startAt + ':' + endAt;
      const cached = await env.TOKENS.get(key);
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      const result = await this._countOrders(env, host, locationIds, startAt, endAt, 40);
      await env.TOKENS.put(key, JSON.stringify(result), { expirationTtl: 900 });
      return result;
    },

    async status(env, h) {
      if (!env.POS_API_TOKEN) return { connected: false };
      const host = await this._resolveHost(env, { fresh: true });
      const data = await this._call(env, '/v2/locations', host);
      const names = ((data && data.locations) || []).map((l) => l.name).filter(Boolean);
      return { connected: true, org: names.join(', ') || null, sandbox: host.indexOf('sandbox') !== -1 };
    },

    async fetchRange(env, h, q) {
      /* Prefer the day-store (instant, no live calls) once scheduledPull has
         covered every day in this range - falls back to a live (capped,
         short-cached) count for any range it hasn't reached yet. This is
         what keeps a busy venue's page load fast once the background sync
         has run at least once. */
      const totalDays = eachDate(q.from, q.to).length;
      const ing = await h.readIngested(q.from, q.to);
      if (totalDays > 0 && ing.daysWithData >= totalDays) {
        return { count: ing.sums.count || 0 };
      }
      const host = await this._resolveHost(env);
      const locationIds = await this._locationIds(env, host);
      const tz = q.tz || 'Australia/Sydney';
      const rollover = q.rollover || 0;
      const startAt = localBoundaryToUtc(q.from, rollover, tz);
      const endAt = localBoundaryToUtc(addDays(q.to, 1), rollover, tz);
      const { count } = await this._cachedRangeCount(env, host, locationIds, startAt, endAt);
      return { count };
    },

    /* The trend line reads from the day-store (fast, no live calls at all -
       protects the page load from ever hitting a resource limit) that
       scheduledPull() below fills in the background, once a day. Until the
       first background sync has run, this correctly shows "no data yet" per
       month rather than a live (and, for a busy venue, expensive) scan - the
       dashboard's own copy already explains this ("the trend fills in as
       monthly history comes in"). The reconciled per-period totals
       (fetchRange, above) are unaffected and stay live + exact. */
    async fetchMonthly(env, h, q) {
      const r = await h.monthlyIngested(q.fromMonth, q.toMonth);
      return { months: r.months, count: r.byMonth.map((s) => (s ? (s.count || 0) : null)) };
    },

    /* Cron rung (wrangler.toml [triggers]): once a day, pull a rolling window
       of completed-order counts per day into the day-store so fetchMonthly
       above never has to scan live. Uses a fixed default timezone for the
       day bucketing (a cron run has no per-request venue timezone/rollover
       to hand) - a small approximation that only affects the trend line;
       the reconciled numbers always come from the live, exact fetchRange
       path above. */
    async scheduledPull(env, h) {
      const host = await this._resolveHost(env, { fresh: true });
      const locationIds = await this._locationIds(env, host);
      const tz = 'Australia/Sydney';
      const todayStr = new Date().toISOString().slice(0, 10);
      const fromStr = addDays(todayStr, -400); /* a little over a year of history */
      const startAt = localBoundaryToUtc(fromStr, 0, tz);
      const endAt = localBoundaryToUtc(addDays(todayStr, 1), 0, tz);
      const byDay = {};
      let cursor = null, pages = 0;
      const MAX_PAGES = 200; /* a background job, not a page load - room for a full year */
      do {
        const body = {
          location_ids: locationIds,
          limit: 500,
          query: {
            filter: {
              date_time_filter: { closed_at: { start_at: startAt, end_at: endAt } },
              state_filter: { states: ['COMPLETED'] }
            }
          }
        };
        if (cursor) body.cursor = cursor;
        const data = await this._call(env, '/v2/orders/search', host, { method: 'POST', body: JSON.stringify(body) });
        for (const o of ((data && data.orders) || [])) {
          const closedAt = o.closed_at || o.created_at;
          if (!closedAt || closedAt.length < 10) continue;
          const day = closedAt.slice(0, 10);
          byDay[day] = (byDay[day] || 0) + 1;
        }
        cursor = (data && data.cursor) || null;
        pages++;
        if (pages >= MAX_PAGES && cursor) break;
      } while (cursor);
      const rows = Object.keys(byDay).map((date) => ({ date, count: byDay[date] }));
      await h.saveIngestedRows(rows);
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
});

/* ---------------- Timezone/day-boundary helpers (Square adapter) --------
   The venue's trading-day rollover (e.g. sales until 4am count to the
   previous trading day) and timezone matter for the POS count in a way they
   don't for the accounting P&L (Xero already books each entry to a date in
   the owner's ledger) - so this math lives here, not in the shared shell. */
function tzOffsetMinutes(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map = {};
  dtf.formatToParts(new Date(utcMs)).forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  const asIfUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return Math.round((asIfUtc - utcMs) / 60000);
}
/* UTC instant for "hourOffset:00 local wall-clock time on dateStr, in timeZone"
   (the trading-day rollover boundary). Accurate to the minute; offsets only
   change at DST transitions, which practically never land exactly on an
   early-morning rollover hour. */
function localBoundaryToUtc(dateStr, hourOffset, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guessUtc = Date.UTC(y, m - 1, d, hourOffset, 0, 0);
  const offMin = tzOffsetMinutes(guessUtc, timeZone);
  return new Date(guessUtc - offMin * 60000).toISOString();
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (adapter && adapter.auth === 'token') {
    /* Pasted-token sources (e.g. Square) have nothing to "start" in the browser -
       the paste into Cloudflare Variables and Secrets IS the connection. Just
       send them back to look at the (already live, if the secret is set)
       Connections screen rather than a dead-end page. */
    return Response.redirect(url.origin + '/', 302);
  }
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source IN PARALLEL (each source is
     an independent provider - there's no reason to make a slow POS page-scan
     block an already-finished Xero call), null where unavailable. */
  const out = {};
  await Promise.all(['accounting', 'pos', 'rostering'].map(async (source) => {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; return; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }));
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    /* cur/prev/yoy are three independent period slots and trend is
       independent of all three - run everything concurrently rather than
       one after another. This is what actually keeps page load to a few
       seconds instead of tens of seconds once multiple live sources and
       comparison periods are all in play. */
    let trendMonths = trend ? monthList(trend.fromMonth, trend.toMonth) : null;
    const [curOut, prevOut, yoyOut, trendPairs] = await Promise.all([
      fetchSlot(env, { ...base, ...cur }),
      prev ? fetchSlot(env, { ...base, ...prev }) : Promise.resolve(null),
      yoy ? fetchSlot(env, { ...base, ...yoy }) : Promise.resolve(null),
      trend ? Promise.all(['accounting', 'pos'].map(async (source) => {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) return [source, null];
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          return [source, alignSeries(trendMonths, series)];
        } catch (err) { return [source, null]; }
      })) : Promise.resolve(null)
    ]);
    const periods = { cur: curOut, prev: prevOut, yoy: yoyOut };
    let trendOut = null;
    if (trend) {
      trendOut = { months: trendMonths };
      trendPairs.forEach(([source, series]) => { trendOut[source] = series; });
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function handleFetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    if (path === '/api/sync' && (request.method === 'POST' || request.method === 'GET')) {
      /* Manual trigger for an adapter's background sync (normally only the
         daily cron calls this) - lets the very first sync happen right away
         instead of waiting for tonight's scheduled run. Logged-in only. */
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      const adapter = ADAPTERS[source];
      if (!adapter || typeof adapter.scheduledPull !== 'function') {
        return json({ error: 'no background sync for this source' }, 400);
      }
      try {
        await adapter.scheduledPull(env, makeHelpers(env, source));
        await noteSync(env, source);
        return json({ ok: true });
      } catch (err) {
        return json({ error: 'sync failed', debug: String((err && err.message) || err) }, 500);
      }
    }
    return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env) {
    /* TEMPORARY diagnostic wrapper: surfaces any uncaught error as JSON
       (with a debug field) instead of Cloudflare's generic error page, so it
       can be read directly (e.g. by opening /api/metrics... in a logged-in
       tab) without needing the Cloudflare Logs UI. Remove once the
       intermittent-error investigation is closed out. */
    try {
      return await handleFetch(request, env);
    } catch (err) {
      return new Response(JSON.stringify({
        error: 'internal',
        debug: String((err && err.stack) || (err && err.message) || err)
      }), { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
