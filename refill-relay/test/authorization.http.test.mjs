import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE_NAME,
  STATUS_LABELS,
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
  writeMarker,
} from '../store.mjs';
import { startServer } from '../server.mjs';

// Case-data disclosure tokens: any fixture value appearing in a denial
// response body means case data was disclosed.
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
      `${label}: denial body must contain no case fields (found ${JSON.stringify(token)} in ${serialized})`
    );
  }
}

function snapshotDurableState(db) {
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
}

function assertDurableStateEqual(a, b, label) {
  for (const table of Object.keys(a)) {
    assert.deepEqual(b[table], a[table], `${label}: durable table ${table} unchanged`);
  }
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  // Connection: close on every request: no socket reuse across server
  // restarts in the tests (the restarted server binds the same ephemeral
  // port, and a pooled keep-alive socket would still point at the old
  // closed server). Each request opens a fresh loopback connection.
  const res = await fetch(url, {
    method,
    headers: {
      Connection: 'close',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, raw: text };
}

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
  for (const attribute of ['HttpOnly', 'SameSite=Lax']) {
    assert.ok(
      sessionCookie.includes(attribute),
      `${username}: cookie carries ${attribute}`
    );
  }
  return {
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
    token,
    identity: res.body.identity,
  };
}

async function signOutClient(base, cookieHeader) {
  const res = await httpJson(`${base}/sign-out`, { method: 'POST', headers: { Cookie: cookieHeader } });
  assert.equal(res.status, 200);
  assert.equal(res.body.invalidated, true);
  return res;
}

function makeEnv(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-fixture-http-${tag}-`));
  const dbPath = join(dir, 'fixture-http.sqlite');
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  writeMarker(dbPath, 'fixture-http-authorization-marker');
  const db = initDatabase(dbPath);
  return { dir, dbPath, db };
}

const CASE_A = {
  id: 'ending-a-renewal',
  prescription_id: 'ending-a-rx',
  patient_id: 'ending-a-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-a-prescriber',
  status: STATUS_LABELS.RENEWAL_APPROVED,
  next_actor: 'pharmacy',
  submitted_at: '2026-11-21T08:00:00Z',
  handoff_at: '2026-11-21T08:30:00Z',
  decided_at: '2026-11-21T09:00:00Z',
  granted_refills: 1,
  patient_name: 'Ava Mercer',
  pharmacy_name: 'Cedar Crossing Pharmacy',
  prescriber_name: 'Dr. Naomi Okafor',
};

const CASE_B = {
  id: 'ending-b-renewal',
  prescription_id: 'ending-b-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
  status: STATUS_LABELS.SENT_TO_PHARMACY,
  next_actor: 'pharmacy',
  submitted_at: '2026-11-21T10:00:00Z',
  handoff_at: null,
  decided_at: null,
  granted_refills: null,
  patient_name: 'Boris Laine',
  pharmacy_name: 'Cedar Crossing Pharmacy',
  prescriber_name: 'Dr. Priya Raman',
};

function assertCaseFields(actual, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(actual[field], value, `${label}: case field ${field}`);
  }
}

test('over-HTTP: server binds 127.0.0.1 only on an ephemeral port and serves the JSON API', async () => {
  const env = makeEnv('bind');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    assert.equal(app.host, '127.0.0.1', 'bound host is loopback only');
    assert.ok(app.port > 0, 'bound to an ephemeral port');
    const base = `http://127.0.0.1:${app.port}`;

    const root = await httpJson(`${base}/`);
    assert.equal(root.status, 200);
    assert.deepEqual(root.body, { ok: true, signed_in: false, identity: null });

    const unknown = await httpJson(`${base}/no-such-route`);
    assert.equal(unknown.status, 404, 'unknown route is a fixed 404 with no case data');
    assertNoCaseFields(unknown.body, 'unknown-route body');

    // An unauthenticated copied link is denied with the fixed 401 body.
    const link = await httpJson(`${base}/cases?id=${CASE_B.id}`);
    assert.equal(link.status, 401);
    assert.equal(link.body.error, 'no-session');
    assertNoCaseFields(link.body, 'unauthenticated copied-link denial');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('over-HTTP: authorized patient, pharmacy, and prescriber reads return the saved authoritative state', async () => {
  const env = makeEnv('authorized');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // --- patient: owns exactly ending-a-renewal -------------------------
    const patient = await signInClient(base, 'ava.mercer', 'patient-ava-2026');
    assert.equal(patient.identity.role, 'patient');
    let res = await httpJson(`${base}/cases`, { headers: { Cookie: patient.cookieHeader } });
    assert.equal(res.status, 200, 'patient queue status');
    assert.equal(res.body.role, 'patient');
    assert.equal(res.body.cases.length, 1, 'patient queue has exactly one saved renewal');
    assertCaseFields(res.body.cases[0], CASE_A, 'patient queue');

    res = await httpJson(`${base}/cases?id=${CASE_A.id}`, { headers: { Cookie: patient.cookieHeader } });
    assert.equal(res.status, 200, 'patient copied-link detail status');
    assertCaseFields(res.body.case, CASE_A, 'patient detail');
    res = await httpJson(`${base}/case/${CASE_A.id}`, { headers: { Cookie: patient.cookieHeader } });
    assert.equal(res.status, 200, 'patient path-form copied link status');
    assertCaseFields(res.body.case, CASE_A, 'patient path-form detail');

    // --- pharmacy: assigned exactly ending-a + ending-b -----------------
    const pharmacy = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(pharmacy.identity.role, 'pharmacy');
    res = await httpJson(`${base}/cases`, { headers: { Cookie: pharmacy.cookieHeader } });
    assert.equal(res.status, 200, 'pharmacy queue status');
    assert.equal(res.body.role, 'pharmacy');
    assert.equal(res.body.cases.length, 2, 'pharmacy queue has exactly the two assigned renewals');
    assertCaseFields(res.body.cases[0], CASE_A, 'pharmacy queue first');
    assertCaseFields(res.body.cases[1], CASE_B, 'pharmacy queue second');
    for (const c of [CASE_A, CASE_B]) {
      res = await httpJson(`${base}/cases?id=${c.id}`, { headers: { Cookie: pharmacy.cookieHeader } });
      assert.equal(res.status, 200, `pharmacy detail ${c.id} status`);
      assertCaseFields(res.body.case, c, `pharmacy detail ${c.id}`);
    }

    // --- prescriber: assigned exactly ending-b-renewal ------------------
    const prescriber = await signInClient(base, 'dr.priya.raman', 'prescriber-priya-2026');
    assert.equal(prescriber.identity.role, 'prescriber');
    res = await httpJson(`${base}/cases`, { headers: { Cookie: prescriber.cookieHeader } });
    assert.equal(res.status, 200, 'prescriber queue status');
    assert.equal(res.body.role, 'prescriber');
    assert.equal(res.body.cases.length, 1, 'prescriber queue has exactly one assigned renewal');
    assertCaseFields(res.body.cases[0], CASE_B, 'prescriber queue');
    res = await httpJson(`${base}/cases?id=${CASE_B.id}`, { headers: { Cookie: prescriber.cookieHeader } });
    assert.equal(res.status, 200, 'prescriber copied-link detail status');
    assertCaseFields(res.body.case, CASE_B, 'prescriber detail');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('over-HTTP: copied case link is independently reauthorized on every reuse (signed in, re-signed-in, server restart; signed out denies)', async () => {
  const env = makeEnv('reauth');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const firstPort = app.port;
    const base = `http://127.0.0.1:${app.port}`;
    // The copied link: a bare record reference with no session data.
    const copiedLink = `${base}/cases?id=${CASE_B.id}`;

    // 1) First sign-in; the copied link resolves to the saved state.
    const first = await signInClient(base, 'boris.laine', 'patient-boris-2026');
    let res = await httpJson(copiedLink, { headers: { Cookie: first.cookieHeader } });
    assert.equal(res.status, 200, 'copied link while signed in');
    assertCaseFields(res.body.case, CASE_B, 'first use');
    const firstState = res.body.case;

    // 2) Sign-out invalidates the server-side session; the SAME copied link
    //    now denies with the fixed 401 body (no case data).
    await signOutClient(base, first.cookieHeader);
    res = await httpJson(copiedLink, { headers: { Cookie: first.cookieHeader } });
    assert.equal(res.status, 401, 'invalidated session denied on the copied link');
    assert.equal(res.body.error, 'no-session');
    assertNoCaseFields(res.body, 'invalidated-session denial');

    // 3) Re-sign-in: an INDEPENDENT new session token. The server
    //    re-derives identity and role from the durable session store on the
    //    reused link — the link itself carries no authority.
    const second = await signInClient(base, 'boris.laine', 'patient-boris-2026');
    assert.notEqual(second.token, first.token, 're-sign-in issues an independent session token');
    res = await httpJson(copiedLink, { headers: { Cookie: second.cookieHeader } });
    assert.equal(res.status, 200, 'copied link after re-sign-in');
    assert.deepEqual(res.body.case, firstState, 'same authoritative saved state after re-sign-in');

    // Durable state after this (re-)sign-in: the reference point for the
    // restart comparison (no further writes happen in this test).
    const afterResign = snapshotDurableState(env.db);
    assert.equal(afterResign.sessions.length, 1, 'exactly one committed session after re-sign-in');

    // 4) Server process restart against the same database file: a brand-new
    //    server instance (rebound to the same ephemeral port, so the copied
    //    link URL is the same literal string) must reauthorize the SAME
    //    copied link from the durable session store.
    await app.close();
    app = null;
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort });
    assert.equal(app.port, firstPort, 'restart rebinds the same ephemeral port for the copied link');
    res = await httpJson(copiedLink, { headers: { Cookie: second.cookieHeader } });
    assert.equal(res.status, 200, 'copied link after server restart');
    assert.deepEqual(res.body.case, firstState, 'same authoritative saved state after server restart');

    // The invalidated token from before the restart is still dead.
    res = await httpJson(copiedLink, { headers: { Cookie: first.cookieHeader } });
    assert.equal(res.status, 401, 'pre-restart invalidated token still denied');

    // No write happened across the restart: durable data after the restart
    // equals the post-re-sign-in reference exactly (sessions included).
    const afterRestart = snapshotDurableState(env.db);
    assertDurableStateEqual(afterResign, afterRestart, 'restart makes no durable-state change');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('over-HTTP: unrelated identities are denied with no case fields, and durable data after sign-in equals durable data after denial (sessions, fixtures, case state)', async () => {
  const env = makeEnv('denial');
  let app;
  let db = env.db;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // The unrelated identities for the denial section: the other patient,
    // the unrelated pharmacy, and the unrelated prescriber.
    const cleo = await signInClient(base, 'cleo.voss', 'patient-cleo-2026');
    const dunmore = await signInClient(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const emil = await signInClient(base, 'dr.emil.hart', 'prescriber-emil-2026');
    assert.equal(cleo.identity.role, 'patient');
    assert.equal(dunmore.identity.role, 'pharmacy');
    assert.equal(emil.identity.role, 'prescriber');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      3,
      'three committed sessions after sign-in'
    );

    // Durable data AFTER sign-in (the sign-in reference point): sessions,
    // fixtures/identities, prescriptions, case state (renewals), accounts,
    // workflow tables, and the marker.
    const afterSignIn = snapshotDurableState(db);
    assert.equal(afterSignIn.sessions.length, 3, 'reference includes the three sign-in sessions');
    assert.equal(afterSignIn.renewals.length, 2, 'reference includes both fixture renewals');
    assert.equal(afterSignIn.identities.length, 8, 'reference includes all fixture identities');
    assert.equal(afterSignIn.prescriptions.length, 3, 'reference includes all fixture prescriptions');

    // The denial section: copied case links and role views reused by
    // unrelated identities, plus unauthenticated probes.
    const denialRequests = [
      // Unrelated patient: both fixture case links + her own role view.
      ['patient-cleo', cleo.cookieHeader, `${base}/cases?id=${CASE_A.id}`],
      ['patient-cleo', cleo.cookieHeader, `${base}/cases?id=${CASE_B.id}`],
      // Unrelated pharmacy: both fixture case links + its own role view.
      ['pharmacy-dunmore', dunmore.cookieHeader, `${base}/cases?id=${CASE_A.id}`],
      ['pharmacy-dunmore', dunmore.cookieHeader, `${base}/cases?id=${CASE_B.id}`],
      // Unrelated prescriber: both fixture case links + his own role view.
      ['prescriber-emil', emil.cookieHeader, `${base}/cases?id=${CASE_A.id}`],
      ['prescriber-emil', emil.cookieHeader, `${base}/cases?id=${CASE_B.id}`],
    ];
    const denialBodies = [];
    for (const [label, cookieHeader, url] of denialRequests) {
      const res = await httpJson(url, { headers: { Cookie: cookieHeader } });
      assert.equal(res.status, 403, `${label}: copied-link denial status`);
      assert.equal(res.body.ok, false, `${label}: denial ok flag`);
      assert.equal(res.body.error, 'forbidden', `${label}: fixed error kind`);
      assert.equal(res.body.reason, 'not-authorized', `${label}: fixed denial reason`);
      assertNoCaseFields(res.body, `${label} denial body`);
      denialBodies.push(res.body);
    }

    // The unrelated identities' own role views are authorized EMPTY reads
    // (no leak, not a denial), and an unauthenticated request gets 401.
    for (const [label, client] of [['patient-cleo', cleo], ['pharmacy-dunmore', dunmore], ['prescriber-emil', emil]]) {
      const res = await httpJson(`${base}/cases`, { headers: { Cookie: client.cookieHeader } });
      assert.equal(res.status, 200, `${label}: role view is an authorized read`);
      assert.deepEqual(res.body.cases, [], `${label}: empty role view leaks no cases`);
      assertNoCaseFields(res.body, `${label} empty role view`);
    }
    const anon = await httpJson(`${base}/cases?id=${CASE_B.id}`);
    assert.equal(anon.status, 401, 'unauthenticated copied link denied');
    assertNoCaseFields(anon.body, 'unauthenticated denial body');

    // An id probe by an unrelated identity cannot distinguish a real id
    // from an unknown id: byte-identical opaque denials.
    const realId = await httpJson(`${base}/cases?id=${CASE_A.id}`, { headers: { Cookie: cleo.cookieHeader } });
    const unknownId = await httpJson(`${base}/cases?id=no-such-renewal`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(unknownId.status, 403);
    assert.equal(JSON.stringify(realId.body), JSON.stringify(unknownId.body), 'no record existence disclosure');

    // Durable data AFTER the denial section: must equal the after-sign-in
    // reference exactly — no session row added or removed, no fixture or
    // case-state change, no workflow row, marker untouched.
    const afterDenial = snapshotDurableState(db);
    assertDurableStateEqual(afterSignIn, afterDenial, 'denial section makes no durable-state change');

    // All denial bodies are the same fixed shape (no per-record variation).
    for (const body of denialBodies) {
      assert.deepEqual(
        Object.keys(body).sort(),
        ['error', 'message', 'ok', 'reason'],
        'denial body carries only the fixed fields'
      );
    }

    // Cross-connection reread (simulated restart): the after-denial state
    // is still exactly the after-sign-in reference.
    db.close();
    db = null;
    const reopened = initDatabase(env.dbPath);
    try {
      assertDurableStateEqual(afterSignIn, snapshotDurableState(reopened), 'restart: state after denial still equals state after sign-in');
      assert.equal(
        reopened.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
        3,
        'exactly the three sign-in sessions remain'
      );
      const caseRow = reopened.prepare(`SELECT status, next_actor FROM renewals WHERE id = ?`).get(CASE_B.id);
      assert.deepEqual(
        { status: caseRow.status, next_actor: caseRow.next_actor },
        { status: STATUS_LABELS.SENT_TO_PHARMACY, next_actor: 'pharmacy' },
        'case state (status, next actor) unchanged by denials'
      );
    } finally {
      reopened.close();
      db = null;
    }
  } finally {
    db?.close();
    await app?.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('over-HTTP: sign-in and session semantics are preserved (invalid credentials, unknown route, no partial session)', async () => {
  const env = makeEnv('semantics');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // Wrong password over HTTP: clear invalid-credentials, NO Set-Cookie.
    const wrong = await httpJson(`${base}/sign-in`, {
      method: 'POST',
      body: { username: 'ava.mercer', password: 'not-the-password' },
    });
    assert.equal(wrong.status, 401, 'wrong password status over HTTP');
    assert.equal(wrong.body.error, 'invalid-credentials');
    assert.equal(wrong.headers.get('set-cookie'), null, 'no cookie on invalid credentials');
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n, 0, 'no session row');

    // Unknown username: same recoverable feedback.
    const unknownUser = await httpJson(`${base}/sign-in`, {
      method: 'POST',
      body: { username: 'mallory', password: 'whatever' },
    });
    assert.equal(unknownUser.status, 401);
    assert.equal(unknownUser.body.error, 'invalid-credentials');

    const ok = await signInClient(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const valid = await httpJson(`${base}/session`, { headers: { Cookie: ok.cookieHeader } });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.identity.id, 'pharmacy-cedar');
    assert.equal(valid.body.identity.role, 'pharmacy');
    const none = await httpJson(`${base}/session`);
    assert.equal(none.status, 401);
    assert.equal(none.body.error, 'no-session');

    // Sign-out over HTTP invalidates the server-side session.
    await signOutClient(base, ok.cookieHeader);
    const dead = await httpJson(`${base}/session`, { headers: { Cookie: ok.cookieHeader } });
    assert.equal(dead.status, 401, 'invalidated cookie stops resolving');
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n, 0, 'session row deleted');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
