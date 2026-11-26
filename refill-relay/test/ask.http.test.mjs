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

// --- helpers ---------------------------------------------------------------

// One fresh disposable database per test: unique temp dir, schema, fixture
// set, and local synthetic accounts (so real HTTP sign-in works).
function makeEnv(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-fixture-${tag}-`));
  const dbPath = join(dir, `ask-${tag}.sqlite`);
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
}

// The eligible create target the fixture set does not provide (all three
// seeded prescriptions are terminal, pending, or ineligible): a fresh
// zero-refill prescription owned by cleo (denial-patient), assigned to the
// unrelated pharmacy/prescriber identities, with NO renewal.
const ASK_RX = Object.freeze({
  id: 'http-ask-rx',
  patient_id: 'denial-patient',
  pharmacy_id: 'pharmacy-dunmore',
  prescriber_id: 'denial-prescriber',
  refills_remaining: 0,
});

const HTML_ASK_RX = Object.freeze({
  id: 'http-ask-rx-2',
  patient_id: 'denial-patient',
  pharmacy_id: 'pharmacy-dunmore',
  prescriber_id: 'denial-prescriber',
  refills_remaining: 0,
});

function seedAskTarget(dbPath) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(ASK_RX.id, ASK_RX.patient_id, ASK_RX.pharmacy_id, ASK_RX.prescriber_id);
  } finally {
    db.close();
  }
}

function seedHtmlAskTarget(dbPath) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(HTML_ASK_RX.id, HTML_ASK_RX.patient_id, HTML_ASK_RX.pharmacy_id, HTML_ASK_RX.prescriber_id);
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

// Parse the patient prescriptions page table into an array of 5-cell rows.
// Each cell's raw inner HTML is kept so the test can inspect the Action
// affordance (ask form vs. case link vs. fixed notice) directly.
function rxTableRows(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert.ok(tbody, 'prescriptions page renders a prescriptions table');
  const rows = [];
  for (const tr of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [];
    for (const td of tr[1].matchAll(/<td>([\s\S]*?)<\/td>/g)) cells.push(td[1]);
    rows.push(cells);
  }
  return rows;
}

// The single ask form present in an action cell (null when the cell holds a
// link or notice instead). Asserts the labeled native POST wiring.
function askFormIn(cell) {
  const m = cell.match(/<form([^>]*)>\s*<input type="hidden" name="prescription_id" value="([^"]*)">\s*<button type="submit">Ask my pharmacy<\/button>\s*<\/form>/);
  if (!m) return null;
  const attrs = {};
  for (const attr of m[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
  return { attrs, prescriptionId: m[2] };
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
  ASK_RX.id,
  HTML_ASK_RX.id,
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

function assertNoPickupReadyHtml(html, label) {
  assert.ok(
    !/ready\s+for\s+pickup/i.test(html),
    `${label}: no pickup-ready status or text may be rendered`
  );
}

function assertNoScriptsOrHandlers(html, label) {
  assert.ok(!/<script[\s>]/i.test(html), `${label}: no inline script elements`);
  assert.ok(!/on(click|submit|change|load|focus|input|key)\s*=/i.test(html),
    `${label}: no inline event handlers`);
}

// The stored renewal row for a prescription (fresh connection) — the
// authoritative durable state the responses must reflect.
function savedRenewal(dbPath, prescriptionId) {
  const db = initDatabase(dbPath);
  try {
    return db
      .prepare(`SELECT * FROM renewals WHERE prescription_id = ? ORDER BY id`)
      .all(prescriptionId);
  } finally {
    db.close();
  }
}


test('over-HTTP: two concurrent POST /ask requests leave exactly one saved renewal and one submitted event, and both callers resolve to the same renewal id', async () => {
  const env = makeEnv('contention');
  let app;
  try {
    seedAskTarget(env.dbPath);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    assert.equal(cleo.identity.role, 'patient');

    const before = fullTableState(env.dbPath);
    assert.equal(before.renewals.length, 2, 'only the two fixture renewals exist before the race');

    const [first, second] = await Promise.all([
      httpJson(`${base}/ask`, { method: 'POST', headers: { Cookie: cleo.cookieHeader }, body: { prescription_id: ASK_RX.id } }),
      httpJson(`${base}/ask`, { method: 'POST', headers: { Cookie: cleo.cookieHeader }, body: { prescription_id: ASK_RX.id } }),
    ]);

    // Both callers get a 2xx outcome (201 created, or 200 already-pending):
    // no error, no 500, no lock-contention failure escapes over HTTP.
    for (const [label, res] of [['first', first], ['second', second]]) {
      assert.ok(
        res.status === 200 || res.status === 201,
        `${label}: concurrent ask is a 2xx outcome (got ${res.status}: ${res.raw})`
      );
      assert.equal(res.body.ok, true, `${label}: outcome flag`);
    }
    // The two outcomes partition the first/repeat split: one created (201),
    // the other already-pending (200) — same record either way.
    const outcomes = [first, second].sort((a, b) => a.status - b.status);
    assert.equal(outcomes[0].status, 200, 'the repeat outcome is a 200 already-pending');
    assert.equal(outcomes[0].body.code, 'already-pending');
    assert.equal(outcomes[0].body.created, false);
    assert.equal(outcomes[1].status, 201, 'the first outcome is a 201 created');
    assert.equal(outcomes[1].body.code, 'created');
    assert.equal(outcomes[1].body.created, true);

    // BOTH callers resolve to the same saved renewal id.
    const idA = outcomes[0].body.renewal.id;
    const idB = outcomes[1].body.renewal.id;
    assert.equal(idA, idB, 'both concurrent callers return the same renewal id');
    assert.match(idA, /^[0-9a-f]{32}$/, 'the resolved renewal id is 32-hex');

    const rows = savedRenewal(env.dbPath, ASK_RX.id);
    assert.equal(rows.length, 1, 'exactly one saved renewal after both concurrent asks');
    assert.equal(rows[0].id, idA, 'the saved renewal is the id both callers received');
    assert.equal(rows[0].status, STATUS_LABELS.SENT_TO_PHARMACY, 'saved status');
    assert.equal(rows[0].next_actor, 'pharmacy', 'saved next actor');
    const events = initDatabase(env.dbPath);
    let eventCount;
    try {
      eventCount = events
        .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`)
        .get(rows[0].id, 'submitted').n;
    } finally {
      events.close();
    }
    assert.equal(eventCount, 1, 'exactly one submitted event after both concurrent asks');

    // Full durable state: only the two expected new rows appear relative to
    // the before-state (one renewal, one event); nothing else moved.
    const after = fullTableState(env.dbPath);
    assert.equal(after.renewals.length, before.renewals.length + 1, 'renewals grew by exactly one');
    assert.equal(after.renewal_events.length, before.renewal_events.length + 1, 'events grew by exactly one');
    for (const table of Object.keys(before)) {
      if (table === 'renewals' || table === 'renewal_events') continue;
      assert.deepEqual(after[table], before[table], `table ${table} unchanged by the race`);
    }
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: first ask 201 created, repeat 200 already-pending (JSON); terminal 200 already-final (JSON); HTML form ask 303s to the stable case ref', async () => {
  const env = makeEnv('ask-status');
  let app;
  try {
    seedAskTarget(env.dbPath);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const ava = await signInClient(base, 'ava.mercer', 'patient-ava-2026');

    // --- first ask (JSON): 201 created with the planned renewal fields ---
    const first = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(first.status, 201, 'first ask is a 201 created');
    assert.equal(first.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(
      Object.keys(first.body).sort(),
      ['code', 'created', 'ok', 'renewal'],
      'created response carries exactly the planned top-level fields'
    );
    assert.equal(first.body.ok, true);
    assert.equal(first.body.created, true);
    assert.equal(first.body.code, 'created');
    assert.deepEqual(
      Object.keys(first.body.renewal).sort(),
      ['id', 'next_actor', 'status', 'submitted_at'],
      'created renewal carries the planned fields (no more)'
    );
    assert.equal(first.body.renewal.status, STATUS_LABELS.SENT_TO_PHARMACY);
    assert.equal(first.body.renewal.next_actor, 'pharmacy');
    assert.ok(!Number.isNaN(Date.parse(first.body.renewal.submitted_at)), 'submitted_at is ISO');
    const createdId = first.body.renewal.id;
    assert.match(createdId, /^[0-9a-f]{32}$/, 'created renewal id is 32-hex');

    // --- repeat while pending (JSON): 200 already-pending, same record ---
    const repeat = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(repeat.status, 200, 'repeat ask is a 200');
    assert.equal(repeat.body.ok, true);
    assert.equal(repeat.body.created, false);
    assert.equal(repeat.body.code, 'already-pending');
    assert.equal(repeat.body.renewal.id, createdId, 'repeat returns the existing renewal id');
    assert.equal(repeat.body.renewal.submitted_at, first.body.renewal.submitted_at, 'original submitted_at preserved');
    assert.equal(repeat.body.renewal.status, STATUS_LABELS.SENT_TO_PHARMACY);
    assert.equal(repeat.body.renewal.next_actor, 'pharmacy');
    // No duplicate rows, no duplicate event, no moved timestamp.
    const rows = savedRenewal(env.dbPath, ASK_RX.id);
    assert.equal(rows.length, 1, 'still exactly one saved renewal after the repeat');
    assert.equal(rows[0].submitted_at, first.body.renewal.submitted_at, 'durable submitted_at unchanged');

    // --- HTML form ask while pending: 303 to the stable case ref ---------
    const formRepeat = await httpForm(`${base}/ask`, {
      headers: { Cookie: cleo.cookieHeader },
      form: { prescription_id: ASK_RX.id },
    });
    assert.equal(formRepeat.status, 303, 'HTML repeat ask is a 303');
    assert.equal(
      formRepeat.headers.get('location'),
      `/cases?case=${caseRefFor(createdId)}`,
      '303 targets the stable opaque case ref of the existing renewal'
    );
    assert.equal(formRepeat.text, '', '303 carries no body');

    const detail = await fetchHtml(`${base}/cases?case=${caseRefFor(createdId)}`, {
      headers: { Cookie: cleo.cookieHeader },
    });
    assert.equal(detail.status, 200, 'case detail resolves after the 303');
    assert.ok(detail.text.includes('Sent to pharmacy'), 'detail shows the saved status as visible text');
    assert.ok(detail.text.includes('Submitted at'), 'detail shows the submission time');
    assert.ok(detail.text.includes('Next actor'), 'detail shows the next actor');

    // --- terminal ask (JSON): 200 already-final, existing disposition ---
    // ending-a-rx is Ava's terminal 'Renewal approved' fixture record.
    const terminal = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: ava.cookieHeader },
      body: { prescription_id: 'ending-a-rx' },
    });
    assert.equal(terminal.status, 200, 'terminal repeat ask is a 200');
    assert.equal(terminal.body.ok, true);
    assert.equal(terminal.body.created, false);
    assert.equal(terminal.body.code, 'already-final');
    assert.equal(terminal.body.renewal.id, 'ending-a-renewal', 'returns the existing terminal record');
    assert.equal(terminal.body.renewal.status, STATUS_LABELS.RENEWAL_APPROVED);
    assert.equal(terminal.body.renewal.next_actor, 'pharmacy');
    assert.equal(terminal.body.renewal.submitted_at, '2026-11-21T08:00:00Z', 'original submission time');
    assert.equal(terminal.body.renewal.decided_at, '2026-11-21T09:00:00Z', 'original decision time');
    assert.equal(terminal.body.renewal.granted_refills, 1, 'original granted refill count');
    assert.deepEqual(
      Object.keys(terminal.body.renewal).sort(),
      ['decided_at', 'granted_refills', 'id', 'next_actor', 'status', 'submitted_at'],
      'terminal renewal carries the planned disposition fields'
    );

    const terminalRows = savedRenewal(env.dbPath, 'ending-a-rx');
    assert.equal(terminalRows.length, 1, 'the terminal prescription still has exactly one renewal');
    const eventsAfterTerminal = initDatabase(env.dbPath);
    let terminalEvents;
    try {
      terminalEvents = eventsAfterTerminal
        .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = 'ending-a-renewal'`)
        .get().n;
    } finally {
      eventsAfterTerminal.close();
    }
    assert.equal(terminalEvents, 0, 'no new event for the terminal record (fixture seeded none; the ask added none)');

    // --- HTML form terminal ask: 303 to the existing terminal case -------
    const formTerminal = await httpForm(`${base}/ask`, {
      headers: { Cookie: ava.cookieHeader },
      form: { prescription_id: 'ending-a-rx' },
    });
    assert.equal(formTerminal.status, 303, 'HTML terminal ask is a 303');
    assert.equal(
      formTerminal.headers.get('location'),
      `/cases?case=${caseRefFor('ending-a-renewal')}`,
      'terminal 303 targets the existing terminal case'
    );
    const terminalDetail = await fetchHtml(`${base}/cases?case=${caseRefFor('ending-a-renewal')}`, {
      headers: { Cookie: ava.cookieHeader },
    });
    assert.equal(terminalDetail.status, 200);
    assert.ok(terminalDetail.text.includes('Renewal approved'), 'terminal detail shows the saved disposition as visible text');
    assertNoPickupReadyHtml(terminalDetail.text, 'terminal case detail');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: refresh, sign-out + re-sign-in, copied case link, and server restart all recover the saved ask state (per-request reauthorization)', async () => {
  const env = makeEnv('session-recovery');
  let app;
  try {
    seedAskTarget(env.dbPath);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const firstPort = app.port;
    const base = `http://127.0.0.1:${app.port}`;

    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const created = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(created.status, 201, 'committed ask before the recovery checks');
    const createdId = created.body.renewal.id;
    const ref = caseRefFor(createdId);
    const caseLink = `${base}/cases?case=${ref}`;
    const savedState = {
      status: STATUS_LABELS.SENT_TO_PHARMACY,
      next_actor: 'pharmacy',
      submitted_at: created.body.renewal.submitted_at,
    };

    const assertRecoveredState = (label, caseRes) => {
      assert.equal(caseRes.status, 200, `${label}: case detail status`);
      assert.equal(caseRes.body.case.id, createdId, `${label}: same renewal id`);
      assert.equal(caseRes.body.case.status, savedState.status, `${label}: same status`);
      assert.equal(caseRes.body.case.next_actor, savedState.next_actor, `${label}: same next actor`);
      assert.equal(caseRes.body.case.submitted_at, savedState.submitted_at, `${label}: same submission time`);
    };

    // 1) Refresh: re-GET the same detail URL (and the prescriptions list)
    //    with the SAME session.
    assertRecoveredState('refresh', await httpJson(caseLink, { headers: { Cookie: cleo.cookieHeader } }));
    let list = await httpJson(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(list.status, 200, 'refresh: prescriptions list status');
    let pendingRow = list.body.prescriptions.find((p) => p.id === ASK_RX.id);
    assert.ok(pendingRow, 'refresh: the asked prescription is listed');
    assert.equal(pendingRow.state, 'pending', 'refresh: list state is pending');
    assert.equal(pendingRow.renewal_case_ref, ref, 'refresh: list carries the stable case ref');

    // 2) Per-request reauthorization: after sign-out the SAME session is
    //    denied on BOTH routes (401, no case data, no state change) — the
    //    server re-resolves the session on every request.
    await signOutClient(base, cleo.cookieHeader);
    const deadCase = await httpJson(caseLink, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(deadCase.status, 401, 'invalidated session denied on the case link');
    assert.equal(deadCase.body.error, 'no-session');
    assertNoCaseFields(deadCase.body, 'invalidated-session case denial');
    const deadAsk = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(deadAsk.status, 401, 'invalidated session denied on POST /ask');
    assert.equal(deadAsk.body.error, 'no-session');
    assertNoCaseFields(deadAsk.body, 'invalidated-session ask denial');
    const deadList = await httpJson(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(deadList.status, 401, 'invalidated session denied on GET /prescriptions');
    const afterSignOut = fullTableState(env.dbPath);
    assert.equal(afterSignOut.sessions.length, 0, 'sign-out removed the only session row');
    assertStateUnchanged(fullTableState(env.dbPath), afterSignOut, 'denials after sign-out');

    // 3) Re-sign-in: an INDEPENDENT new session token; the same URLs
    //    resolve again from the durable store.
    const second = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    assert.notEqual(second.token, cleo.token, 're-sign-in issues an independent session token');
    assertRecoveredState('re-sign-in', await httpJson(caseLink, { headers: { Cookie: second.cookieHeader } }));

    // 4) Server process restart against the same database file: the copied
    //    link and the list reauthorize from the durable session store.
    await app.close();
    app = null;
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort });
    assert.equal(app.port, firstPort, 'restart rebinds the same ephemeral port');
    assertRecoveredState('server restart', await httpJson(caseLink, { headers: { Cookie: second.cookieHeader } }));
    list = await httpJson(`${base}/prescriptions`, { headers: { Cookie: second.cookieHeader } });
    assert.equal(list.status, 200, 'restart: prescriptions list status');
    pendingRow = list.body.prescriptions.find((p) => p.id === ASK_RX.id);
    assert.equal(pendingRow.state, 'pending', 'restart: list state is still pending');
    assert.equal(pendingRow.status, STATUS_LABELS.SENT_TO_PHARMACY, 'restart: list status matches the durable record');

    // The invalidated pre-restart token is still dead after the restart.
    const stillDead = await httpJson(caseLink, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(stillDead.status, 401, 'pre-restart invalidated token still denied');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: injected save failure returns 503 recoverable (JSON and HTML), leaves every durable table unchanged, and the next ask succeeds', async () => {
  const env = makeEnv('http-rollback');
  let app;
  try {
    seedAskTarget(env.dbPath);
    // A SECOND fresh eligible target for the HTML failure phase: the
    // failAskCommit seam fires on the CREATE path (after the INSERTs),
    // so the HTML 503 check must target a prescription with no renewal —
    // by then the first target has its recovered create.
    seedHtmlAskTarget(env.dbPath);

    // One-shot seam armed: the NEXT POST /ask exercises the real INSERTs,
    // the real ROLLBACK, and the recoverable 503 — over real HTTP.
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0, options: { askCommitFailure: true } });
    const base = `http://127.0.0.1:${app.port}`;
    const firstPort = app.port;

    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const before = fullTableState(env.dbPath);
    assert.equal(before.renewals.length, 2, 'no renewal for the ask target before the failed save');

    // --- JSON 503: recoverable, fixed message, no case data ---------------
    const failed = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(failed.status, 503, 'failed save is a 503 over HTTP');
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, 'ask-save-failed');
    assert.equal(failed.body.recoverable, true, 'the response is explicitly recoverable');
    assert.equal(
      failed.body.message,
      'Your request could not be saved. Nothing was changed; please try again.',
      'fixed recoverable message'
    );
    assertNoCaseFields(failed.body, 'failed-save JSON body');

    // Durable state: every table byte-identical; no partial renewal row or
    // event for the ask target.
    const after = fullTableState(env.dbPath);
    assertStateUnchanged(after, before, 'failed save (JSON)');
    assert.equal(savedRenewal(env.dbPath, ASK_RX.id).length, 0, 'no partial renewal row from the failed commit');
    const events = initDatabase(env.dbPath);
    let submittedCount;
    try {
      submittedCount = events.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE event_type = 'submitted'`).get().n;
    } finally {
      events.close();
    }
    assert.equal(submittedCount, 0, 'no partial submitted event from the failed commit');

    // Recovery on the SAME server: the one-shot seam is consumed, so the
    // next ask succeeds and creates exactly one renewal + one event.
    const retry = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(retry.status, 201, 'the follow-up ask after the 503 succeeds');
    assert.equal(retry.body.code, 'created');
    assert.equal(savedRenewal(env.dbPath, ASK_RX.id).length, 1, 'recovery: exactly one saved renewal');
    await app.close();
    app = null;

    // --- HTML 503 (seam re-armed on a fresh server): the recoverable -----
    // error renders as visible text in a stable-id error paragraph, with no
    // case data and no pickup-ready text.
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort, options: { askCommitFailure: true } });
    assert.equal(app.port, firstPort, 'the HTML failure check reuses the same port');
    const beforeHtml = fullTableState(env.dbPath);
    assert.equal(savedRenewal(env.dbPath, HTML_ASK_RX.id).length, 0, 'the HTML target has no renewal before the failed save');
    const failedHtml = await httpForm(`${base}/ask`, {
      headers: { Cookie: cleo.cookieHeader },
      form: { prescription_id: HTML_ASK_RX.id },
    });
    assert.equal(failedHtml.status, 503, 'failed save is a 503 for the HTML variant');
    assert.equal(failedHtml.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(
      failedHtml.text.includes('<h1>Your request could not be saved</h1>'),
      'the HTML 503 renders the save-failure heading'
    );
    assert.ok(
      !failedHtml.text.includes('Access denied'),
      'the HTML 503 is not the access-denied page'
    );
    assert.ok(
      failedHtml.text.includes(
        '<p id="ask-save-error" class="error" role="alert" tabindex="-1">Your request could not be saved. Nothing was changed; please try again.</p>'
      ),
      'the HTML 503 renders the fixed recoverable message (no case data) with role="alert" in the stable-id error paragraph'
    );
    assertNoCaseDataHtml(failedHtml.text, 'failed-save HTML page');
    assertNoPickupReadyHtml(failedHtml.text, 'failed-save HTML page');
    assertNoScriptsOrHandlers(failedHtml.text, 'failed-save HTML page');
    assertStateUnchanged(fullTableState(env.dbPath), beforeHtml, 'failed save (HTML)');
    assert.equal(savedRenewal(env.dbPath, HTML_ASK_RX.id).length, 0, 'no partial renewal row from the HTML failed commit');
    // The HTML failed save must not have disturbed the earlier recovery
    // either: exactly one saved renewal on the first target remains.
    const rows = savedRenewal(env.dbPath, ASK_RX.id);
    assert.equal(rows.length, 1, 'still exactly one saved renewal after the HTML failed save');

    // And the following form ask (seam consumed) succeeds with a 303.
    const formRetry = await httpForm(`${base}/ask`, {
      headers: { Cookie: cleo.cookieHeader },
      form: { prescription_id: ASK_RX.id },
    });
    assert.equal(formRetry.status, 303, 'the follow-up form ask after the HTML 503 succeeds');
    assert.equal(formRetry.headers.get('location'), `/cases?case=${caseRefFor(rows[0].id)}`,
      'follow-up 303 targets the existing renewal (idempotent recovery)');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: ask denials (other patient 404 opaque, non-patient 403, anonymous 401, ineligible 422) disclose no case data and leave every durable table unchanged', async () => {
  const env = makeEnv('http-denials');
  let app;
  try {
    seedAskTarget(env.dbPath);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // Sign in every identity the denial section uses (their sessions are
    // part of the durable before-state).
    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const boris = await signInClient(base, 'boris.laine', 'patient-boris-2026');
    const dunmore = await signInClient(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const emil = await signInClient(base, 'dr.emil.hart', 'prescriber-emil-2026');
    assert.equal(cleo.identity.role, 'patient');
    assert.equal(boris.identity.role, 'patient');
    assert.equal(dunmore.identity.role, 'pharmacy');
    assert.equal(emil.identity.role, 'prescriber');

    const before = fullTableState(env.dbPath);
    assert.equal(before.sessions.length, 4, 'reference includes the four sign-in sessions');
    assert.equal(before.renewals.length, 2, 'reference includes only the two fixture renewals');

    const denialChecks = [];

    // 1) Another patient asks for Cleo's prescription: 404, BYTE-IDENTICAL
    //    to an unknown id (no existence or ownership disclosure).
    const otherPatient = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: boris.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(otherPatient.status, 404, 'other patient: 404');
    assert.equal(otherPatient.body.ok, false);
    assert.equal(otherPatient.body.error, 'not-found');
    assertNoCaseFields(otherPatient.body, 'other-patient 404 body');
    const unknownId = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: 'no-such-rx' },
    });
    assert.equal(unknownId.status, 404, 'unknown id: 404');
    assert.equal(
      JSON.stringify(otherPatient.body),
      JSON.stringify(unknownId.body),
      'other-patient and unknown-id denials are byte-identical (no existence disclosure)'
    );
    // HTML variant: the fixed 404 page, also byte-identical, no case data.
    const otherPatientHtml = await httpForm(`${base}/ask`, {
      headers: { Cookie: boris.cookieHeader },
      form: { prescription_id: ASK_RX.id },
    });
    assert.equal(otherPatientHtml.status, 404, 'other patient: HTML 404');
    assert.ok(otherPatientHtml.text.includes('<h1>Page not found</h1>'), 'HTML 404 is the fixed not-found page');
    assertNoCaseDataHtml(otherPatientHtml.text, 'other-patient HTML 404 page');
    assertNoScriptsOrHandlers(otherPatientHtml.text, 'other-patient HTML 404 page');
    denialChecks.push(['other patient (JSON)', otherPatient.body]);
    denialChecks.push(['other patient (HTML)', otherPatientHtml.text]);

    // 2) Non-patient roles: fixed 403 before any store call (no case data,
    //    no returnTo, byte-identical across roles).
    const pharmacyAsk = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: dunmore.cookieHeader },
      body: { prescription_id: 'ending-b-rx' },
    });
    assert.equal(pharmacyAsk.status, 403, 'pharmacy ask: 403');
    assert.equal(pharmacyAsk.body.ok, false);
    assert.equal(pharmacyAsk.body.error, 'forbidden');
    assert.equal(pharmacyAsk.body.reason, 'not-authorized');
    assertNoCaseFields(pharmacyAsk.body, 'pharmacy ask 403 body');
    const prescriberAsk = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: emil.cookieHeader },
      body: { prescription_id: 'ending-b-rx' },
    });
    assert.equal(prescriberAsk.status, 403, 'prescriber ask: 403');
    assert.equal(
      JSON.stringify(pharmacyAsk.body),
      JSON.stringify(prescriberAsk.body),
      'pharmacy and prescriber ask denials are byte-identical'
    );
    const pharmacyAskHtml = await httpForm(`${base}/ask`, {
      headers: { Cookie: dunmore.cookieHeader },
      form: { prescription_id: 'ending-b-rx' },
    });
    assert.equal(pharmacyAskHtml.status, 403, 'pharmacy ask: HTML 403');
    assert.ok(pharmacyAskHtml.text.includes('<h1>Access denied</h1>'), 'HTML 403 is the fixed denial page');
    assertNoCaseDataHtml(pharmacyAskHtml.text, 'pharmacy ask HTML 403 page');
    denialChecks.push(['pharmacy ask (JSON)', pharmacyAsk.body]);
    denialChecks.push(['prescriber ask (JSON)', prescriberAsk.body]);
    denialChecks.push(['pharmacy ask (HTML)', pharmacyAskHtml.text]);

    // 3) Anonymous: 401 no-session on POST /ask (JSON + HTML) — and the
    //    HTML prompt carries the safe return target (no case data).
    const anonAsk = await httpJson(`${base}/ask`, {
      method: 'POST',
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(anonAsk.status, 401, 'anonymous ask: 401');
    assert.equal(anonAsk.body.error, 'no-session');
    assertNoCaseFields(anonAsk.body, 'anonymous ask 401 body');
    const anonAskHtml = await httpForm(`${base}/ask`, { form: { prescription_id: ASK_RX.id } });
    assert.equal(anonAskHtml.status, 401, 'anonymous ask: HTML 401');
    assert.ok(
      anonAskHtml.text.includes('No signed-in session is available; sign in first.'),
      'anonymous ask: HTML sign-in prompt with the clear error'
    );
    assertNoCaseDataHtml(anonAskHtml.text, 'anonymous ask HTML 401 page');
    denialChecks.push(['anonymous ask (JSON)', anonAsk.body]);
    denialChecks.push(['anonymous ask (HTML)', anonAskHtml.text]);

    // 4) Ineligible own prescription (refills remaining, no renewal):
    //    fixed 422, no refill count, no case data.
    const ineligible = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: 'denial-rx' },
    });
    assert.equal(ineligible.status, 422, 'ineligible own rx: 422');
    assert.equal(ineligible.body.ok, false);
    assert.equal(ineligible.body.error, 'ineligible-prescription');
    assertNoCaseFields(ineligible.body, 'ineligible 422 body');
    const ineligibleHtml = await httpForm(`${base}/ask`, {
      headers: { Cookie: cleo.cookieHeader },
      form: { prescription_id: 'denial-rx' },
    });
    assert.equal(ineligibleHtml.status, 422, 'ineligible own rx: HTML 422');
    assert.ok(ineligibleHtml.text.includes('This prescription is not eligible for a renewal request.'),
      'HTML 422 renders the fixed eligible-notice text');
    assertNoCaseDataHtml(ineligibleHtml.text, 'ineligible HTML 422 page');
    denialChecks.push(['ineligible (JSON)', ineligible.body]);
    denialChecks.push(['ineligible (HTML)', ineligibleHtml.text]);

    // 5) GET /prescriptions denials: anonymous 401 (JSON + HTML with the
    //    safe returnTo), non-patient fixed 403 (byte-identical, no data).
    const anonList = await httpJson(`${base}/prescriptions`);
    assert.equal(anonList.status, 401, 'anonymous list: 401');
    assert.equal(anonList.body.error, 'no-session');
    assertNoCaseFields(anonList.body, 'anonymous list 401 body');
    const anonListHtml = await fetchHtml(`${base}/prescriptions`);
    assert.equal(anonListHtml.status, 401, 'anonymous list: HTML 401');
    assert.ok(
      anonListHtml.text.includes('<input type="hidden" name="returnTo" value="/prescriptions">'),
      'anonymous list: HTML prompt preserves the safe return target'
    );
    assertNoCaseDataHtml(anonListHtml.text, 'anonymous list HTML 401 page');
    const pharmacyList = await httpJson(`${base}/prescriptions`, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(pharmacyList.status, 403, 'pharmacy list: 403');
    assert.equal(pharmacyList.body.error, 'forbidden');
    assertNoCaseFields(pharmacyList.body, 'pharmacy list 403 body');
    const prescriberList = await httpJson(`${base}/prescriptions`, { headers: { Cookie: emil.cookieHeader } });
    assert.equal(
      JSON.stringify(pharmacyList.body),
      JSON.stringify(prescriberList.body),
      'pharmacy and prescriber list denials are byte-identical'
    );
    const pharmacyListHtml = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(pharmacyListHtml.status, 403, 'pharmacy list: HTML 403');
    assert.ok(pharmacyListHtml.text.includes('<h1>Access denied</h1>'), 'HTML 403 list is the fixed denial page');
    assertNoCaseDataHtml(pharmacyListHtml.text, 'pharmacy list HTML 403 page');
    assertNoScriptsOrHandlers(pharmacyListHtml.text, 'pharmacy list HTML 403 page');
    denialChecks.push(['anonymous list (JSON)', anonList.body]);
    denialChecks.push(['pharmacy list (JSON)', pharmacyList.body]);
    denialChecks.push(['pharmacy list (HTML)', pharmacyListHtml.text]);

    // Every denial body/page is fixed-shape: no per-record variation beyond
    // the fixed fields (JSON) and no case token anywhere (checked above).
    for (const [label, body] of denialChecks) {
      if (typeof body === 'object' && body !== null) {
        assert.ok(!JSON.stringify(body).includes('"renewal"'), `${label}: no renewal value in a denial body`);
      }
    }

    // Durable evidence: EVERY table is byte-identical to the before-state
    // — denials (and the sign-outs none) made zero durable-state change; no
    // renewal row, no event, no session row appeared or disappeared.
    const after = fullTableState(env.dbPath);
    assertStateUnchanged(after, before, 'denial section');
    assert.equal(after.renewals.length, before.renewals.length, 'no renewal rows from any denial');
    assert.equal(after.renewal_events.length, before.renewal_events.length, 'no events from any denial');
    assert.equal(after.sessions.length, before.sessions.length, 'sessions count unchanged');
    assert.equal(savedRenewal(env.dbPath, ASK_RX.id).length, 0, 'the ask target was never created by a denial');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: GET /prescriptions returns only the signed-in patient\'s own prescriptions with correct states and case refs; non-patient 403; anonymous 401', async () => {
  const env = makeEnv('listing');
  let app;
  try {
    seedAskTarget(env.dbPath);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const ava = await signInClient(base, 'ava.mercer', 'patient-ava-2026');
    const boris = await signInClient(base, 'boris.laine', 'patient-boris-2026');

    // --- Cleo BEFORE the ask: exactly her two prescriptions, correct states
    const list = await httpJson(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(list.status, 200, 'patient list status');
    assert.equal(list.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(list.body.ok, true);
    assert.equal(list.body.role, 'patient');
    assert.deepEqual(
      list.body.prescriptions.map((p) => p.id).sort(),
      [ASK_RX.id, 'denial-rx'].sort(),
      'Cleo sees exactly her own prescriptions'
    );
    const eligibleRow = list.body.prescriptions.find((p) => p.id === ASK_RX.id);
    assert.equal(eligibleRow.state, 'no-renewal', 'eligible zero-refill rx has state no-renewal');
    assert.equal(eligibleRow.refills_remaining, 0, 'the patient sees their own zero refill count');
    assert.equal(eligibleRow.pharmacy_name, 'Dunmore Corner Pharmacy', 'pharmacy label from the durable store');
    assert.equal(eligibleRow.prescriber_name, 'Dr. Emil Hart', 'prescriber label from the durable store');
    assert.equal(eligibleRow.renewal_id, undefined, 'no renewal fields before the ask');
    const ineligibleRow = list.body.prescriptions.find((p) => p.id === 'denial-rx');
    assert.equal(ineligibleRow.state, 'ineligible', 'own rx with refills remaining is ineligible');
    assert.equal(ineligibleRow.refills_remaining, 1, 'own refill count shown');
    // No other patient's prescription appears (ownership predicate over HTTP).
    for (const id of ['ending-a-rx', 'ending-b-rx']) {
      assert.ok(!list.body.prescriptions.some((p) => p.id === id), `Cleo's list excludes ${id}`);
    }

    // --- After Cleo asks: the row flips to pending with renewal details ---
    const created = await httpJson(`${base}/ask`, {
      method: 'POST',
      headers: { Cookie: cleo.cookieHeader },
      body: { prescription_id: ASK_RX.id },
    });
    assert.equal(created.status, 201, 'the ask commits');
    const createdId = created.body.renewal.id;
    const listAfter = await httpJson(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    const pendingRow = listAfter.body.prescriptions.find((p) => p.id === ASK_RX.id);
    assert.equal(pendingRow.state, 'pending', 'the asked rx now has state pending');
    assert.equal(pendingRow.status, STATUS_LABELS.SENT_TO_PHARMACY, 'pending status from the durable record');
    assert.equal(pendingRow.next_actor, 'pharmacy', 'pending next actor from the durable record');
    assert.equal(pendingRow.submitted_at, created.body.renewal.submitted_at, 'submission time from the durable record');
    assert.equal(pendingRow.renewal_id, createdId, 'renewal id from the durable record');
    assert.equal(pendingRow.renewal_case_ref, caseRefFor(createdId), 'stable opaque case ref from the canonical formula');

    // --- Ava: terminal row (final state, disposition fields) -------------
    const avaList = await httpJson(`${base}/prescriptions`, { headers: { Cookie: ava.cookieHeader } });
    assert.equal(avaList.status, 200, 'Ava list status');
    assert.deepEqual(
      avaList.body.prescriptions.map((p) => p.id),
      ['ending-a-rx'],
      'Ava sees exactly her own prescription'
    );
    const finalRow = avaList.body.prescriptions[0];
    assert.equal(finalRow.state, 'final', 'terminal renewal gives state final');
    assert.equal(finalRow.status, STATUS_LABELS.RENEWAL_APPROVED, 'terminal status from the durable record');
    assert.equal(finalRow.decided_at, '2026-11-21T09:00:00Z', 'terminal disposition time');
    assert.equal(finalRow.granted_refills, 1, 'terminal granted refills');
    assert.equal(finalRow.renewal_case_ref, caseRefFor('ending-a-renewal'), 'terminal case ref from the canonical formula');

    // --- Boris: pending fixture row --------------------------------------
    const borisList = await httpJson(`${base}/prescriptions`, { headers: { Cookie: boris.cookieHeader } });
    assert.equal(borisList.status, 200, 'Boris list status');
    assert.deepEqual(borisList.body.prescriptions.map((p) => p.id), ['ending-b-rx'], 'Boris sees exactly his own prescription');
    assert.equal(borisList.body.prescriptions[0].state, 'pending', 'Boris fixture renewal gives state pending');

    const htmlList = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(htmlList.status, 200, 'authorized patient: HTML list status');
    assert.equal(htmlList.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(htmlList.text.includes('<h1>Patient prescriptions</h1>'), 'HTML list has the clear heading');
    assertNoScriptsOrHandlers(htmlList.text, 'HTML list page');
    assertNoPickupReadyHtml(htmlList.text, 'HTML list page');
    // Exactly Cleo's own two prescriptions render, in the store's order
    // (renewal rows first: ASK_RX pending, then denial-rx ineligible).
    const rxRows = rxTableRows(htmlList.text);
    assert.equal(rxRows.length, 2, 'Cleo sees exactly her own two prescriptions in the table');
    // pending row (ASK_RX): the durable values plus a same-origin case link
    // and NO ask form (a pending renewal is never re-asked from the list).
    const htmlPendingRow = rxRows[0];
    assert.equal(htmlPendingRow.length, 5, 'pending row has the five columns');
    assert.equal(htmlPendingRow[0].trim(), 'Dunmore Corner Pharmacy', 'pending row: pharmacy');
    assert.equal(htmlPendingRow[1].trim(), 'Dr. Emil Hart', 'pending row: prescriber');
    assert.equal(htmlPendingRow[2].trim(), '0', 'pending row: saved zero refill count');
    assert.ok(!htmlPendingRow[3].match(/<form/i), 'pending row: state cell carries no form');
    const pendingLink = htmlPendingRow[4].match(/<a href="\/cases\?case=([0-9a-f]{32})">([\s\S]*?)<\/a>/);
    assert.ok(pendingLink, 'pending row: action is a labeled link');
    assert.equal(pendingLink[1], caseRefFor(createdId), 'pending row: case link uses the stable opaque case ref');
    assert.ok(!htmlPendingRow[4].includes('<form'), 'pending row: no ask form');
    // ineligible row (denial-rx): a fixed visible notice, and no form or link.
    const htmlIneligibleRow = rxRows[1];
    assert.equal(htmlIneligibleRow.length, 5, 'ineligible row has the five columns');
    assert.equal(htmlIneligibleRow[0].trim(), 'Dunmore Corner Pharmacy', 'ineligible row: pharmacy');
    assert.equal(htmlIneligibleRow[1].trim(), 'Dr. Emil Hart', 'ineligible row: prescriber');
    assert.equal(htmlIneligibleRow[2].trim(), '1', 'ineligible row: saved one remaining refill');
    assert.ok(
      htmlIneligibleRow[4].includes('This prescription is not eligible for a renewal request.'),
      'ineligible row: fixed visible notice text'
    );
    assert.ok(!htmlIneligibleRow[4].includes('<form'), 'ineligible row: no ask form');
    assert.ok(!htmlIneligibleRow[4].includes('<a '), 'ineligible row: no case link')

    // --- denials: non-patient 403 (HTML + JSON), anonymous 401 (HTML + JSON)
    const dunmore = await signInClient(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const htmlDenied = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(htmlDenied.status, 403, 'pharmacy: HTML 403');
    assertNoCaseDataHtml(htmlDenied.text, 'pharmacy HTML 403 page');
    const jsonDenied = await httpJson(`${base}/prescriptions`, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(jsonDenied.status, 403, 'pharmacy: JSON 403');
    assertNoCaseFields(jsonDenied.body, 'pharmacy JSON 403 body');
    const anonJson = await httpJson(`${base}/prescriptions`);
    assert.equal(anonJson.status, 401, 'anonymous: JSON 401');
    const anonHtml = await fetchHtml(`${base}/prescriptions`);
    assert.equal(anonHtml.status, 401, 'anonymous: HTML 401');
    assertNoCaseDataHtml(anonHtml.text, 'anonymous HTML 401 page');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


// The eligible first-ask target (state 'no-renewal') for Cleo: the fixture
// set gives her only denial-rx (ineligible), so a fresh zero-refill
// prescription with no renewal is seeded for this view check. It is the ONLY
// row kind that may present an ask form.
const ELIGIBLE_RX = Object.freeze({
  id: 'fixture-view-eligible-rx',
  patient_id: 'denial-patient',
  pharmacy_id: 'pharmacy-dunmore',
  prescriber_id: 'denial-prescriber',
});

function seedEligibleRx(dbPath) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(ELIGIBLE_RX.id, ELIGIBLE_RX.patient_id, ELIGIBLE_RX.pharmacy_id, ELIGIBLE_RX.prescriber_id);
  } finally {
    db.close();
  }
}

test('view: the prescriptions page renders a form for no-renewal, a case link for pending/final, and a notice for ineligible (no other affordance is duplicated)', async () => {
  const env = makeEnv('fixture-view');
  let app;
  try {
    seedEligibleRx(env.dbPath);
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // --- Cleo: one no-renewal (ask form) + one ineligible (notice) -------
    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const cleoPage = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(cleoPage.status, 200, 'Cleo prescriptions page status');
    assert.ok(cleoPage.text.includes('<h1>Patient prescriptions</h1>'), 'clear heading');
    assertNoScriptsOrHandlers(cleoPage.text, 'Cleo prescriptions page');
    assertNoPickupReadyHtml(cleoPage.text, 'Cleo prescriptions page');
    const cleoRows = rxTableRows(cleoPage.text);
    assert.equal(cleoRows.length, 2, 'Cleo sees her eligible + ineligible prescriptions');
    // Both of Cleo's rows lack a renewal, so the store orders them by
    // prescription id (denial-rx first, then the eligible zero-refill rx).
    // Select each row by its saved refill count rather than by index so the
    // check is robust to the stable id ordering.
    const eligibleRow = cleoRows.find((r) => r[2].trim() === '0');
    const ineligibleRow = cleoRows.find((r) => r[2].trim() === '1');
    assert.ok(eligibleRow, 'the eligible zero-refill row is present');
    assert.ok(ineligibleRow, 'the ineligible one-refill row is present');
    // Eligible no-renewal — the ONLY ask form, a labeled native POST to /ask
    // carrying her eligible prescription id.
    const eligibleAction = eligibleRow[4];
    const form = askFormIn(eligibleAction);
    assert.ok(form, 'eligible no-renewal row renders the ask form');
    assert.equal(form.attrs.method, 'post', 'ask form is a native POST');
    assert.equal(form.attrs.action, '/ask', 'ask form posts to the /ask route');
    assert.equal(form.attrs['aria-label'], 'Ask my pharmacy', 'ask form carries an accessible name');
    assert.equal(form.prescriptionId, ELIGIBLE_RX.id, 'ask form carries the eligible prescription id');
    assert.ok(!eligibleAction.includes('<a '), 'eligible row: no case link (no renewal yet)');
    assert.equal((eligibleAction.match(/<form/g) ?? []).length, 1, 'eligible row: exactly one form');
    // Ineligible — fixed notice, no form, no link.
    const ineligibleAction = ineligibleRow[4];
    assert.ok(ineligibleAction.includes('This prescription is not eligible for a renewal request.'),
      'ineligible row: fixed visible notice');
    assert.ok(!ineligibleAction.includes('<form'), 'ineligible row: no ask form');
    assert.ok(!ineligibleAction.includes('<a '), 'ineligible row: no case link');
    // The whole page holds exactly ONE ask form (only the eligible row).
    assert.equal((cleoPage.text.match(/<form[^>]*action="\/ask"/g) ?? []).length, 1,
      'Cleo page: exactly one ask form across all rows');

    // --- Ava: one final (terminal) row — case link, NO ask form -----------
    const ava = await signInClient(base, 'ava.mercer', 'patient-ava-2026');
    const avaPage = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: ava.cookieHeader } });
    assert.equal(avaPage.status, 200, 'Ava prescriptions page status');
    const avaRows = rxTableRows(avaPage.text);
    assert.equal(avaRows.length, 1, 'Ava sees her terminal prescription');
    const avaAction = avaRows[0][4];
    const avaLink = avaAction.match(/<a href="\/cases\?case=([0-9a-f]{32})">([\s\S]*?)<\/a>/);
    assert.ok(avaLink, 'final row: action is a labeled same-origin link');
    assert.equal(avaLink[1], caseRefFor('ending-a-renewal'), 'final row: link targets the terminal renewal case ref');
    assert.equal(avaLink[2].trim(), 'View this renewal', 'final row: link has visible text');
    assert.ok(!avaAction.includes('<form'), 'final row: no ask form (no new cycle)');
    assert.equal((avaPage.text.match(/<form[^>]*action="\/ask"/g) ?? []).length, 0, 'Ava page: no ask forms at all');

    // --- Boris: one pending row — case link, NO ask form ------------------
    const boris = await signInClient(base, 'boris.laine', 'patient-boris-2026');
    const borisPage = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: boris.cookieHeader } });
    assert.equal(borisPage.status, 200, 'Boris prescriptions page status');
    const borisRows = rxTableRows(borisPage.text);
    assert.equal(borisRows.length, 1, 'Boris sees his pending prescription');
    const borisAction = borisRows[0][4];
    const borisLink = borisAction.match(/<a href="\/cases\?case=([0-9a-f]{32})">([\s\S]*?)<\/a>/);
    assert.ok(borisLink, 'pending row: action is a labeled same-origin link');
    assert.equal(borisLink[1], caseRefFor('ending-b-renewal'), 'pending row: link targets the pending renewal case ref');
    assert.ok(!borisAction.includes('<form'), 'pending row: no ask form (repeat would be idempotent)');
    assert.equal((borisPage.text.match(/<form[^>]*action="\/ask"/g) ?? []).length, 0, 'Boris page: no ask forms at all');

    // --- the case link resolves to the saved case detail (same origin) ----
    const avaDetail = await fetchHtml(`${base}/cases?case=${avaLink[1]}`, { headers: { Cookie: ava.cookieHeader } });
    assert.equal(avaDetail.status, 200, 'Ava case link resolves to the saved terminal case');
    assert.ok(avaDetail.text.includes(STATUS_LABELS.RENEWAL_APPROVED), 'detail shows the saved terminal status');
    const borisDetail = await fetchHtml(`${base}/cases?case=${borisLink[1]}`, { headers: { Cookie: boris.cookieHeader } });
    assert.equal(borisDetail.status, 200, 'Boris case link resolves to the saved pending case');
    assert.ok(borisDetail.text.includes(STATUS_LABELS.SENT_TO_PHARMACY), 'detail shows the saved pending status');
  } finally {
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});


test('over-HTTP: non-loopback hosts are still rejected before any bind (route changes did not loosen the loopback rule)', async () => {
  const env = makeEnv('loopback');
  try {
    for (const host of ['0.0.0.0', 'localhost', '127.0.0.2']) {
      assert.throws(
        () => startServer({ dbPath: env.dbPath, host, port: 0 }),
        /only the loopback host 127\.0\.0\.1 is permitted/,
        `startServer rejects ${host} synchronously before createServer/listen`
      );
    }
    // The loopback default still works (positive control; closed immediately).
    const app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    assert.equal(app.host, '127.0.0.1', 'loopback bind still permitted');
    assert.ok(app.port > 0, 'ephemeral port bound');
    await app.close();
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});
