import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATUS_LABELS,
  SESSION_COOKIE_NAME,
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
  signIn,
  listRoleCases,
  getRoleCase,
  readMarker,
  writeMarker,
} from '../store.mjs';

// The full set of values that would count as a case-data disclosure in a
// denial result. Every string/number below appears in the saved fixture
// state; if ANY of them appears in a denial's serialization, the denial has
// disclosed case data.
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

function assertNoCaseData(result, label) {
  const serialized = JSON.stringify(result);
  for (const token of CASE_DATA_TOKENS) {
    assert.ok(
      !serialized.includes(token),
      `${label}: denial result must not disclose case data (found ${JSON.stringify(token)} in ${serialized})`
    );
  }
}

function makeCaseViewExpectations() {
  return {
    endA: {
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
    },
    endB: {
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
    },
  };
}

function assertCaseView(actual, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(actual[field], value, `${label}: case field ${field}`);
  }
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
    `${label}: no extra or missing case fields`
  );
}

function snapshotDurableState(db) {
  // Scalar-only snapshot of the durable data (never raw SQLite rows).
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

function assertDurableStateUnchanged(db, before, label) {
  const snapshot = (table, orderExpr) =>
    db
      .prepare(`SELECT * FROM ${table} ORDER BY ${orderExpr}`)
      .all()
      .map((r) => Object.values(r));
  assert.deepEqual(snapshot('markers', 'key'), before.markers, `${label}: markers unchanged`);
  assert.deepEqual(snapshot('identities', 'id'), before.identities, `${label}: identities unchanged`);
  assert.deepEqual(snapshot('prescriptions', 'id'), before.prescriptions, `${label}: prescriptions unchanged`);
  assert.deepEqual(snapshot('renewals', 'id'), before.renewals, `${label}: renewals (case state) unchanged`);
  for (const [table, order] of [
    ['renewal_events', 'id'],
    ['pharmacy_conversation_messages', 'id'],
    ['office_messages', 'id'],
    ['phone_notes', 'id'],
    ['sessions', 'token'],
    ['synthetic_accounts', 'username'],
  ]) {
    assert.deepEqual(
      snapshot(table, order),
      before[table],
      `${label}: ${table} unchanged`
    );
  }
}

function freshFixtureDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-fixture-${tag}-`));
  const dbPath = join(dir, 'fixture.sqlite');
  const db = initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  writeMarkerGuard(dbPath);
  return { dir, dbPath, db };
}

function writeMarkerGuard(dbPath) {
  writeMarker(dbPath, 'fixture-authorization-marker');
}

test('authorization: authorized patient reads only their own renewal (list and copied-link detail)', () => {
  const { dir, dbPath, db } = freshFixtureDb('patient');
  try {
    const res = signIn(dbPath, 'ava.mercer', 'patient-ava-2026');
    assert.equal(res.status, 200, 'ava.mercer signs in');
    const identity = res.body.identity;
    assert.equal(identity.role, 'patient');

    // Role list: exactly the patient's own renewal, nothing else.
    const list = listRoleCases(dbPath, identity);
    assert.equal(list.ok, true);
    assert.equal(list.role, 'patient');
    assert.equal(list.cases.length, 1, 'patient sees exactly one renewal');
    assertCaseView(list.cases[0], makeCaseViewExpectations().endA, 'patient list');

    // Copied-link detail read of their own record: same authoritative state.
    const detail = getRoleCase(dbPath, 'ending-a-renewal', identity);
    assert.equal(detail.ok, true, 'own record detail is authorized');
    assertCaseView(detail.case, list.cases[0], 'patient detail matches list');

    // A different patient's own record is denied with no case data.
    const foreign = getRoleCase(dbPath, 'ending-b-renewal', identity);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, 'not-authorized');
    assertNoCaseData(foreign, 'patient foreign-record denial');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization: authorized pharmacy reads only renewals assigned to it (list and detail)', () => {
  const { dir, dbPath, db } = freshFixtureDb('pharmacy');
  try {
    const res = signIn(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(res.status, 200, 'pharmacy.cedar signs in');
    const identity = res.body.identity;
    assert.equal(identity.role, 'pharmacy');

    // Role list: both renewals are assigned to pharmacy-cedar — exactly two,
    // in stable submitted_at order.
    const list = listRoleCases(dbPath, identity);
    assert.equal(list.ok, true);
    assert.equal(list.cases.length, 2, 'responsible pharmacy sees both assigned renewals');
    const expected = makeCaseViewExpectations();
    assertCaseView(list.cases[0], expected.endA, 'pharmacy list first');
    assertCaseView(list.cases[1], expected.endB, 'pharmacy list second');

    // Copied-link detail reads of both assigned records are authorized.
    const detailA = getRoleCase(dbPath, 'ending-a-renewal', identity);
    assert.equal(detailA.ok, true);
    assert.equal(detailA.case.id, 'ending-a-renewal');
    assert.equal(detailA.case.status, STATUS_LABELS.RENEWAL_APPROVED);

    const detailB = getRoleCase(dbPath, 'ending-b-renewal', identity);
    assert.equal(detailB.ok, true);
    assert.equal(detailB.case.id, 'ending-b-renewal');
    assert.equal(detailB.case.status, STATUS_LABELS.SENT_TO_PHARMACY);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization: authorized prescriber reads only renewals assigned to them (list and detail)', () => {
  const { dir, dbPath, db } = freshFixtureDb('prescriber');
  try {
    const res = signIn(dbPath, 'dr.priya.raman', 'prescriber-priya-2026');
    assert.equal(res.status, 200, 'dr.priya.raman signs in');
    const identity = res.body.identity;
    assert.equal(identity.role, 'prescriber');

    // Role list: exactly the prescriber's assigned renewal.
    const list = listRoleCases(dbPath, identity);
    assert.equal(list.ok, true);
    assert.equal(list.cases.length, 1, 'assigned prescriber sees exactly one renewal');
    assertCaseView(list.cases[0], makeCaseViewExpectations().endB, 'prescriber list');

    // Copied-link detail read of their assigned record.
    const detail = getRoleCase(dbPath, 'ending-b-renewal', identity);
    assert.equal(detail.ok, true);
    assertCaseView(detail.case, list.cases[0], 'prescriber detail matches list');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization: unrelated patient, pharmacy, and prescriber are denied with no case data (list and record)', () => {
  const { dir, dbPath, db } = freshFixtureDb('denial');
  try {
    // Identities with NO assigned renewal records: the role list is an
    // empty authorized read (no leak), and every fixture record denies.
    const unrelated = [
      ['cleo.voss', 'patient-cleo-2026', 'patient', 'denial-patient'],
      ['pharmacy.dunmore', 'pharmacy-dunmore-2026', 'pharmacy', 'pharmacy-dunmore'],
      ['dr.emil.hart', 'prescriber-emil-2026', 'prescriber', 'denial-prescriber'],
    ];
    for (const [username, password, expectedRole, expectedIdentityId] of unrelated) {
      const res = signIn(dbPath, username, password);
      assert.equal(res.status, 200, `${username} signs in`);
      assert.equal(res.body.identity.role, expectedRole);
      assert.equal(res.body.identity.id, expectedIdentityId);
      const identity = res.body.identity;

      // Role list: the unrelated identity has zero assigned records — an
      // EMPTY authorized list is the correct read answer, not a leak.
      const list = listRoleCases(dbPath, identity);
      assert.equal(list.ok, true, `${username}: an empty list is a valid authorized read`);
      assert.deepEqual(list.cases, [], `${username}: empty list leaks no cases`);

      // Copied-link detail reads of BOTH fixture renewals are denied for an
      // unrelated identity, with a fixed reason and no case data.
      for (const renewalId of ['ending-a-renewal', 'ending-b-renewal']) {
        const detail = getRoleCase(dbPath, renewalId, identity);
        assert.equal(detail.ok, false, `${username}: ${renewalId} denied`);
        assert.equal(detail.reason, 'not-authorized', `${username}: fixed denial reason`);
        assertNoCaseData(detail, `${username} ${renewalId} denial`);
      }
    }

    // Ownership isolation between the two patients: each patient sees
    // EXACTLY their own record in the list, and the other patient's record
    // denies with no case data.
    const expected = makeCaseViewExpectations();
    const ava = signIn(dbPath, 'ava.mercer', 'patient-ava-2026');
    const avaList = listRoleCases(dbPath, ava.body.identity);
    assert.equal(avaList.cases.length, 1, 'ava sees exactly her own renewal');
    assertCaseView(avaList.cases[0], expected.endA, 'ava list');
    const avaForeign = getRoleCase(dbPath, 'ending-b-renewal', ava.body.identity);
    assert.equal(avaForeign.ok, false);
    assert.equal(avaForeign.reason, 'not-authorized');
    assertNoCaseData(avaForeign, 'ava foreign-record denial');

    const boris = signIn(dbPath, 'boris.laine', 'patient-boris-2026');
    const borisList = listRoleCases(dbPath, boris.body.identity);
    assert.equal(borisList.cases.length, 1, 'boris sees exactly his own renewal');
    assertCaseView(borisList.cases[0], expected.endB, 'boris list');
    const borisForeign = getRoleCase(dbPath, 'ending-a-renewal', boris.body.identity);
    assert.equal(borisForeign.ok, false);
    assert.equal(borisForeign.reason, 'not-authorized');
    assertNoCaseData(borisForeign, 'boris foreign-record denial');

    // Cross-role checks on the same records: the other prescriber's record
    // and the unrelated pharmacy's view of both assigned records deny.
    const naomi = signIn(dbPath, 'dr.naomi.okafor', 'prescriber-naomi-2026');
    assert.equal(getRoleCase(dbPath, 'ending-b-renewal', naomi.body.identity).reason, 'not-authorized');
    const dunmore = signIn(dbPath, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    for (const renewalId of ['ending-a-renewal', 'ending-b-renewal']) {
      assert.equal(
        getRoleCase(dbPath, renewalId, dunmore.body.identity).reason,
        'not-authorized',
        `unrelated pharmacy denied on ${renewalId}`
      );
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization: unknown record id denies opaquely with no case data (no existence disclosure)', () => {
  const { dir, dbPath, db } = freshFixtureDb('unknown');
  try {
    const res = signIn(dbPath, 'boris.laine', 'patient-boris-2026');
    const identity = res.body.identity;
    // An unknown id cannot reveal whether a record with that id exists: the
    // denial reason and body are identical to a denied foreign record.
    const detail = getRoleCase(dbPath, 'no-such-renewal', identity);
    assert.equal(detail.ok, false);
    assert.equal(detail.reason, 'not-authorized', 'opaque denial reason, same as foreign-record denial');
    assertNoCaseData(detail, 'unknown-record denial');

    // For an unrelated identity, a real id and an unknown id produce the
    // byte-identical denial: no existence disclosure.
    const cleo = signIn(dbPath, 'cleo.voss', 'patient-cleo-2026');
    const realId = getRoleCase(dbPath, 'ending-a-renewal', cleo.body.identity);
    const unknownId = getRoleCase(dbPath, 'no-such-renewal', cleo.body.identity);
    assert.equal(realId.ok, false);
    assert.equal(unknownId.ok, false);
    assert.equal(realId.reason, 'not-authorized');
    assert.equal(unknownId.reason, 'not-authorized');
    assert.equal(JSON.stringify(realId), JSON.stringify(unknownId),
      'an unrelated identity cannot distinguish a real id from an unknown one');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization: missing or unknown role identities deny with no case data', () => {
  const { dir, dbPath, db } = freshFixtureDb('norole');
  try {
    for (const identity of [null, undefined, {}, { id: 'ending-a-patient' }, { id: 'ending-a-patient', role: 'nurse' }]) {
      const list = listRoleCases(dbPath, identity);
      assert.equal(list.ok, false);
      assert.equal(list.reason, 'unknown-role', `list denial for ${JSON.stringify(identity)}`);
      assertNoCaseData(list, `list denial for ${JSON.stringify(identity)}`);

      const detail = getRoleCase(dbPath, 'ending-a-renewal', identity);
      assert.equal(detail.ok, false);
      assert.equal(detail.reason, 'unknown-role', `detail denial for ${JSON.stringify(identity)}`);
      assertNoCaseData(detail, `detail denial for ${JSON.stringify(identity)}`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization: denials and authorized reads make no durable-state change (before/after, restart, and session growth from sign-in only)', () => {
  const ctx = freshFixtureDb('state');
  const dir = ctx.dir;
  const dbPath = ctx.dbPath;
  let db = ctx.db;
  try {
    // Sign in all seven identities that will be used (this is the ONLY
    // durable write before the authorization section).
    const signIns = [
      signIn(dbPath, 'ava.mercer', 'patient-ava-2026'),
      signIn(dbPath, 'boris.laine', 'patient-boris-2026'),
      signIn(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026'),
      signIn(dbPath, 'pharmacy.dunmore', 'pharmacy-dunmore-2026'),
      signIn(dbPath, 'dr.naomi.okafor', 'prescriber-naomi-2026'),
      signIn(dbPath, 'dr.priya.raman', 'prescriber-priya-2026'),
      signIn(dbPath, 'dr.emil.hart', 'prescriber-emil-2026'),
    ];
    for (const s of signIns) assert.equal(s.status, 200, 'sign-in succeeds');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      7,
      'seven committed sessions before the authorization section'
    );

    // Durable-state capture AFTER sign-in (the task's sign-in reference
    // point): identities, prescriptions, case state, sessions, accounts,
    // and the empty workflow tables.
    const before = snapshotDurableState(db);
    assert.equal(before.sessions.length, 7, 'captured sign-in reference includes the seven sessions');
    assert.equal(before.renewals.length, 2, 'captured reference includes both fixture renewals');
    assert.equal(before.renewal_events.length, 0, 'workflow tables are empty at capture');

    // The authorization section: authorized reads + denials only.
    const identities = signIns.map((s) => s.body.identity);
    const denials = [];
    for (const identity of identities) {
      const list = listRoleCases(dbPath, identity);
      assert.equal(list.ok, true, 'list read for a known role is an authorized read');
      for (const renewalId of ['ending-a-renewal', 'ending-b-renewal', 'no-such-renewal']) {
        const detail = getRoleCase(dbPath, renewalId, identity);
        if (!detail.ok) denials.push(detail);
      }
    }
    assert.ok(denials.length >= 12, 'the section exercised multiple unrelated-identity denials');
    for (const denial of denials) assertNoCaseData(denial, 'in-loop denial');

    // Same connection: durable data after denials equals after sign-in.
    assertDurableStateUnchanged(db, before, 'same connection, after authorization section');

    // Restart: close everything and reopen a brand-new connection; the
    // durable data still matches the sign-in reference exactly.
    db.close();
    db = null;
    const reopened = initDatabase(dbPath);
    try {
      assertDurableStateUnchanged(reopened, before, 'after restart, after authorization section');
      assert.equal(
        readMarker(dbPath),
        'fixture-authorization-marker',
        'marker unchanged by authorization reads'
      );
      // Every signed-in session still resolves after the denials: the
      // denial path did not touch the sessions table.
      for (const s of signIns) {
        const row = reopened.prepare(`SELECT identity_id FROM sessions WHERE token = ?`).get(s.cookie.value);
        assert.equal(row.identity_id, s.body.identity.id, 'session row intact after denials');
      }
    } finally {
      reopened.close();
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
