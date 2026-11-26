import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  STATUS_LABELS,
  caseRefFor,
  PATIENT_PRESCRIPTION_STATES,
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
  signIn,
  askPatientForRenewal,
  listPatientPrescriptions,
} from '../store.mjs';

// --- helpers ---------------------------------------------------------------

function freshDb(label) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-${label}-`));
  const dbPath = join(dir, `${label}.sqlite`);
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
}

function identityFor(dbPath, username, password) {
  const res = signIn(dbPath, username, password);
  assert.equal(res.status, 200, `sign-in ${username} succeeds`);
  return res.body.identity;
}

// Scalar-only snapshot of every data table (normalized to arrays of scalar
// values, never raw SQLite rows) for before/after durable-state equality.
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
    assert.deepEqual(
      after[table],
      before[table],
      `${label}: table ${table} unchanged`
    );
  }
}

// Values whose appearance in a denial's serialization would count as a
// case-data disclosure (fixture ids, names, statuses, timestamps).
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

const ELIGIBLE_RX = Object.freeze({
  id: 'fixture-eligible-rx',
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

function insertRenewal(dbPath, spec) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO renewals
         (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
          status, next_actor, submitted_at, handoff_at, decided_at,
          granted_refills, request_idempotency_key, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
    ).run(
      spec.id, spec.prescription_id, spec.patient_id, spec.pharmacy_id,
      spec.prescriber_id, spec.status, spec.next_actor ?? null,
      spec.submitted_at, spec.handoff_at ?? null, spec.decided_at ?? null,
      spec.granted_refills ?? null
    );
  } finally {
    db.close();
  }
}

// The independent re-implementation of the historical server formula:
// sha256("rfrl-case-ref-v1:" + renewalId) truncated to 32 lowercase hex.
// Used to prove the store's caseRefFor (and therefore the per-row
// renewal_case_ref) is byte-compatible with the pre-existing server.
function legacyServerCaseRef(renewalId) {
  return createHash('sha256').update(`rfrl-case-ref-v1:${renewalId}`).digest('hex').slice(0, 32);
}

const byId = (rows) => new Map(rows.map((r) => [r.id, r]));

// --- tests ------------------------------------------------------------------

test('ownership: each patient sees exactly their own prescriptions and nothing else; one row per prescription; empty list for a patient with none', () => {
  const { dir, dbPath } = freshDb('fixture-ownership');
  try {
    // A patient identity with no prescriptions at all (schema only — the
    // fixture set gives every seeded patient one).
    const db = initDatabase(dbPath);
    db.prepare(
      `INSERT INTO identities (id, role, display_name, is_synthetic)
       VALUES ('fixture-bare-patient', 'patient', 'No Rx Patient', 1)`
    );
    db.close();

    // Ava owns only ending-a-rx; Boris only ending-b-rx; Cleo only
    // denial-rx. No prescription row may cross ownership.
    const ava = listPatientPrescriptions(dbPath, { id: 'ending-a-patient', role: 'patient' });
    assert.equal(ava.ok, true, 'ava list ok');
    assert.equal(ava.role, 'patient', 'ava list role');
    assert.deepEqual(
      ava.prescriptions.map((r) => r.id),
      ['ending-a-rx'],
      'ava sees exactly her own prescription'
    );

    const boris = listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    assert.deepEqual(
      boris.prescriptions.map((r) => r.id),
      ['ending-b-rx'],
      'boris sees exactly his own prescription'
    );

    const cleo = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    assert.deepEqual(
      cleo.prescriptions.map((r) => r.id),
      ['denial-rx'],
      'cleo sees exactly her own prescription'
    );

    // The bare patient gets an empty (successful) list — no disclosure of
    // who else has prescriptions.
    const bare = listPatientPrescriptions(dbPath, { id: 'fixture-bare-patient', role: 'patient' });
    assert.equal(bare.ok, true, 'bare patient list ok');
    assert.deepEqual(bare.prescriptions, [], 'bare patient sees no prescriptions');

    // An unknown patient id (role patient) also yields an empty list: the
    // ownership predicate is the enforcement; no error, no disclosure.
    const unknown = listPatientPrescriptions(dbPath, { id: 'no-such-patient', role: 'patient' });
    assert.equal(unknown.ok, true, 'unknown patient id list ok');
    assert.deepEqual(unknown.prescriptions, [], 'unknown patient id sees nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state derivation: pending, final, no-renewal, and ineligible are all derived server-side from the durable rows', () => {
  const { dir, dbPath } = freshDb('fixture-state');
  try {
    seedEligibleRx(dbPath);

    // Ending A: terminal 'Renewal approved' renewal -> 'final'.
    const ava = listPatientPrescriptions(dbPath, { id: 'ending-a-patient', role: 'patient' });
    const a = ava.prescriptions[0];
    assert.equal(a.state, 'final', 'ending A derives final');

    // Ending B: non-final 'Sent to pharmacy' renewal -> 'pending'.
    const boris = listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    const b = boris.prescriptions[0];
    assert.equal(b.state, 'pending', 'ending B derives pending');

    // Cleo: denial-rx (refills 1, no renewal) -> 'ineligible'; the
    // eligible zero-refill rx (no renewal) -> 'no-renewal'.
    const cleo = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    const cleoRows = byId(cleo.prescriptions);
    assert.equal(cleoRows.get('denial-rx').state, 'ineligible', 'denial-rx derives ineligible');
    assert.equal(
      cleoRows.get(ELIGIBLE_RX.id).state,
      'no-renewal',
      'zero-refill rx without renewal derives no-renewal'
    );

    // 'Awaiting prescriber' is non-final too: a handoff-style row must
    // still derive 'pending'.
    insertRenewal(dbPath, {
      id: 'fixture-handoff-rn',
      prescription_id: ELIGIBLE_RX.id,
      patient_id: ELIGIBLE_RX.patient_id,
      pharmacy_id: ELIGIBLE_RX.pharmacy_id,
      prescriber_id: ELIGIBLE_RX.prescriber_id,
      status: STATUS_LABELS.AWAITING_PRESCRIBER,
      next_actor: 'prescriber',
      submitted_at: '2026-11-22T08:00:00Z',
      handoff_at: '2026-11-22T08:30:00Z',
    });
    const afterHandoff = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    assert.equal(
      byId(afterHandoff.prescriptions).get(ELIGIBLE_RX.id).state,
      'pending',
      'Awaiting prescriber derives pending (non-final)'
    );

    // A 'Visit required' terminal row also derives 'final'.
    insertRenewal(dbPath, {
      id: 'fixture-visit-rn',
      prescription_id: 'denial-rx',
      patient_id: 'denial-patient',
      pharmacy_id: 'pharmacy-dunmore',
      prescriber_id: 'denial-prescriber',
      status: STATUS_LABELS.VISIT_REQUIRED,
      next_actor: 'patient',
      submitted_at: '2026-11-22T09:00:00Z',
      decided_at: '2026-11-22T10:00:00Z',
      granted_refills: 0,
    });
    const afterVisit = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    assert.equal(
      byId(afterVisit.prescriptions).get('denial-rx').state,
      'final',
      'Visit required derives final'
    );

    // Schema allows a final release plus a fresh non-final row for the
    // same prescription: the list must emit ONE row (the non-final one
    // wins the canonical selection), never a duplicate.
    insertRenewal(dbPath, {
      id: 'fixture-again-rn',
      prescription_id: 'denial-rx',
      patient_id: 'denial-patient',
      pharmacy_id: 'pharmacy-dunmore',
      prescriber_id: 'denial-prescriber',
      status: STATUS_LABELS.SENT_TO_PHARMACY,
      next_actor: 'pharmacy',
      submitted_at: '2026-11-22T11:00:00Z',
    });
    const afterAgain = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    assert.equal(
      afterAgain.prescriptions.length,
      2,
      'still one row per prescription despite two renewal rows'
    );
    const denialRow = byId(afterAgain.prescriptions).get('denial-rx');
    assert.equal(denialRow.state, 'pending', 'non-final wins the canonical renewal selection');
    assert.equal(
      denialRow.renewal_id,
      'fixture-again-rn',
      'the non-final renewal is the one reported'
    );

    // The exported state constants are the exact closed set used by the
    // derivation (a later view layer may only render from this set).
    assert.deepEqual(
      [...Object.values(PATIENT_PRESCRIPTION_STATES)].sort(),
      ['final', 'ineligible', 'no-renewal', 'pending'],
      'PATIENT_PRESCRIPTION_STATES is the closed four-state set'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels and renewal details: pharmacy/prescriber names, refill count, and the full existing renewal detail are returned where applicable', () => {
  const { dir, dbPath } = freshDb('fixture-details');
  try {
    const boris = listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    const b = boris.prescriptions[0];
    assert.equal(b.pharmacy_name, 'Cedar Crossing Pharmacy', 'pharmacy label');
    assert.equal(b.prescriber_name, 'Dr. Priya Raman', 'prescriber label');
    assert.equal(b.refills_remaining, 0, 'saved refill count');
    assert.equal(typeof b.refills_remaining, 'number', 'refill count is numeric');
    // Pending renewal details exactly as stored.
    assert.equal(b.renewal_id, 'ending-b-renewal', 'renewal id');
    assert.equal(b.status, STATUS_LABELS.SENT_TO_PHARMACY, 'renewal status');
    assert.equal(b.next_actor, 'pharmacy', 'renewal next actor');
    assert.equal(b.submitted_at, '2026-11-21T10:00:00Z', 'renewal submitted at');
    assert.equal(b.handoff_at, null, 'no handoff yet');
    assert.equal(b.decided_at, null, 'no decision yet');
    assert.equal(b.granted_refills, null, 'no grant yet');

    const ava = listPatientPrescriptions(dbPath, { id: 'ending-a-patient', role: 'patient' });
    const a = ava.prescriptions[0];
    assert.equal(a.pharmacy_name, 'Cedar Crossing Pharmacy', 'ending A pharmacy label');
    assert.equal(a.prescriber_name, 'Dr. Naomi Okafor', 'ending A prescriber label');
    assert.equal(a.refills_remaining, 1, 'ending A refill count');
    // Terminal renewal details exactly as stored.
    assert.equal(a.renewal_id, 'ending-a-renewal', 'ending A renewal id');
    assert.equal(a.status, STATUS_LABELS.RENEWAL_APPROVED, 'ending A status');
    assert.equal(a.next_actor, 'pharmacy', 'ending A next actor');
    assert.equal(a.submitted_at, '2026-11-21T08:00:00Z', 'ending A submitted at');
    assert.equal(a.handoff_at, '2026-11-21T08:30:00Z', 'ending A handoff at');
    assert.equal(a.decided_at, '2026-11-21T09:00:00Z', 'ending A decided at');
    assert.equal(a.granted_refills, 1, 'ending A granted refills');

    // Rows WITHOUT a renewal carry no renewal fields at all: the renewal
    // details (and the case reference) are present only where applicable.
    const cleo = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    const d = cleo.prescriptions[0];
    assert.equal(d.renewal_id, undefined, 'no renewal id field without a renewal');
    assert.equal(d.status, undefined, 'no status field without a renewal');
    assert.equal(d.next_actor, undefined, 'no next actor field without a renewal');
    assert.equal(d.submitted_at, undefined, 'no submitted_at field without a renewal');
    assert.equal(d.handoff_at, undefined, 'no handoff_at field without a renewal');
    assert.equal(d.decided_at, undefined, 'no decided_at field without a renewal');
    assert.equal(d.granted_refills, undefined, 'no granted_refills field without a renewal');
    assert.equal(d.renewal_case_ref, undefined, 'no case ref field without a renewal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('case-reference compatibility: renewal_case_ref equals the canonical store caseRefFor AND the byte-identical legacy server formula; stable across calls and fresh connections', () => {
  const { dir, dbPath } = freshDb('fixture-caseref');
  try {
    const boris = listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    const b = boris.prescriptions[0];
    assert.equal(
      b.renewal_case_ref,
      caseRefFor('ending-b-renewal'),
      'row case ref equals canonical store caseRefFor'
    );
    assert.equal(
      b.renewal_case_ref,
      legacyServerCaseRef('ending-b-renewal'),
      'row case ref is byte-identical to the legacy server formula'
    );
    assert.equal(
      legacyServerCaseRef('ending-a-renewal'),
      'f40979e9fbffaafb02072fba5e46e6a3',
      'legacy formula still yields the historical Ending A value'
    );
    assert.equal(
      legacyServerCaseRef('ending-b-renewal'),
      '77d74295c5e1ab5d5282a6868224dd5b',
      'legacy formula still yields the historical Ending B value'
    );
    assert.match(b.renewal_case_ref, /^[0-9a-f]{32}$/, 'case ref is 32 lowercase hex');

    // Deterministic across repeated reads on the same database: two more
    // fresh-connection reads must reproduce the exact same 32-hex value
    // (copied links stay valid across the import swap and across
    // process restarts).
    const again1 = listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    const again2 = listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    assert.equal(again1.prescriptions[0].renewal_case_ref, b.renewal_case_ref, 'stable across read 2');
    assert.equal(again2.prescriptions[0].renewal_case_ref, b.renewal_case_ref, 'stable across read 3');

    // Same guarantee for the terminal row.
    const ava = listPatientPrescriptions(dbPath, { id: 'ending-a-patient', role: 'patient' });
    assert.equal(
      ava.prescriptions[0].renewal_case_ref,
      legacyServerCaseRef('ending-a-renewal'),
      'terminal row case ref is byte-identical too'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Request and listing integration: an ask-created renewal appears as pending with its case ref; an idempotent repeat leaves the list unchanged', () => {
  const { dir, dbPath } = freshDb('fixture-interplay');
  try {
    seedEligibleRx(dbPath);

    const res = askPatientForRenewal(dbPath, { id: 'denial-patient', role: 'patient' }, ELIGIBLE_RX.id);
    assert.equal(res.ok, true, 'ask ok');
    assert.equal(res.code, 'created', 'first ask creates');

    const after = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    const row = byId(after.prescriptions).get(ELIGIBLE_RX.id);
    assert.equal(row.state, 'pending', 'ask-created renewal derives pending');
    assert.equal(row.renewal_id, res.renewal.id, 'list row carries the created renewal id');
    assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'list row carries the created status');
    assert.equal(row.submitted_at, res.renewal.submitted_at, 'list row carries the original submitted_at');
    assert.equal(row.next_actor, 'pharmacy', 'list row carries next actor pharmacy');
    assert.equal(row.renewal_case_ref, caseRefFor(res.renewal.id), 'case ref matches the created renewal');
    assert.equal(row.renewal_case_ref, legacyServerCaseRef(res.renewal.id), 'byte-compatible with the legacy formula');

    // Repeat ask (idempotent): the list is unchanged — same single row,
    // same submitted_at, same case ref, and no new durable rows.
    const afterFirstAsk = fullTableState(dbPath);
    const repeat = askPatientForRenewal(dbPath, { id: 'denial-patient', role: 'patient' }, ELIGIBLE_RX.id);
    assert.equal(repeat.code, 'already-pending', 'repeat ask returns the existing record');
    assert.equal(repeat.created, false, 'repeat ask creates nothing');
    const afterRepeat = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    const row2 = byId(afterRepeat.prescriptions).get(ELIGIBLE_RX.id);
    assert.equal(row2.submitted_at, res.renewal.submitted_at, 'original submitted_at preserved');
    assert.equal(row2.renewal_case_ref, row.renewal_case_ref, 'case ref unchanged after repeat');
    assertStateUnchanged(fullTableState(dbPath), afterFirstAsk, 'interplay: repeat ask left durable state identical');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ordering: rows with a renewal precede renewal-less rows; deterministic within each group', () => {
  const { dir, dbPath } = freshDb('fixture-ordering');
  try {
    seedEligibleRx(dbPath);
    // denial-rx (refills 1, no renewal) gets a pending renewal directly:
    // it must then sort before the renewal-less eligible rx.
    insertRenewal(dbPath, {
      id: 'fixture-order-rn',
      prescription_id: 'denial-rx',
      patient_id: 'denial-patient',
      pharmacy_id: 'pharmacy-dunmore',
      prescriber_id: 'denial-prescriber',
      status: STATUS_LABELS.SENT_TO_PHARMACY,
      next_actor: 'pharmacy',
      submitted_at: '2026-11-22T08:00:00Z',
    });
    const cleo = listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    assert.deepEqual(
      cleo.prescriptions.map((r) => r.id),
      ['denial-rx', ELIGIBLE_RX.id],
      'renewal row first, then renewal-less row'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authorization regression: pharmacy and prescriber are denied (patient-role-only); unknown or unusable identities deny unknown-role; denials carry no prescription or case data', () => {
  const { dir, dbPath } = freshDb('fixture-authorization');
  try {
    const pharmacy = listPatientPrescriptions(dbPath, { id: 'pharmacy-cedar', role: 'pharmacy' });
    assert.deepEqual(pharmacy, { ok: false, reason: 'not-authorized' }, 'pharmacy denied');
    assertNoCaseData(pharmacy, 'pharmacy denial');

    const prescriber = listPatientPrescriptions(dbPath, { id: 'ending-a-prescriber', role: 'prescriber' });
    assert.deepEqual(prescriber, { ok: false, reason: 'not-authorized' }, 'prescriber denied');
    assertNoCaseData(prescriber, 'prescriber denial');

    const unknownRole = listPatientPrescriptions(dbPath, { id: 'ending-a-patient', role: 'analyst' });
    assert.deepEqual(unknownRole, { ok: false, reason: 'unknown-role' }, 'unknown role denied');
    assertNoCaseData(unknownRole, 'unknown role denial');

    const missingId = listPatientPrescriptions(dbPath, { role: 'patient' });
    assert.deepEqual(missingId, { ok: false, reason: 'unknown-role' }, 'missing id denied');
    const nullIdentity = listPatientPrescriptions(dbPath, null);
    assert.deepEqual(nullIdentity, { ok: false, reason: 'unknown-role' }, 'null identity denied');
    const undefinedIdentity = listPatientPrescriptions(dbPath, undefined);
    assert.deepEqual(undefinedIdentity, { ok: false, reason: 'unknown-role' }, 'undefined identity denied');

    // No denial carries a prescriptions field at all.
    for (const [label, result] of [
      ['pharmacy', pharmacy],
      ['prescriber', prescriber],
      ['unknown-role', unknownRole],
      ['missing-id', missingId],
      ['null', nullIdentity],
      ['undefined', undefinedIdentity],
    ]) {
      assert.equal(result.prescriptions, undefined, `${label}: denial has no prescriptions field`);
    }

    // The session-derived identity is what the server passes: a real
    // pharmacy sign-in is denied exactly as above, and a real patient
    // sign-in lists through the same code path. All sign-ins happen
    // BEFORE the durable-state baseline, so the comparison isolates the
    // denial and read calls themselves (each sign-in adds one session row).
    const pharmacySession = identityFor(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(pharmacySession.role, 'pharmacy', 'session role is pharmacy');
    const patientSession = identityFor(dbPath, 'boris.laine', 'patient-boris-2026');
    const before = fullTableState(dbPath);
    const fromSession = listPatientPrescriptions(dbPath, pharmacySession);
    assert.deepEqual(fromSession, { ok: false, reason: 'not-authorized' }, 'session-derived pharmacy denied');

    const fromPatientSession = listPatientPrescriptions(dbPath, patientSession);
    assert.equal(fromPatientSession.ok, true, 'session-derived patient list ok');
    assert.deepEqual(
      fromPatientSession.prescriptions.map((r) => r.id),
      ['ending-b-rx'],
      'session-derived patient sees own prescription'
    );

    assertStateUnchanged(fullTableState(dbPath), before, 'denials and session-derived reads');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only: successful reads change no durable state (every table byte-identical on a fresh-connection re-read)', () => {
  const { dir, dbPath } = freshDb('fixture-readonly');
  try {
    // Real sign-ins first (they add session rows); only then snapshot the
    // durable state — the read claims are checked against that baseline.
    identityFor(dbPath, 'boris.laine', 'patient-boris-2026');
    identityFor(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const before = fullTableState(dbPath);
    listPatientPrescriptions(dbPath, { id: 'ending-a-patient', role: 'patient' });
    listPatientPrescriptions(dbPath, { id: 'ending-b-patient', role: 'patient' });
    listPatientPrescriptions(dbPath, { id: 'denial-patient', role: 'patient' });
    listPatientPrescriptions(dbPath, { id: 'pharmacy-cedar', role: 'pharmacy' });
    listPatientPrescriptions(dbPath, { id: 'ending-a-prescriber', role: 'prescriber' });
    assertStateUnchanged(fullTableState(dbPath), before, 'reads');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
