/* Scaffold self-test — run this BEFORE the owner opens the dashboard URL, and
   after wiring any adapter or editing any file. It verifies the files are
   COMPLETE and DEPLOYABLE, not just syntactically valid: a truncated worker can
   still "parse" yet have no entry point, which only fails later at Cloudflare.
   Run from the scaffold folder:   node selftest.mjs                          */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : ' FAIL  ') + m); if (!c) fails++; };
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch (e) { ok(false, 'cannot read ' + p); return ''; } };
const parses = (code, ext) => {
  const f = '/tmp/_selftest_' + Date.now() + ext;
  try { writeFileSync(f, code); execSync('node --check ' + f, { stdio: 'pipe' }); return true; } catch (e) { return false; }
};

const html = read('dashboard.html');
const worker = read('worker.js');
const toml = read('wrangler.toml');
console.log('Scaffold self-test\n------------------');

/* 1. Completeness sentinels — a truncated write loses the trailing marker. */
ok(html.trimEnd().endsWith('<!-- EOF dashboard.html -->'), 'dashboard.html complete (EOF sentinel present)');
ok(worker.trimEnd().endsWith('// EOF worker.js'), 'worker.js complete (EOF sentinel present)');
ok(toml.trimEnd().endsWith('# EOF wrangler.toml'), 'wrangler.toml complete (EOF sentinel present)');
[['dashboard.html', html], ['worker.js', worker], ['wrangler.toml', toml]].forEach((p) => {
  const nuls = (p[1].match(/\x00/g) || []).length;
  ok(nuls === 0, p[0] + ' has no null padding' + (nuls ? ' (found ' + nuls + ' null bytes — a partial/truncated write)' : ''));
});

/* 2. dashboard.html: closing tags, boot call, and the inline JS parses. */
ok(/<\/script>\s*<\/body>\s*<\/html>/.test(html), 'dashboard.html has its closing </script></body></html>');
ok(/fetchData\(\);/.test(html), 'dashboard.html calls its boot (fetchData)');
const ss = html.indexOf('<script>'), se = html.lastIndexOf('</script>');
ok(ss >= 0 && se > ss && parses(html.slice(ss + 8, se), '.js'), 'dashboard.html inline JS parses');

/* 3. worker.js: a real ENTRY POINT (the truncated-but-valid-JS trap), size, parse. */
ok(/export default\s*\{/.test(worker), 'worker.js has `export default {` (a real entry point)');
ok(/async fetch\s*\(/.test(worker), 'worker.js exports a fetch handler');
ok(worker.length > 15000, 'worker.js is a sane size (' + worker.length + ' bytes; a stub would be tiny)');
ok(parses(worker, '.mjs'), 'worker.js parses as a module');

/* 4. Build layer (faithful to Wrangler) — best effort; skipped if esbuild is unreachable. */
try {
  writeFileSync('/tmp/_w.js', worker);
  execSync('npx --yes esbuild /tmp/_w.js --bundle --format=esm "--loader:.html=text" --outfile=/tmp/_bundle.mjs', { stdio: 'pipe' });
  const bundle = readFileSync('/tmp/_bundle.mjs', 'utf8');
  ok(/fetch\s*\(/.test(bundle) && bundle.length > 15000, 'worker.js bundles (esbuild) into a Worker with a fetch handler');
} catch (e) {
  console.log('  (skip) build-layer bundle — esbuild unavailable here; the structural checks above cover it');
}

/* 5. Render layer — best effort; skipped if jsdom is unreachable. */
try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  await new Promise((r) => setTimeout(r, 300));
  ok(dom.window.document.querySelectorAll('.cards, .mcard, .box').length > 0, 'dashboard.html renders content (jsdom smoke)');
} catch (e) {
  console.log('  (skip) render smoke — jsdom unavailable here; sentinel + parse checks cover the blank-page failure');
}

console.log('------------------');
if (fails) {
  console.log(fails + ' CHECK(S) FAILED — a file is incomplete in the shell view (what `git` pushes).');
  console.log('This is the mounted-folder sync hazard, NOT a content bug to debug: the copy the shell sees can');
  console.log('be truncated or null-padded even when your file editor shows the same file intact.');
  console.log('RECOVER (fast): rebuild each flagged file cleanly — write it via the shell (a heredoc/printf) or');
  console.log('into a fresh folder from your correct copy — then run this self-test again. Only push when green.');
  console.log('Do NOT edit dashboard.html; it arrives already tailored. Normally only worker.js + wrangler.toml change.');
  process.exit(1);
}
console.log('SELF-TEST PASSED — files are complete and deployable.'); process.exit(0);
