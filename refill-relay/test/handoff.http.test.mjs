import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  SESSION_COOKIE_NAME,
  STATUS_LABELS,
  EVENT_TYPES,
  caseRefFor,
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
} from '../store.mjs';
import { startServer } from '../server.mjs';

// --- helpers ---------------------------------------------------------------

// One fresh disposable database per test: unique temp dir, schema, fixture
// set, and local synthetic accounts (so real HTTP sign-in works).
function makeEnv(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-handoff-${tag}-`));
  const dbPath = join(dir, `handoff-${tag}.sqlite`);
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
}

// The accepted synthetic rehearsal case (plan §4.2, fixture reuse):
// ending-b-renewal — 'Sent to pharmacy', assigned to pharmacy-cedar
// (the responsible pharmacy user) and ending-b-prescriber, with
// ending-b-rx at ZERO refills.
const HANDOFF_CASE = Object.freeze({
  id: 'ending-b-renewal',
  prescription_id: 'ending-b-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});

const HANDOFF_REF = caseRefFor(HANDOFF_CASE.id);

// A second 'Sent to pharmacy' rehearsal case for the HTML failed-save
// phase (the failHandoffCommit seam fires on the transition path, and the
// first case is already handed off by the recovery above): a fresh
// zero-refill prescription assigned to the responsible pharmacy user and
// the same assigned prescriber, with no renewal.
const HTML_HANDOFF_RX = Object.freeze({
  id: 'handoff-html-rx',
  patient_id: 'denial-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
  refills_remaining: 0,
});
const HTML_HANDOFF_CASE = Object.freeze({ id: 'handoff-html-renewal' });
const HTML_HANDOFF_REF = caseRefFor(HTML_HANDOFF_CASE.id);

function seedSecondPendingCase(dbPath) {
  const db = initDatabase(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(HTML_HANDOFF_RX.id, HTML_HANDOFF_RX.patient_id, HTML_HANDOFF_RX.pharmacy_id, HTML_HANDOFF_RX.prescriber_id);
    db.prepare(
      `INSERT INTO renewals
         (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
          status, next_actor, submitted_at, handoff_at, decided_at,
          granted_refills, request_idempotency_key, version)
       VALUES (?, ?, ?, ?, ?, ?, 'pharmacy', ?, NULL, NULL, NULL, NULL, 1)`
    ).run(
      HTML_HANDOFF_CASE.id,
      HTML_HANDOFF_RX.id,
      HTML_HANDOFF_RX.patient_id,
      HTML_HANDOFF_RX.pharmacy_id,
      HTML_HANDOFF_RX.prescriber_id,
      STATUS_LABELS.SENT_TO_PHARMACY,
      '2026-11-21T11:00:00Z'
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Connection: 'close',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, raw: text };
}

// Form (urlencoded) request over real loopback HTTP, as a native browser
// form would submit it (Accept: text/html selects the HTML responses).
async function httpForm(url, { method = 'POST', headers = {}, form = {} } = {}) {
  const body = Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const res = await fetch(url, {
    method,
    headers: {
      Connection: 'close',
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function fetchHtml(url, { headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { Connection: 'close', Accept: 'text/html', ...headers },
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

// JSON sign-in (estate convention): returns the cookie header for the
// durable server-side session.
async function signInClient(base, username, password) {
  const res = await httpJson(`${base}/sign-in`, {
    method: 'POST',
    body: { username, password },
  });
  assert.equal(res.status, 200, `${username}: HTTP sign-in status`);
  assert.equal(res.body.ok, true, `${username}: HTTP sign-in ok`);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(sessionCookie, `${username}: sign-in sets the session cookie`);
  const token = sessionCookie.slice(`${SESSION_COOKIE_NAME}=`.length).split(';')[0];
  assert.match(token, /^[0-9a-f]{64}$/, `${username}: opaque session token`);
  return { cookieHeader: `${SESSION_COOKIE_NAME}=${token}`, token, identity: res.body.identity };
}

async function signOutClient(base, cookieHeader) {
  const res = await httpJson(`${base}/sign-out`, { method: 'POST', headers: { Cookie: cookieHeader } });
  assert.equal(res.status, 200);
  assert.equal(res.body.invalidated, true);
  return res;
}

// The native "Request renewal" affordance on the case detail page: a
// labeled, no-JS POST form carrying the stable opaque case reference.
function handoffFormIn(html, label) {
  const m = html.match(
    /<form([^>]*)>\s*<input type="hidden" name="case_ref" value="([0-9a-f]{32})">\s*<button type="submit">Request renewal<\/button>\s*<\/form>/
  );
  if (!m) return null;
  const attrs = {};
  for (const attr of m[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
  return { attrs, caseRef: m[2] };
}

// Scalar-only full-table snapshot (fresh connection) for durable-state
// equality claims (estate convention).
function fullTableState(dbPath) {
  const db = initDatabase(dbPath);
  try {
    const snapshot = (table, orderExpr) =>
      db
        .prepare(`SELECT * FROM ${table} ORDER BY ${orderExpr}`)
        .all()
        .map((r) => Object.values(r));
    return {
      markers: snapshot('markers', 'key'),
      identities: snapshot('identities', 'id'),
      prescriptions: snapshot('prescriptions', 'id'),
      renewals: snapshot('renewals', 'id'),
      renewal_events: snapshot('renewal_events', 'id'),
      pharmacy_conversation_messages: snapshot('pharmacy_conversation_messages', 'id'),
      office_messages: snapshot('office_messages', 'id'),
      phone_notes: snapshot('phone_notes', 'id'),
      sessions: snapshot('sessions', 'token'),
      synthetic_accounts: snapshot('synthetic_accounts', 'username'),
    };
  } finally {
    db.close();
  }
}

function assertStateUnchanged(after, before, label) {
  for (const table of Object.keys(before)) {
    assert.deepEqual(after[table], before[table], `${label}: durable table ${table} unchanged`);
  }
}

// Case-data disclosure tokens: any fixture value appearing in a denial or
// error response body means case data was disclosed (estate convention).
const CASE_DATA_TOKENS = [
  'ending-a-renewal', 'ending-b-renewal',
  'ending-a-rx', 'ending-b-rx', 'denial-rx',
  'ending-a-patient', 'ending-b-patient', 'denial-patient',
  'ending-a-prescriber', 'ending-b-prescriber', 'denial-prescriber',
  'pharmacy-cedar', 'pharmacy-dunmore',
  'Ava Mercer', 'Boris Laine', 'Cleo Voss',
  'Dr. Naomi Okafor', 'Dr. Priya Raman', 'Dr. Emil Hart',
  'Cedar Crossing Pharmacy', 'Dunmore Corner Pharmacy',
  STATUS_LABELS.SENT_TO_PHARMACY,
  STATUS_LABELS.AWAITING_PRESCRIBER,
  STATUS_LABELS.RENEWAL_APPROVED,
  STATUS_LABELS.VISIT_REQUIRED,
  '2026-11-21T08:00:00Z', '2026-11-21T08:30:00Z', '2026-11-21T09:00:00Z',
  '2026-11-21T10:00:00Z',
];

function assertNoCaseFields(body, label) {
  const serialized = JSON.stringify(body);
  for (const token of CASE_DATA_TOKENS) {
    assert.ok(
      !serialized.includes(token),
      `${label}: response must contain no case fields (found ${JSON.stringify(token)})`
    );
  }
}

function assertNoCaseDataHtml(html, label) {
  for (const token of CASE_DATA_TOKENS) {
    assert.ok(
      !html.includes(token),
      `${label}: returned HTML must contain no case data (found ${JSON.stringify(token)})`
    );
  }
}

function assertNoScriptsOrHandlers(html, label) {
  assert.ok(!/<script[\s>]/i.test(html), `${label}: no inline script elements`);
  assert.ok(!/on(click|submit|change|load|focus|input|key)\s*=/i.test(html),
    `${label}: no inline event handlers`);
}

// The durable rehearsal-case row + handoff events (fresh connection).
function durableCase(dbPath) {
  const db = initDatabase(dbPath);
  try {
    return {
      row: db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HANDOFF_CASE.id),
      events: db
        .prepare(`SELECT * FROM renewal_events WHERE renewal_id = ? AND event_type = ?`)
        .all(HANDOFF_CASE.id, EVENT_TYPES.HANDOFF),
    };
  } finally {
    db.close();
  }
}

// The durable assertions shared by the success, retry, overlap, and
// recovery paths: one transition (version 1 -> 2), exactly one handoff
// event recording the durable handoff time, the prescriber as next actor.
function assertOneHandoffDurable(dbPath, label, { firstTimestamp = null } = {}) {
  const { row, events } = durableCase(dbPath);
  assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER, `${label}: case is Awaiting prescriber`);
  assert.equal(row.next_actor, 'prescriber', `${label}: the prescriber is the next actor`);
  assert.equal(row.version, 2, `${label}: exactly ONE committed transition (version 1 -> 2)`);
  assert.equal(events.length, 1, `${label}: exactly one handoff event`);
  assert.equal(events[0].actor_role, 'pharmacy', `${label}: the event is acted by the pharmacy role`);
  assert.equal(events[0].occurred_at, row.handoff_at, `${label}: the event records the handoff time`);
  if (firstTimestamp !== null) {
    assert.equal(row.handoff_at, firstTimestamp, `${label}: the ORIGINAL first valid handoff timestamp is preserved`);
  }
  assert.ok(!Number.isNaN(Date.parse(row.handoff_at)), `${label}: the handoff time is a valid timestamp`);
}


test('over-HTTP: successful pharmacy handoff (scenario 1) — JSON 200 and native-form 303; the prescriber portal and the pharmacy refresh show the durable saved state', async () => {
  const env = makeEnv('success');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(pharmacy.identity.role, 'pharmacy');

    // --- the authorized detail view BEFORE the handoff: the native -----
    // "Request renewal" affordance is present, labeled, and carries the
    // stable opaque case reference (RFRLM-FR-001/002).
    const detailBefore = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, {
      headers: { Cookie: pharmacy.cookieHeader },
    });
    assert.equal(detailBefore.status, 200, 'the assigned pharmacy reads the case detail');
    assert.ok(detailBefore.text.includes(STATUS_LABELS.SENT_TO_PHARMACY), 'the case shows Sent to pharmacy');
    assert.ok(detailBefore.text.includes('Dr. Priya Raman'), 'the assigned prescriber is shown');
    assert.ok(detailBefore.text.includes('0'), 'the zero-refill condition is shown');
    assertNoScriptsOrHandlers(detailBefore.text, 'detail before handoff');
    const form = handoffFormIn(detailBefore.text, 'detail before handoff');
    assert.ok(form, 'the native Request renewal form is present for the responsible pharmacy');
    assert.equal(form.attrs.method, 'post', 'the handoff form is a native POST');
    assert.equal(form.attrs.action, '/handoff', 'the handoff form posts to the /handoff route');
    assert.equal(form.attrs['aria-label'], 'Request renewal', 'the handoff form carries an accessible name');
    assert.equal(form.caseRef, HANDOFF_REF, 'the handoff form carries the stable opaque case ref');
    // The same page for the OTHER assigned case (a final outcome) has no
    // handoff form: the affordance is gated on the saved state.
    const terminalDetail = await fetchHtml(`${base}/cases?case=${caseRefFor('ending-a-renewal')}`, {
      headers: { Cookie: pharmacy.cookieHeader },
    });
    assert.equal(terminalDetail.status, 200);
    assert.equal(handoffFormIn(terminalDetail.text, 'terminal case'), null, 'a final case shows no handoff form');

    // --- JSON handoff: 200 handed-off with the planned fields -----------
    const t0 = Date.now();
    const first = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    const t1 = Date.now();
    // NFR-001/KPI-005 measurement (recorded, no threshold asserted):
    // server receipt -> saved state observable.
    console.log(`[measure] successful handoff over HTTP elapsed: ${t1 - t0} ms`);
    assert.equal(first.status, 200, 'the first handoff is a 200 (no new resource is created)');
    assert.equal(first.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(
      Object.keys(first.body).sort(),
      ['code', 'created', 'ok', 'renewal'],
      'handed-off response carries exactly the planned top-level fields'
    );
    assert.equal(first.body.ok, true);
    assert.equal(first.body.created, true);
    assert.equal(first.body.code, 'handed-off');
    assert.deepEqual(
      Object.keys(first.body.renewal).sort(),
      ['handoff_at', 'id', 'next_actor', 'status', 'submitted_at'],
      'the renewal carries the planned fields (no more)'
    );
    assert.equal(first.body.renewal.id, HANDOFF_CASE.id, 'the SAME case is handed off');
    assert.equal(first.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(first.body.renewal.next_actor, 'prescriber', 'the prescriber is the next actor');
    assert.ok(!Number.isNaN(Date.parse(first.body.renewal.handoff_at)), 'the handoff time is recorded');
    assert.equal(first.body.renewal.submitted_at, '2026-11-21T10:00:00Z', 'the original submission time is preserved');
    const firstTimestamp = first.body.renewal.handoff_at;

    // Durable invariants (fresh connection).
    assertOneHandoffDurable(env.dbPath, 'successful handoff', { firstTimestamp });

    // --- HTML: the native form submission 303s to the stable case detail -
    // (the form itself is re-fetched fresh on the terminal-state case so
    // the exact rendered wiring is exercised; here the form is already
    // consumed, so the 303 is exercised via the idempotent replay below —
    // the form element above is the native wiring evidence).
    const formRetry = await httpForm(`${base}/handoff`, {
      headers: { Cookie: pharmacy.cookieHeader },
      form: { case_ref: HANDOFF_REF },
    });
    assert.equal(formRetry.status, 303, 'the native form submission is a 303 redirect');
    assert.equal(formRetry.headers.get('location'), `/cases?case=${HANDOFF_REF}`, 'the 303 targets the stable case detail');
    assert.equal(formRetry.text, '', 'the 303 carries no body');
    const detailAfter = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, {
      headers: { Cookie: pharmacy.cookieHeader },
    });
    assert.equal(detailAfter.status, 200, 'the case detail resolves after the 303');
    assert.ok(detailAfter.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'the detail shows Awaiting prescriber');
    assert.ok(detailAfter.text.includes('Next actor'), 'the detail shows the next actor term');
    assert.ok(detailAfter.text.includes(firstTimestamp), 'the detail shows the saved handoff time');
    assert.equal(handoffFormIn(detailAfter.text, 'detail after handoff'), null, 'the form disappears on the handed-off case');
    assertNoScriptsOrHandlers(detailAfter.text, 'detail after handoff');

    // --- the assigned prescriber's portal (RFRLM-FR-002): the same case -
    // is available in the prescriber queue and in the copied-link detail
    // with the durable saved state.
    const prescriber = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    assert.equal(prescriber.identity.role, 'prescriber');
    const prescQueue = await httpJson(`${base}/cases`, { headers: { Cookie: prescriber.cookieHeader } });
    assert.equal(prescQueue.status, 200, 'the prescriber queue is authorized');
    assert.deepEqual(
      prescQueue.body.cases.map((c) => c.id),
      [HANDOFF_CASE.id],
      'the handed-off case is available to the assigned prescriber'
    );
    assert.equal(prescQueue.body.cases[0].status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(prescQueue.body.cases[0].next_actor, 'prescriber');
    assert.equal(prescQueue.body.cases[0].handoff_at, firstTimestamp);
    const prescDetail = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, {
      headers: { Cookie: prescriber.cookieHeader },
    });
    assert.equal(prescDetail.status, 200, 'the prescriber copied-link detail resolves');
    assert.ok(prescDetail.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'the prescriber sees Awaiting prescriber');
    assert.ok(prescDetail.text.includes(firstTimestamp), 'the prescriber sees the handoff time');
    assert.equal(handoffFormIn(prescDetail.text, 'prescriber detail'), null, 'the prescriber sees no handoff form');

    // --- the pharmacy's own refresh shows the saved state ---------------
    const refresh = await httpJson(`${base}/cases?case=${HANDOFF_REF}`, {
      headers: { Cookie: pharmacy.cookieHeader },
    });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.case.id, HANDOFF_CASE.id, 'the pharmacy refresh shows the same case');
    assert.equal(refresh.body.case.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(refresh.body.case.next_actor, 'prescriber');
    assert.equal(refresh.body.case.handoff_at, firstTimestamp, 'the pharmacy refresh shows the saved handoff time');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: retry after success is idempotent — 200 already-handed-off, the case remains Awaiting prescriber with one status change, one handoff event, and the original first valid handoff timestamp', async () => {
  const env = makeEnv('retry');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;
    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');

    const before = fullTableState(env.dbPath);
    const first = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(first.status, 200, 'the first handoff succeeds');
    assert.equal(first.body.code, 'handed-off');
    const firstTimestamp = first.body.renewal.handoff_at;

    // --- the retry: 200 already-handed-off, original state --------------
    const retry = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(retry.status, 200, 'the retry is a 200');
    assert.equal(retry.body.ok, true);
    assert.equal(retry.body.created, false, 'the retry creates nothing');
    assert.equal(retry.body.code, 'already-handed-off', 'the replay indicator');
    assert.equal(retry.body.renewal.id, HANDOFF_CASE.id, 'the same case');
    assert.equal(retry.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'still Awaiting prescriber');
    assert.equal(retry.body.renewal.next_actor, 'prescriber');
    assert.equal(retry.body.renewal.handoff_at, firstTimestamp, 'the ORIGINAL first valid handoff timestamp is preserved');
    assert.equal(retry.body.renewal.submitted_at, '2026-11-21T10:00:00Z');

    // Durable: one transition, one event, original timestamp, no
    // duplicate case, event, or history row of any kind.
    assertOneHandoffDurable(env.dbPath, 'retry', { firstTimestamp });
    const after = fullTableState(env.dbPath);
    assert.equal(after.renewals.length, before.renewals.length, 'no duplicate case row');
    assert.equal(after.renewal_events.length, before.renewal_events.length + 1, 'exactly one event row total (the handoff)');
    assert.equal(after.pharmacy_conversation_messages.length, before.pharmacy_conversation_messages.length, 'no message history');
    assert.equal(after.office_messages.length, before.office_messages.length, 'no office messages');
    assert.equal(after.phone_notes.length, before.phone_notes.length, 'no phone notes');
    for (const table of Object.keys(before)) {
      if (table === 'renewals' || table === 'renewal_events') continue;
      assert.deepEqual(after[table], before[table], `table ${table} unchanged by the retry`);
    }
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: overlapping handoff requests (scenario 2) — both requests entered the handoff handler before the first successful commit (cell 3 >= 2), and the durable state holds one transition, one event, and the first timestamp', async () => {
  const env = makeEnv('overlap');
  let appA;
  let overlapWorker;
  // One shared SAB, handed to BOTH server instances (the plan §5.5.2
  // protocol): cell 0 = handler entry count, cell 1 = a first writer holds
  // uncommitted writes, cell 2 = release, cell 3 = entries at first commit.
  const sab = new SharedArrayBuffer(16);
  const obs = new Int32Array(sab);
  try {
    // Server A runs on the main thread (request 1 lives in its handler).
    // Server B runs on its OWN worker thread: request 1's store holds the
    // write lock with UNCOMMITTED writes and blocks its own event loop in
    // the deterministic hold, so request 2 must be serviced by an
    // independent event loop to both (a) enter the handler — incrementing
    // the entry count and releasing the hold — and (b) run its bounded
    // lock retry until request 1 commits.
    appA = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0, options: { handoffObserve: sab } });
    const baseA = `http://127.0.0.1:${appA.port}`;
    const serverModule = new URL('../server.mjs', import.meta.url).href;

    // Two independent sessions of the SAME responsible pharmacy identity.
    const pharmacyA = await signInClient(baseA, 'pharmacy.cedar', 'pharmacy-cedar-2026');

    // Worker thread: starts the second server instance on its own event
    // loop, then issues request 2 the moment it observes that request 1
    // holds the write lock with UNCOMMITTED writes (cell 1 === 1). Because
    // request 2 is dispatched only then, the hold is guaranteed and cell 3
    // (captured at the first commit) proves both requests entered the
    // handoff handler before the first successful commit — deterministic,
    // not timing-dependent.
    const workerScript = `import { parentPort } from 'node:worker_threads';
      const { startServer } = await import(${JSON.stringify(serverModule)});
      const fail = (message) => {
        parentPort.postMessage({ type: 'error', message });
        process.exitCode = 1;
      };
      (async () => {
        const sab = await new Promise((resolve, reject) => {
          parentPort.once('message', (m) => (m && m.type === 'sab' ? resolve(m.sab) : reject(new Error('unexpected first worker message'))));
        });
        const obs = new Int32Array(sab);
        const appB = await startServer({ dbPath: ${JSON.stringify(env.dbPath)}, host: '127.0.0.1', port: 0, options: { handoffObserve: sab } });
        parentPort.postMessage({ type: 'ready', baseB: \`http://127.0.0.1:\${appB.port}\` });
        const init = await new Promise((resolve, reject) => {
          parentPort.once('message', (m) => (m && m.type === 'init' ? resolve(m) : reject(new Error('unexpected second worker message'))));
        });
        const deadline = Date.now() + 15000;
        for (;;) {
          if (Atomics.load(obs, 1) === 1) break;
          if (Date.now() > deadline) {
            fail('request 1 never reached the uncommitted-write hold');
            return;
          }
          Atomics.wait(obs, 1, 0, 25);
        }
        const res = await fetch(\`\${init.baseB}/handoff\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Connection: 'close', Cookie: init.cookieHeader },
          body: JSON.stringify({ case_ref: init.caseRef }),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        parentPort.postMessage({ type: 'result', status: res.status, body: parsed });
      })().catch((err) => fail(String((err && err.message) || err)));
    `;
    overlapWorker = new Worker(workerScript, { eval: true });
    const workerMessages = [];
    const workerWaiters = [];
    overlapWorker.on('message', (m) => {
      workerMessages.push(m);
      for (const w of workerWaiters.splice(0)) w(m);
    });
    const nextWorkerMessage = (type) =>
      new Promise((resolve, reject) => {
        const found = workerMessages.find((m) => m.type === type);
        if (found) return resolve(found);
        const deadline = setTimeout(() => reject(new Error(`timed out waiting for worker message ${type}`)), 15000);
        workerWaiters.push((m) => {
          if (m.type === type) {
            clearTimeout(deadline);
            resolve(m);
          } else if (m.type === 'error') {
            clearTimeout(deadline);
            reject(new Error(m.message));
          }
          // Non-matching non-error messages stay queued for the next waiter.
          if (m.type !== type) workerMessages.splice(workerMessages.indexOf(m), 1);
        });
      });
    const workerErrorPromise = new Promise((resolve, reject) => {
      overlapWorker.once('error', reject);
      overlapWorker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`overlap worker exited with code ${code}`));
        else resolve(null);
      });
    });
    overlapWorker.postMessage({ type: 'sab', sab });
    const ready = await Promise.race([nextWorkerMessage('ready'), workerErrorPromise]);
    if (!ready) throw new Error('overlap worker failed to start the second server');

    // Sign the second pharmacy session in through server B (independent
    // session; sessions are durable rows, so it resolves on either server).
    const pharmacyB = await signInClient(ready.baseB, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.notEqual(pharmacyA.token, pharmacyB.token, 'two independent sessions of the responsible pharmacy');

    // Release the worker to watch cell 1 and fire request 2.
    overlapWorker.postMessage({
      type: 'init',
      baseB: ready.baseB,
      cookieHeader: pharmacyB.cookieHeader,
      caseRef: HANDOFF_REF,
    });

    // Durable state BEFORE the overlap: both overlapping sessions are
    // committed, so the reference is stable for the before/after diff.
    const beforeOverlap = fullTableState(env.dbPath);
    assert.equal(beforeOverlap.renewals.length, 2, 'reference includes only the two fixture renewals');
    assert.equal(beforeOverlap.renewal_events.length, 0, 'reference has no events');
    assert.equal(beforeOverlap.sessions.length, 2, 'reference includes the two overlapping sessions');

    // Fire request 1 at server A, then await BOTH outcomes: the worker
    // fires request 2 only once request 1 provably holds uncommitted
    // writes (cell 1), so request 1 must already be in flight.
    const t0 = Date.now();
    const resAPromise = httpJson(`${baseA}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacyA.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    const resB = await Promise.race([nextWorkerMessage('result'), workerErrorPromise]);
    if (!resB) throw new Error('overlap worker failed to deliver request 2');
    const resA = await resAPromise;
    const t1 = Date.now();
    console.log(`[measure] overlapping handoffs over HTTP elapsed: ${t1 - t0} ms`);

    // Both requests succeeded (2xx): no error, no 500, no lock-contention
    // failure escapes over HTTP.
    assert.ok(resA.status === 200, `request 1: 200 outcome (got ${resA.status}: ${resA.raw})`);
    assert.equal(resB.status, 200, `request 2: 200 outcome (got ${resB.status})`);
    assert.equal(resA.body.ok, true, 'request 1 outcome flag');
    assert.equal(resB.body.ok, true, 'request 2 outcome flag');

    // The two outcomes partition the first/replay split: one handed-off,
    // the other already-handed-off — same case either way.
    const codes = [resA.body.code, resB.body.code].sort();
    assert.deepEqual(codes, ['already-handed-off', 'handed-off'], 'one committed handoff, one idempotent replay');
    const winner = resA.body.code === 'handed-off' ? resA : resB;
    const loser = resA.body.code === 'handed-off' ? resB : resA;
    assert.equal(winner.body.renewal.id, HANDOFF_CASE.id, 'the winner handed off the same case');
    assert.equal(loser.body.renewal.id, HANDOFF_CASE.id, 'the replay returns the same case');
    assert.equal(winner.body.renewal.handoff_at, loser.body.renewal.handoff_at, 'both callers see the same saved handoff time');
    const firstTimestamp = winner.body.renewal.handoff_at;

    // THE overlap proof (asserted, not timing-dependent): the entry count
    // captured BEFORE the first commit — and published only after the
    // COMMIT succeeded — is >= 2: request 2 entered the handoff handler
    // before the first successful commit.
    const entriesAtFirstCommit = Atomics.load(obs, 3);
    assert.ok(
      entriesAtFirstCommit >= 2,
      `both requests must have entered before the first commit (cell 3 = ${entriesAtFirstCommit})`
    );

    // Durable invariants: one transition, one event, the first valid
    // timestamp, no duplicate rows.
    assertOneHandoffDurable(env.dbPath, 'overlap', { firstTimestamp });
    // Full before/after durable diff: ONLY the expected transition and the
    // one handoff event are allowed; every other table (and the rest of the
    // renewal row) is byte-identical.
    const afterOverlap = fullTableState(env.dbPath);
    const colIndex = (dbPath, table) => {
      const db = initDatabase(dbPath);
      try {
        const names = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
        return Object.fromEntries(names.map((name, i) => [name, i]));
      } finally {
        db.close();
      }
    };
    const renewalColumns = colIndex(env.dbPath, 'renewals');
    const eventColumns = colIndex(env.dbPath, 'renewal_events');
    const beforeRow = beforeOverlap.renewals.find((r) => r[renewalColumns.id] === HANDOFF_CASE.id);
    const afterRow = afterOverlap.renewals.find((r) => r[renewalColumns.id] === HANDOFF_CASE.id);
    assert.ok(beforeRow, 'the rehearsal case row exists in the reference');
    assert.ok(afterRow, 'the rehearsal case row exists after the overlap');
    const rowDiff = Object.keys(renewalColumns)
      .map((name) => ({ name, before: beforeRow[renewalColumns[name]], after: afterRow[renewalColumns[name]] }))
      .filter((c) => !Object.is(c.before, c.after));
    assert.deepEqual(
      rowDiff.map((c) => c.name),
      ['status', 'next_actor', 'handoff_at', 'version'],
      'only the expected transition columns changed on the renewal row'
    );
    assert.equal(rowDiff.find((c) => c.name === 'version').after, 2, 'the version moved exactly 1 -> 2');
    // The unrelated renewal row set is unchanged — including the row
    // count: no rows added, removed, or mutated outside the expected
    // transition on the rehearsal case.
    const unrelatedBefore = beforeOverlap.renewals
      .filter((r) => r[renewalColumns.id] !== HANDOFF_CASE.id)
      .map((r) => JSON.stringify(r));
    const unrelatedAfter = afterOverlap.renewals
      .filter((r) => r[renewalColumns.id] !== HANDOFF_CASE.id)
      .map((r) => JSON.stringify(r)).sort();
    assert.equal(afterOverlap.renewals.length, beforeOverlap.renewals.length, 'renewals row count unchanged (no new or lost rows)');
    assert.equal(unrelatedAfter.length, unrelatedBefore.length, 'the unrelated renewal row set has the same size');
    const otherRenewalDiffs = afterOverlap.renewals
      .filter((r) => r[renewalColumns.id] !== HANDOFF_CASE.id)
      .filter((r) => {
        const before = beforeOverlap.renewals.find((b) => b[renewalColumns.id] === r[renewalColumns.id]);
        return !before || Object.keys(renewalColumns).some((name) => !Object.is(before[renewalColumns[name]], r[renewalColumns[name]]));
      });
    assert.equal(otherRenewalDiffs.length, 0, 'no other renewal row changed (the unrelated row set is byte-identical)');
    assert.equal(afterOverlap.renewal_events.length, beforeOverlap.renewal_events.length + 1, 'exactly one event row added (the handoff)');
    const beforeEventKeys = new Set(
      beforeOverlap.renewal_events.map((e) => JSON.stringify(e))
    );
    const [newEvent] = afterOverlap.renewal_events.filter((e) => !beforeEventKeys.has(JSON.stringify(e)));
    assert.ok(newEvent, 'the added event row exists');
    assert.equal(newEvent[eventColumns.renewal_id], HANDOFF_CASE.id, 'the event belongs to the rehearsal case');
    assert.equal(newEvent[eventColumns.event_type], 'handoff', 'the event is the handoff');
    assert.equal(newEvent[eventColumns.occurred_at], firstTimestamp, 'the event records the first valid handoff time');
    for (const table of Object.keys(beforeOverlap)) {
      if (table === 'renewals' || table === 'renewal_events') continue;
      assert.deepEqual(
        afterOverlap[table],
        beforeOverlap[table],
        `table ${table} unchanged by the overlap (status, next actor, timestamps, message history, decision timeline, refill count, sessions, identity and account rows)`
      );
    }

    // The loser's store result was the under-lock re-read replay (it
    // resolved with the committed state), regardless of which side
    // committed first.
    assert.equal(loser.body.created, false, 'the replay created nothing');
  } finally {
    await overlapWorker?.terminate();
    await appA?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: unrelated roles are denied without disclosure (scenario 3) — for the unrelated pharmacy, patient, and prescriber, direct read, copied-link read, and the Request renewal action are all denied (401/403 fixed bodies), no case data is exposed, and the durable state is byte-identical', async () => {
  const env = makeEnv('denials');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const dunmore = await signInClient(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const emil = await signInClient(base, 'dr.emil.hart', 'prescriber-emil-2026');
    // The case's OWN patient (Boris Laine — the relevant patient of the
    // rehearsal case): the preserved estate read semantics still authorize
    // the patient's own read, but the handoff ACTION is pharmacy-only and
    // must be denied. The UNRELATED patient in the fixture is Cleo Voss
    // (denial-patient), who is denied the read as well.
    const boris = await signInClient(base, 'boris.laine', 'patient-boris-2026');

    // Reference: the authorized pharmacy session (its session row is part
    // of the durable before-state) — and the case is still handable at the
    // end of this test.
    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(dunmore.identity.role, 'pharmacy');
    assert.equal(cleo.identity.role, 'patient');
    assert.equal(emil.identity.role, 'prescriber');

    const before = fullTableState(env.dbPath);
    assert.equal(before.renewals.length, 2, 'reference includes only the two fixture renewals');
    assert.equal(before.renewal_events.length, 0, 'reference has no events');

    // The UNRELATED identities: each is denied the direct read, the
    // copied-link read (both URL forms, JSON and HTML), and the Request
    // renewal action (JSON + native form), with fixed bodies and no case
    // data.
    const denialCopiedLinkPages = [];
    const denialTargets = [
      ['unrelated pharmacy', dunmore.cookieHeader],
      ['unrelated patient', cleo.cookieHeader],
      ['unrelated prescriber', emil.cookieHeader],
    ];

    for (const [label, cookieHeader] of denialTargets) {
      // 1) Direct read (literal id): 403 fixed denial, no case data.
      const direct = await httpJson(`${base}/cases?id=${HANDOFF_CASE.id}`, { headers: { Cookie: cookieHeader } });
      assert.equal(direct.status, 403, `${label}: direct read denied`);
      assert.equal(direct.body.ok, false, `${label}: denial flag`);
      assert.equal(direct.body.error, 'forbidden', `${label}: fixed error`);
      assertNoCaseFields(direct.body, `${label} direct read body`);

      // 2) Copied-link read (stable opaque ref, both URL forms): 403 fixed
      //    denial, no case data.
      const copied = await httpJson(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: cookieHeader } });
      assert.equal(copied.status, 403, `${label}: copied-link read denied`);
      assertNoCaseFields(copied.body, `${label} copied-link read body`);
      const copiedPath = await httpJson(`${base}/case/${HANDOFF_REF}`, { headers: { Cookie: cookieHeader } });
      assert.equal(copiedPath.status, 403, `${label}: copied-link path-form read denied`);
      assertNoCaseFields(copiedPath.body, `${label} copied-link path-form body`);

      // 2b) Copied-link read rendered as HTML (what the browser shows when
      //     the copied link is opened): each unrelated identity is denied
      //     the fixed, identity-free access-denied page with no case-data
      //     tokens — both URL forms.
      const copiedHtml = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: cookieHeader } });
      assert.equal(copiedHtml.status, 403, `${label}: copied-link HTML read denied`);
      assert.ok(copiedHtml.text.includes('<h1>Access denied</h1>'), `${label}: copied-link HTML is the fixed denial page`);
      assertNoCaseDataHtml(copiedHtml.text, `${label} copied-link HTML denial page`);
      assertNoScriptsOrHandlers(copiedHtml.text, `${label} copied-link HTML denial page`);
      const copiedPathHtml = await fetchHtml(`${base}/case/${HANDOFF_REF}`, { headers: { Cookie: cookieHeader } });
      assert.equal(copiedPathHtml.status, 403, `${label}: copied-link path-form HTML read denied`);
      assert.ok(copiedPathHtml.text.includes('<h1>Access denied</h1>'), `${label}: path-form copied-link HTML is the fixed denial page`);
      assertNoCaseDataHtml(copiedPathHtml.text, `${label} path-form copied-link HTML denial page`);
      assertNoScriptsOrHandlers(copiedPathHtml.text, `${label} path-form copied-link HTML denial page`);
      denialCopiedLinkPages.push(copiedHtml.text);

      // 3) The Request renewal action (JSON + native form): 403 fixed
      //    denial, no case data.
      const action = await httpJson(`${base}/handoff`, {
        method: 'POST',
        headers: { Cookie: cookieHeader },
        body: { case_ref: HANDOFF_REF },
      });
      assert.equal(action.status, 403, `${label}: handoff action denied`);
      assert.equal(action.body.ok, false, `${label}: handoff denial flag`);
      assert.equal(action.body.error, 'forbidden', `${label}: handoff fixed error`);
      assertNoCaseFields(action.body, `${label} handoff action body`);
      const actionForm = await httpForm(`${base}/handoff`, {
        headers: { Cookie: cookieHeader },
        form: { case_ref: HANDOFF_REF },
      });
      assert.equal(actionForm.status, 403, `${label}: handoff form action denied`);
      assert.ok(actionForm.text.includes('<h1>Access denied</h1>'), `${label}: HTML handoff denial is the fixed page`);
      assertNoCaseDataHtml(actionForm.text, `${label} handoff form denial page`);
      assertNoScriptsOrHandlers(actionForm.text, `${label} handoff form denial page`);
    }

    // No record-existence or per-identity disclosure: every unrelated
    // identity received the SAME fixed copied-link HTML denial page.
    assert.ok(denialCopiedLinkPages.length === 3, 'all three unrelated identities were denied the copied-link HTML read');
    assert.equal(
      denialCopiedLinkPages[1],
      denialCopiedLinkPages[0],
      'unrelated pharmacy and unrelated patient copied-link HTML denials are byte-identical'
    );
    assert.equal(
      denialCopiedLinkPages[2],
      denialCopiedLinkPages[0],
      'unrelated pharmacy and unrelated prescriber copied-link HTML denials are byte-identical'
    );

    // 4) Anonymous: 401 no-session on the action and the copied link
    //    (JSON + HTML), no case data.
    const anonAction = await httpJson(`${base}/handoff`, { method: 'POST', body: { case_ref: HANDOFF_REF } });
    assert.equal(anonAction.status, 401, 'anonymous handoff action: 401');
    assert.equal(anonAction.body.error, 'no-session');
    assertNoCaseFields(anonAction.body, 'anonymous handoff 401 body');
    const anonActionHtml = await httpForm(`${base}/handoff`, { form: { case_ref: HANDOFF_REF } });
    assert.equal(anonActionHtml.status, 401, 'anonymous handoff action: HTML 401');
    assert.ok(anonActionHtml.text.includes('No signed-in session is available; sign in first.'), 'anonymous handoff: the clear sign-in error');
    assertNoCaseDataHtml(anonActionHtml.text, 'anonymous handoff HTML 401 page');
    const anonLink = await httpJson(`${base}/cases?case=${HANDOFF_REF}`);
    assert.equal(anonLink.status, 401, 'anonymous copied link: 401');
    assertNoCaseFields(anonLink.body, 'anonymous copied-link 401 body');

    // 5) The handoff denials are fixed-shape, byte-identical across the
    //    unrelated roles, and carry no renewal value.
    const dunmoreAction = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: dunmore.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    const cleoAction = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    const emilAction = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: emil.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(
      JSON.stringify(dunmoreAction.body),
      JSON.stringify(cleoAction.body),
      'unrelated pharmacy and unrelated patient handoff denials are byte-identical'
    );
    assert.equal(
      JSON.stringify(dunmoreAction.body),
      JSON.stringify(emilAction.body),
      'unrelated pharmacy and unrelated prescriber handoff denials are byte-identical'
    );

    // 6) The case's OWN patient: the preserved estate read semantics still
    //    authorize the patient's own read (200, the saved state), but the
    //    handoff action is pharmacy-only and is denied without changing
    //    anything.
    const borisRead = await httpJson(`${base}/cases?id=${HANDOFF_CASE.id}`, { headers: { Cookie: boris.cookieHeader } });
    assert.equal(borisRead.status, 200, 'the case patient keeps the preserved own-case read');
    assert.equal(borisRead.body.case.id, HANDOFF_CASE.id, 'the own-case read returns the saved state');
    const borisAction = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: boris.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(borisAction.status, 403, 'the case patient cannot perform the handoff action');
    assertNoCaseFields(borisAction.body, 'case-patient handoff 403 body');

    // Durable evidence: EVERY table is byte-identical to the reference —
    // status, next actor, handoff event and timestamp, message history,
    // decision timeline, and refill count are all unchanged; no handoff
    // event was created by any denied attempt.
    const after = fullTableState(env.dbPath);
    assertStateUnchanged(after, before, 'denial section');
    const db = initDatabase(env.dbPath);
    try {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE event_type = 'handoff'`).get().n, 0, 'no handoff event from any denial');
      const row = db.prepare(`SELECT status, next_actor, handoff_at, version FROM renewals WHERE id = ?`).get(HANDOFF_CASE.id);
      assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
      assert.equal(row.next_actor, 'pharmacy', 'the next actor is unchanged');
      assert.equal(row.handoff_at, null, 'no handoff timestamp from any denial');
    } finally {
      db.close();
    }
    const rx = (() => {
      const db2 = initDatabase(env.dbPath);
      try {
        return db2.prepare(`SELECT refills_remaining FROM prescriptions WHERE id = 'ending-b-rx'`).get();
      } finally {
        db2.close();
      }
    })();
    assert.equal(rx.refills_remaining, 0, 'the refill count is unchanged');

    // The case is still handable by the responsible pharmacy afterwards
    // (the denials consumed nothing).
    const ok = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(ok.status, 200, 'the case is still handable after all denials');
    assert.equal(ok.body.code, 'handed-off');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: injected save failure (scenario 4) — 503 recoverable (JSON and HTML), every durable table unchanged, no partial handoff event, refresh shows Sent to pharmacy, and a later valid retry completes the handoff', async () => {
  const env = makeEnv('failed-save');
  let app;
  try {
    seedSecondPendingCase(env.dbPath);
    // One-shot seam armed: the NEXT POST /handoff exercises the real
    // UPDATE+INSERT, the real ROLLBACK, and the recoverable 503 — over
    // real HTTP (the seam is a test-only startServer option; product
    // startup via index.mjs never passes options).
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0, options: { handoffCommitFailure: true } });
    const base = `http://127.0.0.1:${app.port}`;
    const firstPort = app.port;

    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const before = fullTableState(env.dbPath);
    assert.equal(before.renewal_events.length, 0, 'no events before the failed save');

    // --- JSON 503: recoverable, fixed wording, no case data --------------
    const failed = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(failed.status, 503, 'failed save is a 503 over HTTP');
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, 'handoff-save-failed');
    assert.equal(failed.body.recoverable, true, 'the response is explicitly recoverable');
    assert.equal(
      failed.body.message,
      'Your request could not be saved. Nothing was changed; please try again.',
      'the existing recoverable wording, verbatim'
    );
    assertNoCaseFields(failed.body, 'failed-save JSON body');

    // Durable state: every table byte-identical; no partial transition and
    // no partial handoff event.
    const after = fullTableState(env.dbPath);
    assertStateUnchanged(after, before, 'failed save (JSON)');
    const row = durableCase(env.dbPath);
    assert.equal(row.row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(row.row.handoff_at, null, 'no partial handoff time');
    assert.equal(row.row.version, 1, 'no partial version movement');
    assert.equal(row.events.length, 0, 'no partial handoff event from the failed commit');

    // Refresh shows the previous saved state.
    const refresh = await httpJson(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.case.status, STATUS_LABELS.SENT_TO_PHARMACY, 'refresh shows the previous saved state');
    assert.equal(refresh.body.case.handoff_at, null);

    // Recovery on the SAME server: the one-shot seam is consumed, so the
    // later valid retry succeeds and creates exactly one handoff.
    const retry = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(retry.status, 200, 'the later valid retry after the 503 succeeds');
    assert.equal(retry.body.code, 'handed-off');
    assert.equal(retry.body.created, true);
    assertOneHandoffDurable(env.dbPath, 'failed-save recovery', { firstTimestamp: retry.body.renewal.handoff_at });
    await app.close();
    app = null;

    // --- HTML 503 (seam re-armed on a fresh server, on the SECOND -----
    // pending rehearsal case): the recoverable error renders as visible
    // text in a stable-id alert paragraph, with no case data.
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort, options: { handoffCommitFailure: true } });
    assert.equal(app.port, firstPort, 'the HTML failure check reuses the same port');
    const beforeHtml = fullTableState(env.dbPath);
    const htmlCase = (() => {
      const db = initDatabase(env.dbPath);
      try {
        return db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HTML_HANDOFF_CASE.id);
      } finally {
        db.close();
      }
    })();
    assert.equal(htmlCase.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the second rehearsal case is pending before the HTML failed save');
    const failedHtml = await httpForm(`${base}/handoff`, {
      headers: { Cookie: pharmacy.cookieHeader },
      form: { case_ref: HTML_HANDOFF_REF },
    });
    assert.equal(failedHtml.status, 503, 'failed save is a 503 for the HTML variant');
    assert.equal(failedHtml.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(failedHtml.text.includes('<h1>Your request could not be saved</h1>'), 'the HTML 503 renders the save-failure heading');
    assert.ok(!failedHtml.text.includes('Access denied'), 'the HTML 503 is not the access-denied page');
    assert.ok(
      failedHtml.text.includes(
        '<p id="handoff-save-error" class="error" role="alert" tabindex="-1">Your request could not be saved. Nothing was changed; please try again.</p>'
      ),
      'the HTML 503 renders the fixed recoverable message (no case data) with role="alert" in the stable-id error paragraph'
    );
    assertNoCaseDataHtml(failedHtml.text, 'failed-save HTML page');
    assertNoScriptsOrHandlers(failedHtml.text, 'failed-save HTML page');
    assertStateUnchanged(fullTableState(env.dbPath), beforeHtml, 'failed save (HTML)');
    const afterHtmlCase = (() => {
      const db = initDatabase(env.dbPath);
      try {
        const row = db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HTML_HANDOFF_CASE.id);
        const events = db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ?`).get(HTML_HANDOFF_CASE.id).n;
        return { row, events };
      } finally {
        db.close();
      }
    })();
    assert.equal(afterHtmlCase.events, 0, 'no partial handoff event from the HTML failed commit');
    assert.equal(afterHtmlCase.row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the second case remains Sent to pharmacy after the HTML 503');
    assert.equal(afterHtmlCase.row.version, 1, 'no partial version movement on the second case');
    // The HTML failed save must not have disturbed the earlier recovery
    // either: the first rehearsal case keeps exactly one handoff.
    assert.equal(durableCase(env.dbPath).events.length, 1, 'the first case still has exactly one handoff event');

    // And the following form handoff of the second case (seam consumed)
    // succeeds with a 303 — the later valid retry completes the handoff.
    const formRetry = await httpForm(`${base}/handoff`, {
      headers: { Cookie: pharmacy.cookieHeader },
      form: { case_ref: HTML_HANDOFF_REF },
    });
    assert.equal(formRetry.status, 303, 'the follow-up form handoff after the HTML 503 succeeds');
    assert.equal(formRetry.headers.get('location'), `/cases?case=${HTML_HANDOFF_REF}`, 'the 303 targets the second rehearsal case');
    const htmlRetryCase = (() => {
      const db = initDatabase(env.dbPath);
      try {
        const row = db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HTML_HANDOFF_CASE.id);
        const events = db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`).get(HTML_HANDOFF_CASE.id, 'handoff').n;
        return { row, events };
      } finally {
        db.close();
      }
    })();
    assert.equal(htmlRetryCase.row.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'the retry handoff commits the second case');
    assert.equal(htmlRetryCase.row.next_actor, 'prescriber');
    assert.equal(htmlRetryCase.events, 1, 'the retry created exactly one handoff event');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: saved-state access (scenario 5) — after success, the same-session refresh, sign-out + re-sign-in, server restart, and copied-link access (pharmacy and prescriber) each show Awaiting prescriber, the prescriber as next actor, the handoff time, and the applicable case data; no unrelated case data is exposed', async () => {
  const env = makeEnv('saved-state');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;
    const firstPort = app.port;

    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const created = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(created.status, 200, 'the committed handoff before the recovery checks');
    assert.equal(created.body.code, 'handed-off');
    const handoffTime = created.body.renewal.handoff_at;

    const savedState = {
      id: HANDOFF_CASE.id,
      status: STATUS_LABELS.AWAITING_PRESCRIBER,
      next_actor: 'prescriber',
      handoff_at: handoffTime,
      patient_name: 'Boris Laine',
      pharmacy_name: 'Cedar Crossing Pharmacy',
      prescriber_name: 'Dr. Priya Raman',
    };
    const caseLink = `${base}/cases?case=${HANDOFF_REF}`;

    const assertSavedState = (label, res) => {
      assert.equal(res.status, 200, `${label}: case detail status`);
      assert.equal(res.body.case.id, savedState.id, `${label}: the same case`);
      assert.equal(res.body.case.status, savedState.status, `${label}: Awaiting prescriber`);
      assert.equal(res.body.case.next_actor, savedState.next_actor, `${label}: the prescriber is the next actor`);
      assert.equal(res.body.case.handoff_at, savedState.handoff_at, `${label}: the saved handoff time`);
      assert.equal(res.body.case.patient_name, savedState.patient_name, `${label}: applicable case data (patient)`);
      assert.equal(res.body.case.prescriber_name, savedState.prescriber_name, `${label}: applicable case data (prescriber)`);
      // No unrelated case data: the other fixture case is not in the
      // response for either role.
      assert.ok(!JSON.stringify(res.body).includes('ending-a-renewal'), `${label}: no unrelated case data`);
    };

    // 1) Same-session refresh (JSON detail + HTML detail).
    assertSavedState('same-session refresh', await httpJson(caseLink, { headers: { Cookie: pharmacy.cookieHeader } }));
    const htmlRefresh = await fetchHtml(caseLink, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(htmlRefresh.status, 200);
    assert.ok(htmlRefresh.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'HTML refresh shows Awaiting prescriber');
    assert.ok(htmlRefresh.text.includes(handoffTime), 'HTML refresh shows the handoff time');
    assert.equal(handoffFormIn(htmlRefresh.text, 'HTML refresh'), null, 'no handoff form on the saved state');

    // 2) Sign-out + re-sign-in: an INDEPENDENT new session token; the
    //    invalidated old token is denied on the copied link (per-request
    //    reauthorization).
    const prescriber = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    assertSavedState('prescriber copied-link (pre-sign-out)', await httpJson(caseLink, { headers: { Cookie: prescriber.cookieHeader } }));
    await signOutClient(base, pharmacy.cookieHeader);
    const dead = await httpJson(caseLink, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(dead.status, 401, 'invalidated session denied on the copied link');
    assert.equal(dead.body.error, 'no-session');
    assertNoCaseFields(dead.body, 'invalidated-session denial body');
    const deadAction = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(deadAction.status, 401, 'invalidated session denied on the handoff action');
    const second = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.notEqual(second.token, pharmacy.token, 're-sign-in issues an independent session token');
    assertSavedState('re-sign-in', await httpJson(caseLink, { headers: { Cookie: second.cookieHeader } }));

    // 3) Server process restart against the same database file: the
    //    copied link reauthorizes from the durable session store.
    await app.close();
    app = null;
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort });
    assert.equal(app.port, firstPort, 'restart rebinds the same ephemeral port');
    assertSavedState('server restart (pharmacy)', await httpJson(caseLink, { headers: { Cookie: second.cookieHeader } }));
    assertSavedState('server restart (prescriber)', await httpJson(caseLink, { headers: { Cookie: prescriber.cookieHeader } }));
    const restartedHtml = await fetchHtml(caseLink, { headers: { Cookie: prescriber.cookieHeader } });
    assert.ok(restartedHtml.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'restart HTML shows Awaiting prescriber');
    assert.ok(restartedHtml.text.includes(handoffTime), 'restart HTML shows the handoff time');

    // The invalidated pre-restart token is still dead after the restart.
    const stillDead = await httpJson(caseLink, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(stillDead.status, 401, 'pre-restart invalidated token still denied');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: the native Request renewal form is gated and complete — present only for the responsible pharmacy on Sent to pharmacy cases; absent for other roles and other states; unknown case refs deny opaquely; invalid-state handoffs are fixed 422', async () => {
  const env = makeEnv('form-gating');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const prescriber = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    const patient = await signInClient(base, 'boris.laine', 'patient-boris-2026');

    // The responsible pharmacy on the 'Sent to pharmacy' case: form
    // present with the native wiring (no scripts, no inert buttons).
    const detail = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(detail.status, 200);
    const form = handoffFormIn(detail.text, 'pharmacy detail');
    assert.ok(form, 'the responsible pharmacy sees the Request renewal form');
    assert.equal(form.attrs.method, 'post');
    assert.equal(form.attrs.action, '/handoff');
    assert.equal(form.attrs['aria-label'], 'Request renewal');
    assertNoScriptsOrHandlers(detail.text, 'pharmacy detail page');
    assert.ok(!detail.text.includes('type="button"'), 'no inert type="button" control on the detail page');

    // The same case for the assigned prescriber and the patient: no form
    // (the action is pharmacy-only), and the saved state is readable.
    const prescDetail = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: prescriber.cookieHeader } });
    assert.equal(prescDetail.status, 200);
    assert.equal(handoffFormIn(prescDetail.text, 'prescriber detail'), null, 'the prescriber sees no handoff form');
    const patientDetail = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: patient.cookieHeader } });
    assert.equal(patientDetail.status, 200);
    assert.equal(handoffFormIn(patientDetail.text, 'patient detail'), null, 'the patient sees no handoff form');

    // After the handoff: the form is gone for the pharmacy too (the
    // durable state is authoritative; no second control can be presented).
    const first = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(first.status, 200, 'the handoff commits');
    const afterDetail = await fetchHtml(`${base}/cases?case=${HANDOFF_REF}`, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(handoffFormIn(afterDetail.text, 'detail after handoff'), null, 'the form disappears after the handoff');

    // Unknown case ref: the opaque fixed 403 denial (no existence
    // disclosure), JSON and HTML.
    const unknown = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: '0'.repeat(32) },
    });
    assert.equal(unknown.status, 403, 'unknown case ref is denied');
    assert.equal(unknown.body.error, 'forbidden');
    assertNoCaseFields(unknown.body, 'unknown-ref denial body');
    const unknownHtml = await httpForm(`${base}/handoff`, {
      headers: { Cookie: pharmacy.cookieHeader },
      form: { case_ref: '0'.repeat(32) },
    });
    assert.equal(unknownHtml.status, 403, 'unknown case ref: HTML 403');
    assertNoCaseDataHtml(unknownHtml.text, 'unknown-ref HTML denial page');

    // Invalid-state handoff (a saved final outcome): fixed 422, no event,
    // no change.
    const invalid = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: caseRefFor('ending-a-renewal') },
    });
    assert.equal(invalid.status, 422, 'a final case is a fixed 422');
    assert.equal(invalid.body.ok, false);
    assert.equal(invalid.body.error, 'invalid-case-state');
    assert.equal(invalid.body.message, 'This case can no longer be handed off.');
    assertNoCaseFields(invalid.body, 'invalid-state 422 body');
    const invalidHtml = await httpForm(`${base}/handoff`, {
      headers: { Cookie: pharmacy.cookieHeader },
      form: { case_ref: caseRefFor('ending-a-renewal') },
    });
    assert.equal(invalidHtml.status, 422, 'a final case: HTML 422');
    assert.ok(invalidHtml.text.includes('This case can no longer be handed off.'), 'HTML 422 renders the fixed message');
    assertNoCaseDataHtml(invalidHtml.text, 'invalid-state HTML 422 page');
    const db = initDatabase(env.dbPath);
    try {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = 'ending-a-renewal'`).get().n,
        0,
        'no event for the terminal case after the invalid-state handoff'
      );
    } finally {
      db.close();
    }
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: malformed observer — a 3-cell SAB (12 bytes) passed as the test-only overlap observer reaches the live server and is rejected with the fixed 500 BEFORE effects: no database write, no barrier effect, and the follow-up rejects identically with the durable state still unchanged', async () => {
  const env = makeEnv('malformed-observer');
  let app;
  try {
    // A 3-cell SAB could reach the server; it lacks the fourth protocol
    // cell (the store-owned precommit proof), so it is refused up front.
    const shortSab = new SharedArrayBuffer(12);
    const shortObs = new Int32Array(shortSab);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0, options: { handoffObserve: shortSab } });
    const base = `http://127.0.0.1:${app.port}`;
    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const before = fullTableState(env.dbPath);

    // JSON: fixed 500, no case data.
    const failed = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(failed.status, 500, 'the malformed observer is a fixed 500 over HTTP');
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, 'handoff-observer-malformed');
    assertNoCaseFields(failed.body, 'malformed-observer JSON body');

    // Native form: fixed 500 page, no case data.
    const failedForm = await httpForm(`${base}/handoff`, {
      headers: { Cookie: pharmacy.cookieHeader },
      form: { case_ref: HANDOFF_REF },
    });
    assert.equal(failedForm.status, 500, 'the malformed observer is a fixed 500 for the form variant');
    assertNoCaseDataHtml(failedForm.text, 'malformed-observer HTML page');

    // Proved before effects: every durable table byte-identical, no
    // barrier cell touched, and the case untouched.
    assertStateUnchanged(fullTableState(env.dbPath), before, 'malformed observer (HTTP)');
    assert.equal(shortObs[0], 0, 'no entry-count effect');
    assert.equal(shortObs[1], 0, 'no hold published');
    assert.equal(shortObs[2], 0, 'no release written');
    const row = durableCase(env.dbPath);
    assert.equal(row.row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(row.row.version, 1, 'no version movement');
    assert.equal(row.events.length, 0, 'no handoff event');

    // The same server keeps working: a follow-up request is rejected the
    // same fixed way (the observer is still malformed) and the state is
    // still unchanged — and no error path leaks case data.
    const failedAgain = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: pharmacy.cookieHeader },
      body: { case_ref: HANDOFF_REF },
    });
    assert.equal(failedAgain.status, 500, 'the follow-up is rejected the same fixed way');
    assert.equal(failedAgain.body.error, 'handoff-observer-malformed');
    assertStateUnchanged(fullTableState(env.dbPath), before, 'malformed observer (HTTP, follow-up)');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
