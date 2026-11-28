import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE_NAME,
  STATUS_LABELS,
  caseRefFor,
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
} from '../store.mjs';
import { startServer } from '../server.mjs';

// --- RFRLM-101 domain tests: the five handoff scenarios ---------------------
// Success; sequential replay (its own test); deterministic real overlap on a
// fresh case (bounded asynchronous rendezvous, release-in-finally, 10 s
// deadline); unauthorized denials; failed-save recovery; and authorized
// saved-state access. Every scenario seeds FRESH synthetic cases
// (overlap-rn / fail-rn / state-rn / success-rn) so no scenario mutates
// another scenario's record; assertions are made on fresh short-lived
// connections (estate convention, cf. test/ask.http.test.mjs).

// --- fresh synthetic cases --------------------------------------------------

// Overlap + sequential-replay target: fresh zero-refill case, pharmacy-cedar,
// prescriber ending-b-prescriber, Sent to pharmacy, version 1.
const OVERLAP_RX = Object.freeze({
  id: 'http-handoff-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});
const OVERLAP_RN = 'http-handoff-rn';

// Failed-save target: same assignments, independent case.
const FAIL_RX = Object.freeze({
  id: 'http-handoff-fail-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});
const FAIL_RN = 'http-handoff-fail-rn';

// HTML failed-save phase target (second fresh case: the seam fires on the
// first-handoff path, so the HTML 503 check needs its own pre-handoff case).
const FAIL_HTML_RX = Object.freeze({
  id: 'http-handoff-fail-rx-2',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});
const FAIL_HTML_RN = 'http-handoff-fail-rn-2';

// Success target: fresh zero-refill case so the success scenario also
// exercises a fresh synthetic case (precondition of the acceptance story).
const SUCCESS_RX = Object.freeze({
  id: 'http-handoff-success-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});
const SUCCESS_RN = 'http-handoff-success-rn';

// Saved-state target: the case whose committed handoff the authorized
// refresh / re-sign-in / copied-link section reads back.
const STATE_RX = Object.freeze({
  id: 'http-handoff-state-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});
const STATE_RN = 'http-handoff-state-rn';

function seedFreshHandoffCase(dbPath, rx, rnId, submittedAt) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(rx.id, rx.patient_id, rx.pharmacy_id, rx.prescriber_id);
    db.prepare(
      `INSERT INTO renewals
         (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
          status, next_actor, submitted_at, handoff_at, decided_at, granted_refills, version)
       VALUES (?, ?, ?, ?, ?, ?, 'pharmacy', ?, NULL, NULL, NULL, 1)`
    ).run(rnId, rx.id, rx.patient_id, rx.pharmacy_id, rx.prescriber_id,
      STATUS_LABELS.SENT_TO_PHARMACY, submittedAt);
  } finally {
    db.close();
  }
}

// --- helpers (estate conventions, mirroring test/ask.http.test.mjs) ---------

// One fresh disposable database per test: unique temp dir, schema, fixture
// set, and local synthetic accounts (so real HTTP sign-in works).
function makeEnv(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-fixture-handoff-${tag}-`));
  const dbPath = join(dir, `handoff-${tag}.sqlite`);
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
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

// The saved renewal row by id (fresh connection) — the authoritative
// durable state the responses must reflect.
function renewalRow(dbPath, rnId) {
  const db = initDatabase(dbPath);
  try {
    return db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(rnId);
  } finally {
    db.close();
  }
}

function handoffEvents(dbPath, rnId) {
  const db = initDatabase(dbPath);
  try {
    return db
      .prepare(
        `SELECT * FROM renewal_events WHERE renewal_id = ? AND event_type = 'handoff' ORDER BY id`
      )
      .all(rnId);
  } finally {
    db.close();
  }
}

function handoffEventCount(dbPath, rnId) {
  const db = initDatabase(dbPath);
  try {
    return db
      .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = 'handoff'`)
      .get(rnId).n;
  } finally {
    db.close();
  }
}

function refillsRemaining(dbPath, prescriptionId) {
  const db = initDatabase(dbPath);
  try {
    return db.prepare(`SELECT refills_remaining FROM prescriptions WHERE id = ?`).get(prescriptionId)
      .refills_remaining;
  } finally {
    db.close();
  }
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

// Exactly one renewal row (the scenario's case) differs between the two
// full-table snapshots; every other row of that table and every other
// non-skipped table are byte-identical. renewal_events may hold exactly
// ONE appended row (the scenario's single handoff event, the largest
// autoincrement id, last in the id-ordered snapshot); every other event
// row must be unchanged.
function assertOnlyRowChanged(after, before, rnId, label, { skipTables = [] } = {}) {
  const changedIdx = [];
  for (let i = 0; i < before.renewals.length; i += 1) {
    if (JSON.stringify(before.renewals[i]) !== JSON.stringify(after.renewals[i])) changedIdx.push(i);
  }
  assert.equal(changedIdx.length, 1, `${label}: exactly one renewal row changed`);
  assert.equal(after.renewals[changedIdx[0]][0], rnId, `${label}: the changed renewal row is the scenario case`);
  assert.equal(after.renewal_events.length, before.renewal_events.length + 1, `${label}: exactly one event row appended`);
  const appended = after.renewal_events[after.renewal_events.length - 1];
  assert.equal(appended[1], rnId, `${label}: the appended event belongs to the scenario case`);
  assert.equal(appended[2], 'handoff', `${label}: the appended event is the handoff event`);
  for (const table of Object.keys(before)) {
    if (table === 'renewals') continue;
    if (table === 'renewal_events') {
      assert.deepEqual(
        after.renewal_events.slice(0, -1),
        before.renewal_events,
        `${label}: durable table ${table} unchanged apart from the single appended event`
      );
      continue;
    }
    if (skipTables.includes(table)) continue;
    assert.deepEqual(after[table], before[table], `${label}: durable table ${table} unchanged`);
  }
}

// Case-data disclosure tokens: any fixture or scenario value appearing in a
// denial or error response body means case data was disclosed (estate
// convention). The handoff timestamps are dynamic per run (wall-clock at
// commit), so they cannot be static tokens; the no-disclosure property is
// carried by the full token list plus the byte-identical fixed-denial
// checks (a denial body that leaked a dynamic timestamp would differ
// across identities and fail the byte-identity assertions).
const CASE_DATA_TOKENS = [
  'ending-a-renewal', 'ending-b-renewal',
  'ending-a-rx', 'ending-b-rx', 'denial-rx',
  OVERLAP_RX.id, OVERLAP_RN,
  FAIL_RX.id, FAIL_RN,
  FAIL_HTML_RX.id, FAIL_HTML_RN,
  SUCCESS_RX.id, SUCCESS_RN,
  STATE_RX.id, STATE_RN,
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
  '2026-11-20T09:00:00Z', '2026-11-19T14:30:00Z',
  '2026-11-18T10:15:00Z', '2026-11-17T08:45:00Z',
  '2026-11-16T16:20:00Z', '2026-11-16T17:05:00Z',
  '2026-11-15T12:05:00Z',
];

function assertNoCaseFields(body, label, { extraTokens = [] } = {}) {
  const serialized = JSON.stringify(body);
  for (const token of [...CASE_DATA_TOKENS, ...extraTokens]) {
    assert.ok(
      !serialized.includes(token),
      `${label}: response must contain no case fields (found ${JSON.stringify(token)})`
    );
  }
}

function assertNoCaseDataHtml(html, label, { extraTokens = [] } = {}) {
  for (const token of [...CASE_DATA_TOKENS, ...extraTokens]) {
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

// --- test-only bounded asynchronous rendezvous (accepted plan §3.3.1) -------
// Each arriving request signals its own arrival and awaits one shared
// promise; the event loop stays free while awaiting (no DB call and no
// write transaction open), so a second overlapping request can also reach
// the rendezvous. Bounded by a 10 s deadline: on expiry the shared promise
// REJECTS with a clear error, so both handlers fail fast instead of the
// test hanging. release() is always called in a finally (even when the
// test's pre-release state check throws): it clears the deadline and
// RESOLVES the shared promise, so both requests proceed into the real,
// unmodified synchronous store transaction and the test fails on its own
// assertions. No prototype patches, no worker threads, no synchronous
// waits anywhere in the test's critical path.
function createRendezvous({ expected = 2, deadlineMs = 10_000 } = {}) {
  const arrivals = [];
  let released = false;
  let releaseTimer = null;
  let resolveShared;
  let rejectShared;
  const wait = new Promise((resolve, reject) => {
    resolveShared = resolve;
    rejectShared = reject;
    releaseTimer = setTimeout(() => {
      if (!released) {
        released = true;
        rejectShared(new Error(
          `handoff arrival rendezvous: expected ${expected} arrivals, observed ${arrivals.length} within ${deadlineMs} ms`
        ));
      }
    }, deadlineMs);
    // The deadline timer must never keep the test process alive on its own.
    releaseTimer.unref?.();
  });
  return {
    arrivals,
    // The promise each arriving handler request awaits.
    wait,
    // Bounded poll for the expected number of arrivals: resolves as soon as
    // all expected requests have arrived, rejects with the deadline error
    // if the deadline fires first (fail fast, never hang).
    waitForArrivals: async () => {
      while (arrivals.length < expected) {
        // If the deadline fires first, `wait` rejects and this await
        // propagates the fail-fast error (the test never hangs).
        await Promise.race([wait, new Promise((r) => setTimeout(r, 20))]);
      }
    },
    // Release BOTH requests: called in a finally. Idempotent.
    release() {
      if (released) return;
      released = true;
      clearTimeout(releaseTimer);
      releaseTimer = null;
      resolveShared();
    },
  };
}

// --- 1. Successful handoff ---------------------------------------------------

test('over-HTTP: successful pharmacy handoff — same renewal durably Awaiting prescriber, prescriber is next actor, exactly one handoff event at the recorded time, single version increment, zero refills unchanged, prescriber and pharmacy read the saved state', async () => {
  const env = makeEnv('success');
  let app;
  try {
    seedFreshHandoffCase(env.dbPath, SUCCESS_RX, SUCCESS_RN, '2026-11-20T09:00:00Z');
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const priya = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    assert.equal(cedar.identity.role, 'pharmacy');

    // FR-001 precondition on the fresh synthetic case (pre-state evidence).
    const pre = renewalRow(env.dbPath, SUCCESS_RN);
    assert.equal(pre.status, STATUS_LABELS.SENT_TO_PHARMACY, 'precondition: fresh case is Sent to pharmacy');
    assert.equal(pre.pharmacy_id, 'pharmacy-cedar', 'precondition: assigned to the acting pharmacy');
    assert.equal(pre.prescriber_id, 'ending-b-prescriber', 'precondition: prescriber assigned');
    assert.equal(pre.version, 1, 'precondition: original version 1');
    assert.equal(pre.handoff_at, null, 'precondition: no handoff time yet');
    assert.equal(handoffEventCount(env.dbPath, SUCCESS_RN), 0, 'precondition: no handoff event yet');
    assert.equal(refillsRemaining(env.dbPath, SUCCESS_RX.id), 0, 'precondition: zero refills');

    const before = fullTableState(env.dbPath);

    const startedAt = Date.now();
    const res = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: caseRefFor(SUCCESS_RN) },
    });
    const durationMs = Date.now() - startedAt;
    // Measurement-only evidence input for RFRLM-NFR-001 (no target asserted).
    console.log(`[measurement] successful handoff request duration: ${durationMs} ms`);
    assert.ok(Number.isFinite(durationMs) && durationMs >= 0, 'handoff duration measured');

    assert.equal(res.status, 200, 'first handoff is a 200 (mutation of an existing renewal, not 201)');
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ['code', 'handed_off', 'ok', 'renewal'],
      'handoff response carries exactly the planned top-level fields'
    );
    assert.deepEqual(
      Object.keys(res.body.renewal).sort(),
      ['handoff_at', 'id', 'next_actor', 'status'],
      'handoff renewal carries the planned fields (no more)'
    );
    assert.equal(res.body.ok, true);
    assert.equal(res.body.code, 'handed-off');
    assert.equal(res.body.handed_off, true);
    assert.equal(res.body.renewal.id, SUCCESS_RN, 'the SAME renewal is returned (no new record)');
    assert.equal(res.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(res.body.renewal.next_actor, 'prescriber');
    const handoffAt = res.body.renewal.handoff_at;
    assert.ok(typeof handoffAt === 'string' && handoffAt.length > 0, 'handoff time recorded');
    assert.match(handoffAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'handoff time is ISO-8601 UTC');
    assert.ok(!Number.isNaN(Date.parse(handoffAt)), 'handoff time parses');

    // Durable state: the same row moved; version incremented by exactly one.
    const row = renewalRow(env.dbPath, SUCCESS_RN);
    assert.equal(row.id, SUCCESS_RN, 'the same renewal id is durably saved');
    assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'durable status is Awaiting prescriber');
    assert.equal(row.next_actor, 'prescriber', 'durable next actor is the prescriber');
    assert.equal(row.handoff_at, handoffAt, 'durable handoff time equals the response value');
    assert.equal(row.version, pre.version + 1, 'version incremented by exactly one (1 -> 2)');
    assert.equal(row.submitted_at, '2026-11-20T09:00:00Z', 'original submission time preserved');
    assert.equal(row.prescriber_id, 'ending-b-prescriber', 'prescriber assignment preserved');
    assert.equal(row.pharmacy_id, 'pharmacy-cedar', 'pharmacy assignment preserved');
    assert.equal(row.decided_at, null, 'no decision recorded by the handoff');
    assert.equal(row.granted_refills, null, 'no refill count granted by the handoff');
    assert.equal(refillsRemaining(env.dbPath, SUCCESS_RX.id), 0, 'refills_remaining still 0 (handoff grants no refills)');

    // Exactly ONE handoff event; it records the acting pharmacy and the
    // SAME handoff time.
    const events = handoffEvents(env.dbPath, SUCCESS_RN);
    assert.equal(events.length, 1, 'exactly one handoff event records the handoff');
    assert.equal(events[0].renewal_id, SUCCESS_RN);
    assert.equal(events[0].event_type, 'handoff');
    assert.equal(events[0].actor_role, 'pharmacy', 'event actor is the acting pharmacy role');
    assert.equal(events[0].actor_id, 'pharmacy-cedar', 'event actor is the acting pharmacy identity');
    assert.equal(events[0].occurred_at, handoffAt, 'event occurred_at equals the handoff time');

    // Full-table delta: exactly the one renewal-row update; nothing else.
    const after = fullTableState(env.dbPath);
    assertOnlyRowChanged(after, before, SUCCESS_RN, 'successful handoff');
    assert.equal(after.renewal_events.length, before.renewal_events.length + 1, 'exactly one event row added');

    // The assigned prescriber reads the same case: queue listing + copied
    // link, both 200 with the identical durable state.
    const queue = await httpJson(`${base}/cases`, { headers: { Cookie: priya.cookieHeader } });
    assert.equal(queue.status, 200, 'prescriber queue status');
    const queued = queue.body.cases.find((c) => c.id === SUCCESS_RN);
    assert.ok(queued, 'the handoff case appears in the prescriber queue');
    assert.equal(queued.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'queue status matches the durable state');
    assert.equal(queued.handoff_at, handoffAt, 'queue handoff time matches the durable state');
    const prescriberDetail = await httpJson(`${base}/cases?case=${caseRefFor(SUCCESS_RN)}`, {
      headers: { Cookie: priya.cookieHeader },
    });
    assert.equal(prescriberDetail.status, 200, 'prescriber copied-link read is authorized');
    assert.equal(prescriberDetail.body.case.id, SUCCESS_RN, 'prescriber reads the same renewal');
    assert.equal(prescriberDetail.body.case.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(prescriberDetail.body.case.next_actor, 'prescriber');
    assert.equal(prescriberDetail.body.case.handoff_at, handoffAt);

    // The pharmacy refresh shows the saved state, and the saved page carries
    // the handoff time, the prescriber next actor, and NO handoff form (the
    // status is no longer Sent to pharmacy).
    const refresh = await httpJson(`${base}/cases?case=${caseRefFor(SUCCESS_RN)}`, {
      headers: { Cookie: cedar.cookieHeader },
    });
    assert.equal(refresh.status, 200, 'pharmacy refresh status');
    assert.equal(refresh.body.case.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'refresh shows the saved status');
    assert.equal(refresh.body.case.handoff_at, handoffAt, 'refresh shows the saved handoff time');
    const refreshHtml = await fetchHtml(`${base}/cases?case=${caseRefFor(SUCCESS_RN)}`, {
      headers: { Cookie: cedar.cookieHeader },
    });
    assert.equal(refreshHtml.status, 200, 'pharmacy refresh HTML status');
    assert.ok(refreshHtml.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'HTML shows the saved status');
    assert.ok(refreshHtml.text.includes(`<dd>${handoffAt}</dd>`), 'HTML shows the saved handoff time');
    assert.equal((refreshHtml.text.match(/<form[^>]*action="\/handoff"/g) ?? []).length, 0,
      'the saved state page carries no Request renewal form');
    assertNoScriptsOrHandlers(refreshHtml.text, 'success refresh HTML page');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// --- 2a. Sequential replay — its own test (accepted plan §6.2a) -------------

test('over-HTTP: sequential replay after success — 200 already-handed-off with the ORIGINAL handoff time, same version, exactly one event, full table unchanged, and the HTML replay 303s to the stable case ref (no handoff form on the saved page)', async () => {
  const env = makeEnv('replay');
  let app;
  try {
    seedFreshHandoffCase(env.dbPath, OVERLAP_RX, OVERLAP_RN, '2026-11-19T14:30:00Z');
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const before = fullTableState(env.dbPath);
    const pre = renewalRow(env.dbPath, OVERLAP_RN);
    assert.equal(pre.status, STATUS_LABELS.SENT_TO_PHARMACY, 'precondition: fresh case is Sent to pharmacy');
    assert.equal(pre.version, 1, 'precondition: original version 1');

    // First, a SEQUENTIAL handoff (the scenario under test is the replay
    // that follows it, on the same session, strictly after the first
    // request has completed).
    const first = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: caseRefFor(OVERLAP_RN) },
    });
    assert.equal(first.status, 200, 'first sequential handoff is a 200');
    assert.equal(first.body.code, 'handed-off');
    assert.equal(first.body.handed_off, true);
    assert.equal(first.body.renewal.id, OVERLAP_RN, 'first handoff returns the same renewal');
    assert.equal(first.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(first.body.renewal.next_actor, 'prescriber');
    const firstHandoffAt = first.body.renewal.handoff_at;
    assert.ok(typeof firstHandoffAt === 'string' && firstHandoffAt.length > 0, 'first handoff time recorded');
    const firstVersion = renewalRow(env.dbPath, OVERLAP_RN).version;
    assert.equal(firstVersion, pre.version + 1, 'first handoff bumped the version by exactly one');

    // The SEQUENTIAL replay: same session, strictly after the first
    // request completed.
    const replay = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: caseRefFor(OVERLAP_RN) },
    });
    assert.equal(replay.status, 200, 'sequential replay is a 200');
    assert.equal(replay.body.ok, true, 'replay is a successful outcome');
    assert.equal(replay.body.code, 'already-handed-off', 'replay is idempotent, not a second handoff');
    assert.equal(replay.body.handed_off, true);
    assert.equal(replay.body.renewal.id, OVERLAP_RN, 'replay returns the same renewal');
    assert.equal(replay.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'replay returns the saved status');
    assert.equal(replay.body.renewal.next_actor, 'prescriber', 'replay returns the saved next actor');
    assert.equal(replay.body.renewal.handoff_at, firstHandoffAt,
      'replay preserves the ORIGINAL first valid handoff timestamp');

    // Durable: same version (no second increment), exactly one event whose
    // occurred_at equals the original handoff time; nothing else moved.
    const row = renewalRow(env.dbPath, OVERLAP_RN);
    assert.equal(row.version, firstVersion, 'replay made no second version increment');
    assert.equal(row.handoff_at, firstHandoffAt, 'durable handoff time is the original one');
    const events = handoffEvents(env.dbPath, OVERLAP_RN);
    assert.equal(events.length, 1, 'still exactly one handoff event after the replay');
    assert.equal(events[0].occurred_at, firstHandoffAt, 'the single event records the original handoff time');
    const afterReplay = fullTableState(env.dbPath);
    assertOnlyRowChanged(afterReplay, before, OVERLAP_RN, 'sequential replay');
    assert.equal(afterReplay.renewal_events.length, before.renewal_events.length + 1, 'replay added no second event row');

    // HTML variant of the replay: 303 to the stable case ref (no body, no
    // record data in the redirect); the saved page shows the state and NO
    // handoff form.
    const formReplay = await httpForm(`${base}/handoff`, {
      headers: { Cookie: cedar.cookieHeader },
      form: { case_ref: caseRefFor(OVERLAP_RN) },
    });
    assert.equal(formReplay.status, 303, 'HTML replay is a 303');
    assert.equal(formReplay.headers.get('location'), `/cases?case=${caseRefFor(OVERLAP_RN)}`,
      '303 targets the stable opaque case ref');
    assert.equal(formReplay.text, '', '303 carries no body');
    assertStateUnchanged(fullTableState(env.dbPath), afterReplay, 'HTML replay');

    const detail = await fetchHtml(`${base}/cases?case=${caseRefFor(OVERLAP_RN)}`, {
      headers: { Cookie: cedar.cookieHeader },
    });
    assert.equal(detail.status, 200, 'case detail resolves after the replay 303');
    assert.ok(detail.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'detail shows the saved status');
    assert.ok(detail.text.includes(`<dd>${firstHandoffAt}</dd>`), 'detail shows the saved handoff time');
    assert.equal((detail.text.match(/<form[^>]*action="\/handoff"/g) ?? []).length, 0,
      'saved-state page carries no Request renewal form');
    assertNoScriptsOrHandlers(detail.text, 'replay saved-state HTML page');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// --- 2b. Real overlap — deterministic, bounded, release-in-finally ----------

test('over-HTTP: two overlapping POST /handoff requests on a fresh case (both observed in the handoff path before the first write) leave exactly one transition, one event, one version increment, and the winning timestamp preserved on replay', async () => {
  const env = makeEnv('overlap');
  let app;
  // The bounded asynchronous rendezvous (10 s deadline) armed on a
  // dedicated server instance below; the test controls it exclusively.
  const rendezvous = createRendezvous({ expected: 2, deadlineMs: 10_000 });
  try {
    seedFreshHandoffCase(env.dbPath, OVERLAP_RX, OVERLAP_RN, '2026-11-18T10:15:00Z');
    app = await startServer({
      dbPath: env.dbPath,
      host: '127.0.0.1',
      port: 0,
      // Test-only option (off by default): fires once per POST /handoff
      // request AFTER normal request parsing/authorization checks have
      // passed and immediately BEFORE the synchronous store call.
      options: {
        handoffArrivalRendezvous: (record) => {
          rendezvous.arrivals.push(record);
          return rendezvous.wait;
        },
      },
    });
    const base = `http://127.0.0.1:${app.port}`;

    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(cedar.identity.role, 'pharmacy');
    const before = fullTableState(env.dbPath);
    const pre = renewalRow(env.dbPath, OVERLAP_RN);
    assert.equal(pre.status, STATUS_LABELS.SENT_TO_PHARMACY, 'precondition: fresh case is Sent to pharmacy');
    assert.equal(pre.version, 1, 'precondition: original version 1');
    assert.equal(pre.handoff_at, null, 'precondition: no handoff time yet');
    assert.equal(handoffEventCount(env.dbPath, OVERLAP_RN), 0, 'precondition: no handoff event yet');

    // Fire BOTH requests at once over real loopback HTTP (same session,
    // JSON). Each handler passes session/role/body parsing, reaches the
    // armed test-only rendezvous, signals its arrival, and awaits the
    // shared release — with no DB call and no write transaction open. The
    // in-flight promises are NOT awaited yet: while the shared promise is
    // unsettled both handlers are parked, so the main thread can
    // deterministically observe the state below and then release.
    const reqA = httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: caseRefFor(OVERLAP_RN) },
    });
    const reqB = httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: caseRefFor(OVERLAP_RN) },
    });
    const parked = Promise.all([reqA, reqB]).catch((err) => {
      // If the test fails BEFORE the release and the finally closes the
      // app, the in-flight requests are aborted; absorb that transport
      // rejection so it never surfaces as an unrelated unhandled rejection
      // (the test's own thrown assertion remains the failure of record).
      if (err && err.name === 'AbortError') return [undefined, undefined];
      throw err;
    });

    // Deterministic server-side observation: BOTH requests are inside the
    // handoff path (past normal request parsing/authorization checks,
    // immediately before the synchronous store call) before the first
    // commit can proceed.
    await rendezvous.waitForArrivals();
    assert.equal(rendezvous.arrivals.length, 2, 'both overlapping requests reached the handoff path');
    for (const [label, record] of [['A', rendezvous.arrivals[0]], ['B', rendezvous.arrivals[1]]]) {
      assert.equal(record.caseRef, caseRefFor(OVERLAP_RN), `request ${label} carried the case ref of the fresh case`);
      assert.equal(record.wantsHtml, false, `request ${label} is the JSON variant`);
    }

    // The two requests are parked at the rendezvous with the shared promise
    // still unsettled, and the in-flight response promises are not yet
    // awaited. The pre-release state checks live under a finally that
    // releases BOTH requests — even if a check throws, release() runs, so
    // both handlers proceed into the real store transaction (bounded
    // failure/cleanup, never a hang).
    //
    // At this instant the first commit CANNOT have proceeded: on a fresh
    // connection the case still shows its ORIGINAL status and version,
    // and no handoff event exists (no write before the first write).
    try {
      const held = renewalRow(env.dbPath, OVERLAP_RN);
      assert.equal(held.status, STATUS_LABELS.SENT_TO_PHARMACY,
        'while both requests are in the handoff path, the case is still Sent to pharmacy');
      assert.equal(held.version, pre.version, 'while both requests are in the handoff path, the original version is unchanged');
      assert.equal(held.handoff_at, null, 'while both requests are in the handoff path, no handoff time has been written');
      assert.equal(handoffEventCount(env.dbPath, OVERLAP_RN), 0,
        'while both requests are in the handoff path, no handoff event exists (no write before the first write)');
    } finally {
      // Release BOTH requests (in finally, per the accepted plan): they
      // now proceed into the real, unmodified synchronous transaction,
      // where BEGIN IMMEDIATE serializes them (winner: UPDATE + INSERT +
      // COMMIT; loser: re-read the committed winner and roll back).
      rendezvous.release();
    }

    // Only after the release completes are the response promises awaited —
    // the store's bounded lock-retry budget (worst case 10 × 5 ms) bounds
    // any residual contention.
    const [resA, resB] = await parked;
    try {
      const results = [resA, resB];
      for (const [label, res] of [['A', resA], ['B', resB]]) {
        assert.equal(res.status, 200, `request ${label} status (got ${res.status}: ${res.raw})`);
        assert.equal(res.body.renewal.id, OVERLAP_RN, `request ${label} resolved to the same renewal`);
      }
      const codes = results.map((r) => r.body.code).sort();
      assert.deepEqual(codes, ['already-handed-off', 'handed-off'],
        'one request wins (handed-off), the other is the idempotent replay (already-handed-off)');
      const winner = results.find((r) => r.body.code === 'handed-off');
      const loser = results.find((r) => r.body.code === 'already-handed-off');
      assert.equal(winner.body.ok, true);
      assert.equal(winner.body.handed_off, true);
      assert.equal(loser.body.ok, true);
      assert.equal(loser.body.handed_off, true);
      assert.equal(loser.body.renewal.id, winner.body.renewal.id, 'both responses name the same renewal');
      const winningHandoffAt = winner.body.renewal.handoff_at;
      assert.ok(typeof winningHandoffAt === 'string' && winningHandoffAt.length > 0, 'winner recorded a handoff time');
      assert.match(winningHandoffAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'winning handoff time is ISO-8601 UTC');
      assert.equal(winner.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'winner status');
      assert.equal(winner.body.renewal.next_actor, 'prescriber', 'winner next actor');
      assert.equal(loser.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'loser sees the winner status');
      assert.equal(loser.body.renewal.handoff_at, winningHandoffAt,
        'the loser response carries the WINNER handoff time (replay semantics)');

      // Single version increment: exactly original + 1 — the loser made no
      // second increment.
      const row = renewalRow(env.dbPath, OVERLAP_RN);
      assert.equal(row.id, OVERLAP_RN, 'the same renewal row is the durable record');
      assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'durable status is Awaiting prescriber');
      assert.equal(row.next_actor, 'prescriber', 'durable next actor is the prescriber');
      assert.equal(row.version, pre.version + 1, 'SINGLE version increment (1 -> 2), no second increment from the loser');
      assert.equal(row.handoff_at, winningHandoffAt, 'durable handoff time is the winner timestamp');

      // One event: exactly one handoff event, with the winning timestamp
      // and the acting pharmacy as actor.
      const events = handoffEvents(env.dbPath, OVERLAP_RN);
      assert.equal(events.length, 1, 'exactly ONE handoff event after the overlapping requests');
      assert.equal(events[0].occurred_at, winningHandoffAt, 'the single event records the winning timestamp');
      assert.equal(events[0].actor_role, 'pharmacy', 'event actor role');
      assert.equal(events[0].actor_id, 'pharmacy-cedar', 'event actor is the acting pharmacy');

      // Winning timestamp preserved on a follow-up SEQUENTIAL replay: same
      // timestamp, zero new rows.
      const replay = await httpJson(`${base}/handoff`, {
        method: 'POST',
        headers: { Cookie: cedar.cookieHeader },
        body: { case_ref: caseRefFor(OVERLAP_RN) },
      });
      assert.equal(replay.status, 200, 'post-overlap sequential replay is a 200');
      assert.equal(replay.body.code, 'already-handed-off', 'post-overlap replay is idempotent');
      assert.equal(replay.body.renewal.handoff_at, winningHandoffAt,
        'the follow-up replay preserves the original winning handoff timestamp');
      assert.equal(replay.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'post-overlap replay status');
      assert.equal(renewalRow(env.dbPath, OVERLAP_RN).version, row.version,
        'the follow-up replay made no further version increment');

      // Durable full-table diff: exactly one renewal-row update + one new
      // event row; every other table byte-identical (no duplicate case,
      // event, or history rows).
      const after = fullTableState(env.dbPath);
      assertOnlyRowChanged(after, before, OVERLAP_RN, 'overlapping requests');
      assert.equal(after.renewal_events.length, before.renewal_events.length + 1, 'exactly one event row added');
      assert.equal(after.renewals.length, before.renewals.length, 'no duplicate renewal rows');
    } finally {
      rendezvous.release();
    }
  } finally {
    rendezvous.release();
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// --- 3. Unauthorized access denial ------------------------------------------

test('over-HTTP: the unrelated pharmacy, the unrelated patient, and the unrelated prescriber are each denied the direct read, the copied-link read, and Request renewal (fixed bodies byte-identical, no case data), the denial section leaves every durable table unchanged, and the authorized owner is unaffected', async () => {
  const env = makeEnv('denials');
  let app;
  try {
    seedFreshHandoffCase(env.dbPath, OVERLAP_RX, OVERLAP_RN, '2026-11-17T08:45:00Z');
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;
    const ref = caseRefFor(OVERLAP_RN);

    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const dunmore = await signInClient(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const emil = await signInClient(base, 'dr.emil.hart', 'prescriber-emil-2026');
    assert.equal(dunmore.identity.role, 'pharmacy', 'unrelated pharmacy role');
    assert.equal(cleo.identity.role, 'patient', 'unrelated patient role');
    assert.equal(emil.identity.role, 'prescriber', 'unrelated prescriber role');

    const before = fullTableState(env.dbPath);
    const pre = renewalRow(env.dbPath, OVERLAP_RN);
    assert.equal(pre.status, STATUS_LABELS.SENT_TO_PHARMACY, 'precondition: fresh case is Sent to pharmacy');
    assert.equal(pre.version, 1, 'precondition: original version 1');

    const denied = [];
    for (const [label, client] of [
      ['unrelated pharmacy', dunmore],
      ['unrelated patient', cleo],
      ['unrelated prescriber', emil],
    ]) {
      // 1) Direct read (by literal id) — fixed 403, opaque.
      const direct = await httpJson(`${base}/cases?id=${OVERLAP_RN}`, {
        headers: { Cookie: client.cookieHeader },
      });
      assert.equal(direct.status, 403, `${label}: direct read denied 403`);
      assert.equal(direct.body.ok, false);
      assert.equal(direct.body.error, 'forbidden', `${label}: fixed forbidden error`);
      assert.equal(direct.body.reason, 'not-authorized', `${label}: fixed not-authorized reason`);
      assertNoCaseFields(direct.body, `${label} direct read JSON`);

      // 2) Copied-link read (stable case ref) — the SAME fixed denial body.
      const link = await httpJson(`${base}/cases?case=${ref}`, {
        headers: { Cookie: client.cookieHeader },
      });
      assert.equal(link.status, 403, `${label}: copied-link read denied 403`);
      assert.equal(JSON.stringify(link.body), JSON.stringify(direct.body),
        `${label}: copied-link denial byte-identical to the direct-read denial`);
      assertNoCaseFields(link.body, `${label} copied-link JSON`);

      // 3) Request renewal — the SAME fixed denial body, no state write.
      const action = await httpJson(`${base}/handoff`, {
        method: 'POST',
        headers: { Cookie: client.cookieHeader },
        body: { case_ref: ref },
      });
      assert.equal(action.status, 403, `${label}: Request renewal denied 403`);
      assert.equal(JSON.stringify(action.body), JSON.stringify(direct.body),
        `${label}: Request-renewal denial byte-identical to the read denials`);
      assertNoCaseFields(action.body, `${label} handoff JSON`);

      denied.push([`${label} (JSON)`, direct.body]);
    }

    // Every signed-in denial body is byte-identical across identities and
    // across the three access paths (no per-identity or per-record
    // variation, no case fields).
    for (let i = 1; i < denied.length; i += 1) {
      assert.equal(
        JSON.stringify(denied[i][1]),
        JSON.stringify(denied[0][1]),
        'all denial bodies are byte-identical (fixed denial, no disclosure)'
      );
    }

    // HTML variants of the denial section: the fixed access-denied page,
    // byte-identical across the three identities, no case data, no scripts
    // or inline handlers.
    const htmlDenials = [];
    for (const [label, client] of [
      ['unrelated pharmacy', dunmore],
      ['unrelated patient', cleo],
      ['unrelated prescriber', emil],
    ]) {
      const htmlDirect = await fetchHtml(`${base}/cases?case=${ref}`, { headers: { Cookie: client.cookieHeader } });
      assert.equal(htmlDirect.status, 403, `${label}: HTML copied-link read denied 403`);
      assert.ok(htmlDirect.text.includes('<h1>Access denied</h1>'), `${label}: HTML denial is the fixed page`);
      assertNoCaseDataHtml(htmlDirect.text, `${label} HTML denial page`);
      assertNoScriptsOrHandlers(htmlDirect.text, `${label} HTML denial page`);
      htmlDenials.push(htmlDirect.text);

      const htmlAction = await httpForm(`${base}/handoff`, {
        headers: { Cookie: client.cookieHeader },
        form: { case_ref: ref },
      });
      assert.equal(htmlAction.status, 403, `${label}: HTML Request renewal denied 403`);
      assert.equal(htmlAction.text, htmlDirect.text, `${label}: HTML Request-renewal page byte-identical to the HTML read denial`);
      assertNoCaseDataHtml(htmlAction.text, `${label} HTML handoff denial page`);
    }
    for (let i = 1; i < htmlDenials.length; i += 1) {
      assert.equal(htmlDenials[i], htmlDenials[0], 'all HTML denial pages are byte-identical');
    }

    // Anonymous: 401 no-session (JSON + HTML sign-in prompt, no case data).
    const anon = await httpJson(`${base}/handoff`, {
      method: 'POST',
      body: { case_ref: ref },
    });
    assert.equal(anon.status, 401, 'anonymous Request renewal: 401 no-session');
    assert.equal(anon.body.error, 'no-session');
    assertNoCaseFields(anon.body, 'anonymous handoff JSON');
    const anonHtml = await httpForm(`${base}/handoff`, { form: { case_ref: ref } });
    assert.equal(anonHtml.status, 401, 'anonymous Request renewal: HTML 401');
    assert.ok(anonHtml.text.includes('No signed-in session is available; sign in first.'),
      'anonymous HTML 401 is the sign-in prompt with the clear error');
    assertNoCaseDataHtml(anonHtml.text, 'anonymous HTML handoff page');

    // A signed-in NON-pharmacy role never reaches the store: fixed 403
    // before any write (a patient — even one of this case — cannot hand
    // off; the role check precedes any store call).
    const patientAction = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { case_ref: ref },
    });
    assert.equal(patientAction.status, 403, 'unrelated patient Request renewal: fixed 403 role denial');
    assert.equal(patientAction.body.reason, 'not-authorized');
    assertNoCaseFields(patientAction.body, 'patient handoff JSON');

    // Durable evidence: EVERY table is byte-identical to the before-state —
    // the entire denial section made zero durable-state change (no renewal
    // row update, no event, no session change).
    const after = fullTableState(env.dbPath);
    assertStateUnchanged(after, before, 'denial section');
    const held = renewalRow(env.dbPath, OVERLAP_RN);
    assert.equal(held.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case is still Sent to pharmacy after all denials');
    assert.equal(held.version, pre.version, 'version unchanged by denials');
    assert.equal(held.handoff_at, null, 'no handoff time from any denial');
    assert.equal(handoffEventCount(env.dbPath, OVERLAP_RN), 0, 'no handoff event from any denial');

    // The authorized owner is UNAFFECTED by the denials: the same request
    // by the assigned pharmacy now succeeds with exactly one event.
    const cedarHandoff = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: ref },
    });
    assert.equal(cedarHandoff.status, 200, 'after the denials, the assigned pharmacy handoff succeeds');
    assert.equal(cedarHandoff.body.code, 'handed-off');
    assert.equal(handoffEventCount(env.dbPath, OVERLAP_RN), 1, 'the successful handoff recorded exactly one event');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// --- 4. Failed-save recovery --------------------------------------------------

test('over-HTTP: when the handoff commit fails, the pharmacy gets a recoverable 503 (JSON + HTML), the fresh case remains Sent to pharmacy with no partial handoff and no event, refresh shows the previous saved state, and the next retry recovers with exactly one event', async () => {
  const env = makeEnv('failed-save');
  let app;
  try {
    seedFreshHandoffCase(env.dbPath, FAIL_RX, FAIL_RN, '2026-11-16T16:20:00Z');
    // A SECOND fresh Sent to pharmacy case for the HTML failure phase: the
    // handoffCommitFailure seam fires on the FIRST-handoff path (after the
    // real UPDATE + event INSERT), so the HTML 503 check must target a case
    // that has not yet been handed off — by then the first target has its
    // recovered handoff (and would answer idempotently with a 303).
    seedFreshHandoffCase(env.dbPath, FAIL_HTML_RX, FAIL_HTML_RN, '2026-11-16T17:05:00Z');
    const failHtmlRef = caseRefFor(FAIL_HTML_RN);
    // One-shot seam armed: the NEXT POST /handoff performs the real
    // UPDATE + event INSERT, then the injected commit failure rolls back.
    app = await startServer({
      dbPath: env.dbPath,
      host: '127.0.0.1',
      port: 0,
      options: { handoffCommitFailure: true },
    });
    const base = `http://127.0.0.1:${app.port}`;
    const firstPort = app.port;
    const ref = caseRefFor(FAIL_RN);

    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const before = fullTableState(env.dbPath);
    const pre = renewalRow(env.dbPath, FAIL_RN);
    assert.equal(pre.status, STATUS_LABELS.SENT_TO_PHARMACY, 'precondition: fresh case is Sent to pharmacy');
    assert.equal(pre.version, 1, 'precondition: original version 1');

    // --- JSON 503: recoverable, fixed message, no case data ---------------
    const failed = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: ref },
    });
    assert.equal(failed.status, 503, 'failed save is a 503 over HTTP');
    assert.deepEqual(
      Object.keys(failed.body).sort(),
      ['error', 'message', 'ok', 'recoverable'],
      'failed-save JSON carries exactly the planned fields'
    );
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, 'handoff-save-failed');
    assert.equal(failed.body.recoverable, true, 'the response is explicitly recoverable');
    assert.equal(
      failed.body.message,
      'Your handoff could not be saved. Nothing was changed; please try again.',
      'fixed recoverable message'
    );
    assertNoCaseFields(failed.body, 'failed-save JSON body');

    // Durable state: every table byte-identical; no partial handoff and no
    // handoff event (the rollback removed the attempted writes).
    assertStateUnchanged(fullTableState(env.dbPath), before, 'failed save (JSON)');
    const held = renewalRow(env.dbPath, FAIL_RN);
    assert.equal(held.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy after the failed save');
    assert.equal(held.next_actor, 'pharmacy', 'no partial next-actor change from the failed save');
    assert.equal(held.handoff_at, null, 'no partial handoff time from the failed save');
    assert.equal(held.version, 1, 'no version increment from the failed save');
    assert.equal(handoffEventCount(env.dbPath, FAIL_RN), 0, 'no handoff event from the failed save');

    // Refresh shows the previous saved state (before any retry).
    const refresh = await httpJson(`${base}/cases?case=${ref}`, { headers: { Cookie: cedar.cookieHeader } });
    assert.equal(refresh.status, 200, 'refresh after the failed save is authorized');
    assert.equal(refresh.body.case.status, STATUS_LABELS.SENT_TO_PHARMACY, 'refresh shows the previous saved status');
    assert.equal(refresh.body.case.handoff_at, null, 'refresh shows no handoff time');
    const refreshHtml = await fetchHtml(`${base}/cases?case=${ref}`, { headers: { Cookie: cedar.cookieHeader } });
    assert.ok(refreshHtml.text.includes(STATUS_LABELS.SENT_TO_PHARMACY), 'HTML refresh shows the previous saved status');
    assert.ok(refreshHtml.text.includes('<dd>Not recorded</dd>'), 'HTML refresh shows no recorded handoff time');
    assert.equal((refreshHtml.text.match(/<form[^>]*action="\/handoff"/g) ?? []).length, 1,
      'the previous saved state still presents exactly one Request renewal form');

    // Recovery on the SAME server: the one-shot seam is consumed, so the
    // next retry succeeds with exactly one transition and one event.
    const retry = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: ref },
    });
    assert.equal(retry.status, 200, 'the follow-up retry after the 503 succeeds');
    assert.equal(retry.body.code, 'handed-off');
    assert.equal(retry.body.renewal.id, FAIL_RN, 'the retry hands off the same renewal');
    assert.equal(retry.body.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    const recoveredRow = renewalRow(env.dbPath, FAIL_RN);
    assert.equal(recoveredRow.version, 2, 'the recovered handoff incremented the version exactly once');
    assert.equal(handoffEventCount(env.dbPath, FAIL_RN), 1, 'the recovered handoff recorded exactly one event');
    assert.equal(
      handoffEvents(env.dbPath, FAIL_RN)[0].occurred_at,
      retry.body.renewal.handoff_at,
      'the single event records the recovered handoff time'
    );
    await app.close();
    app = null;

    // --- HTML 503 (seam re-armed on a fresh server): the recoverable -----
    // error renders as visible text in a stable-id alert paragraph, with no
    // case data; the following form retry recovers with a 303.
    app = await startServer({
      dbPath: env.dbPath,
      host: '127.0.0.1',
      port: firstPort,
      options: { handoffCommitFailure: true },
    });
    assert.equal(app.port, firstPort, 'the HTML failure check reuses the same port');
    const beforeHtml = fullTableState(env.dbPath);
    const preHtml = renewalRow(env.dbPath, FAIL_HTML_RN);
    assert.equal(preHtml.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the HTML target is still Sent to pharmacy before the failed save');
    const failedHtml = await httpForm(`${base}/handoff`, {
      headers: { Cookie: cedar.cookieHeader },
      form: { case_ref: failHtmlRef },
    });
    assert.equal(failedHtml.status, 503, 'failed save is a 503 for the HTML variant');
    assert.equal(failedHtml.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(
      failedHtml.text.includes('<h1>Your handoff could not be saved</h1>'),
      'the HTML 503 renders the handoff save-failure heading'
    );
    assert.ok(
      !failedHtml.text.includes('Access denied'),
      'the HTML 503 is not the access-denied page'
    );
    assert.ok(
      failedHtml.text.includes(
        '<p id="handoff-save-error" class="error" role="alert" tabindex="-1">Your handoff could not be saved. Nothing was changed; please try again.</p>'
      ),
      'the HTML 503 renders the fixed recoverable message (no case data) with role="alert" in the stable-id error paragraph'
    );
    assertNoCaseDataHtml(failedHtml.text, 'failed-save HTML page');
    assertNoScriptsOrHandlers(failedHtml.text, 'failed-save HTML page');
    assertStateUnchanged(fullTableState(env.dbPath), beforeHtml, 'failed save (HTML)');
    // The HTML failed save changed nothing: the HTML target remains Sent to
    // pharmacy at the original version with no event, and the earlier
    // recovery on the first target is intact (Awaiting prescriber, version
    // 2, the single recovered event).
    const afterHtmlFail = renewalRow(env.dbPath, FAIL_HTML_RN);
    assert.equal(afterHtmlFail.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the HTML target remains Sent to pharmacy after the failed save');
    assert.equal(afterHtmlFail.version, 1, 'HTML failed save made no version change');
    assert.equal(handoffEventCount(env.dbPath, FAIL_HTML_RN), 0, 'HTML failed save added no event');
    assert.equal(renewalRow(env.dbPath, FAIL_RN).version, 2, 'the earlier recovery on the first target is intact');

    // The following form attempt on the HTML target (seam consumed) recovers
    // with a 303 to the stable case ref and exactly one event.
    const formRetry = await httpForm(`${base}/handoff`, {
      headers: { Cookie: cedar.cookieHeader },
      form: { case_ref: failHtmlRef },
    });
    assert.equal(formRetry.status, 303, 'the follow-up form handoff after the HTML 503 recovers');
    assert.equal(formRetry.headers.get('location'), `/cases?case=${failHtmlRef}`, 'recovery 303 targets the stable case ref');
    assert.equal(handoffEventCount(env.dbPath, FAIL_HTML_RN), 1, 'the form recovery recorded exactly one event');
    assert.equal(handoffEventCount(env.dbPath, FAIL_RN), 1, 'the form recovery added no second event on the first target');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// --- 5. Authorized saved-state access -----------------------------------------

test('over-HTTP: after the handoff succeeds, authorized refresh, sign-out + re-sign-in, server restart, and copied-link access (prescriber and pharmacy) all show Awaiting prescriber, the prescriber next actor, and the handoff time; unrelated identities are denied', async () => {
  const env = makeEnv('saved-state');
  let app;
  try {
    seedFreshHandoffCase(env.dbPath, STATE_RX, STATE_RN, '2026-11-15T12:05:00Z');
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;
    const firstPort = app.port;
    const ref = caseRefFor(STATE_RN);
    const caseLink = `${base}/cases?case=${ref}`;

    const priya = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    const cedar = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const dunmore = await signInClient(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const emil = await signInClient(base, 'dr.emil.hart', 'prescriber-emil-2026');
    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');

    const before = fullTableState(env.dbPath);

    // Commit the handoff (same fresh synthetic case).
    const handoff = await httpJson(`${base}/handoff`, {
      method: 'POST',
      headers: { Cookie: cedar.cookieHeader },
      body: { case_ref: ref },
    });
    assert.equal(handoff.status, 200, 'committed handoff before the saved-state checks');
    assert.equal(handoff.body.code, 'handed-off');
    const handoffAt = handoff.body.renewal.handoff_at;
    assert.ok(typeof handoffAt === 'string' && handoffAt.length > 0, 'handoff time recorded');
    const assertSavedCase = (label, caseView) => {
      assert.equal(caseView.id, STATE_RN, `${label}: same renewal id`);
      assert.equal(caseView.status, STATUS_LABELS.AWAITING_PRESCRIBER, `${label}: Awaiting prescriber`);
      assert.equal(caseView.next_actor, 'prescriber', `${label}: the assigned prescriber is the next actor`);
      assert.equal(caseView.handoff_at, handoffAt, `${label}: the handoff time`);
      assert.equal(caseView.prescriber_id, 'ending-b-prescriber', `${label}: the assigned prescriber`);
      assert.equal(caseView.patient_id, 'ending-b-patient', `${label}: the case patient (applicable case data)`);
    };

    // 1) Refresh (same session): JSON + HTML, pharmacy and prescriber.
    assertSavedCase('pharmacy refresh (JSON)',
      (await httpJson(caseLink, { headers: { Cookie: cedar.cookieHeader } })).body.case);
    assertSavedCase('prescriber refresh (JSON)',
      (await httpJson(caseLink, { headers: { Cookie: priya.cookieHeader } })).body.case);
    const pharmacyHtml = await fetchHtml(caseLink, { headers: { Cookie: cedar.cookieHeader } });
    assert.ok(pharmacyHtml.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'pharmacy HTML refresh shows the status');
    assert.ok(pharmacyHtml.text.includes(`<dd>${handoffAt}</dd>`), 'pharmacy HTML refresh shows the handoff time');
    const prescriberHtml = await fetchHtml(caseLink, { headers: { Cookie: priya.cookieHeader } });
    assert.ok(prescriberHtml.text.includes(STATUS_LABELS.AWAITING_PRESCRIBER), 'prescriber HTML refresh shows the status');
    assert.ok(prescriberHtml.text.includes(`<dd>${handoffAt}</dd>`), 'prescriber HTML refresh shows the handoff time');

    // 2) The assigned prescriber's queue lists the case with the saved state.
    const queue = await httpJson(`${base}/cases`, { headers: { Cookie: priya.cookieHeader } });
    assert.equal(queue.status, 200, 'prescriber queue status');
    const queued = queue.body.cases.find((c) => c.id === STATE_RN);
    assert.ok(queued, 'the handoff case appears in the prescriber queue');
    assert.equal(queued.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'queue status');
    assert.equal(queued.handoff_at, handoffAt, 'queue handoff time');

    // 3) Copied-link access by the assigned prescriber and by the pharmacy
    //    (the very URLs the prescriber portal and the pharmacy would use).
    assertSavedCase('copied link (prescriber)',
      (await httpJson(caseLink, { headers: { Cookie: priya.cookieHeader } })).body.case);
    assertSavedCase('copied link (pharmacy)',
      (await httpJson(caseLink, { headers: { Cookie: cedar.cookieHeader } })).body.case);

    // 4) Sign-out + re-sign-in: an INDEPENDENT new session token; the same
    //    URLs resolve again from the durable store; the invalidated token
    //    is denied.
    await signOutClient(base, priya.cookieHeader);
    const deadLink = await httpJson(caseLink, { headers: { Cookie: priya.cookieHeader } });
    assert.equal(deadLink.status, 401, 'invalidated prescriber session denied on the copied link');
    assert.equal(deadLink.body.error, 'no-session');
    assertNoCaseFields(deadLink.body, 'invalidated-session link denial', { extraTokens: [handoffAt] });
    const priyaAgain = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    assert.notEqual(priyaAgain.token, priya.token, 're-sign-in issues an independent session token');
    assertSavedCase('re-sign-in (prescriber)',
      (await httpJson(caseLink, { headers: { Cookie: priyaAgain.cookieHeader } })).body.case);

    // 5) Server restart against the same database file: durable sessions
    //    reauthorize from the store.
    await app.close();
    app = null;
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort });
    assert.equal(app.port, firstPort, 'restart rebinds the same ephemeral port');
    assertSavedCase('server restart (prescriber)',
      (await httpJson(caseLink, { headers: { Cookie: priyaAgain.cookieHeader } })).body.case);
    assertSavedCase('server restart (pharmacy)',
      (await httpJson(caseLink, { headers: { Cookie: cedar.cookieHeader } })).body.case);
    const stillDead = await httpJson(caseLink, { headers: { Cookie: priya.cookieHeader } });
    assert.equal(stillDead.status, 401, 'pre-restart invalidated token still denied');

    // 6) Unrelated identities are denied the saved state as well: fixed
    //    403, no case data (the saved handoff is not exposed).
    const unrelated = await httpJson(caseLink, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(unrelated.status, 403, 'unrelated pharmacy denied the saved state');
    assert.equal(unrelated.body.reason, 'not-authorized');
    assertNoCaseFields(unrelated.body, 'unrelated pharmacy denial', { extraTokens: [handoffAt] });
    assertNoCaseFields((await httpJson(caseLink, { headers: { Cookie: emil.cookieHeader } })).body, 'unrelated prescriber denial', { extraTokens: [handoffAt] });
    assertNoCaseFields((await httpJson(caseLink, { headers: { Cookie: cleo.cookieHeader } })).body, 'unrelated patient denial', { extraTokens: [handoffAt] });

    // The saved-state section changed nothing beyond the single committed
    // handoff (one renewal-row update + one event row). The sessions table
    // is expected to differ: the prescriber signed out and re-signed in,
    // so one session row was replaced by a fresh independent one (checked
    // explicitly below).
    const after = fullTableState(env.dbPath);
    assertOnlyRowChanged(after, before, STATE_RN, 'saved-state section', { skipTables: ['sessions'] });
    assert.equal(after.renewal_events.length, before.renewal_events.length + 1, 'exactly the one handoff event exists');
    const sessionTokens = after.sessions.map((r) => r[0]);
    assert.ok(sessionTokens.includes(priyaAgain.token), 'the re-signed-in prescriber session is durable');
    assert.ok(!sessionTokens.includes(priya.token), 'the signed-out prescriber session row is gone');
    assert.equal(after.sessions.length, before.sessions.length, 'net session count unchanged (one out, one in)');
    const row = renewalRow(env.dbPath, STATE_RN);
    assert.equal(row.handoff_at, handoffAt, 'durable handoff time stable across the whole section');
    assert.equal(row.version, 2, 'no further version changes');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
