import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MARKER_KEY = 'value';

// Accepted renewal status labels (used verbatim in the schema constraints,
// the pending-renewal index, and the focused test assertions).
export const STATUS_LABELS = Object.freeze({
  SENT_TO_PHARMACY: 'Sent to pharmacy',
  AWAITING_PRESCRIBER: 'Awaiting prescriber',
  RENEWAL_APPROVED: 'Renewal approved',
  VISIT_REQUIRED: 'Visit required',
});

// Canonical renewal_events.event_type values that carry the structural
// invariants. The final-decision event types are the accepted final status
// labels themselves; 'handoff' records the pharmacy -> prescriber handoff.
export const EVENT_TYPES = Object.freeze({
  HANDOFF: 'handoff',
  SUBMITTED: 'submitted',
  RENEWAL_APPROVED: STATUS_LABELS.RENEWAL_APPROVED,
  VISIT_REQUIRED: STATUS_LABELS.VISIT_REQUIRED,
});

export const SCHEMA_VERSION = 1;

const NON_FINAL_STATUSES = [
  STATUS_LABELS.SENT_TO_PHARMACY,
  STATUS_LABELS.AWAITING_PRESCRIBER,
];
const FINAL_STATUSES = [
  STATUS_LABELS.RENEWAL_APPROVED,
  STATUS_LABELS.VISIT_REQUIRED,
];
const ALL_STATUSES = [...NON_FINAL_STATUSES, ...FINAL_STATUSES];

// Render an accepted label as a single-quoted SQL literal (labels contain no
// single quotes; escaping is kept for safety).
const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sqlEnum = (values) => values.map(sqlLiteral).join(', ');

// Each entry is a single SQL statement so it can be executed individually
// (the built-in node:sqlite exec is applied one statement at a time).
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS markers (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Synthetic identity.
  `CREATE TABLE IF NOT EXISTS identities (
    id           TEXT PRIMARY KEY,
    role         TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_synthetic INTEGER NOT NULL DEFAULT 0
  )`,

  // Prescription fixture.
  `CREATE TABLE IF NOT EXISTS prescriptions (
    id                TEXT PRIMARY KEY,
    patient_id        TEXT NOT NULL,
    pharmacy_id       TEXT NOT NULL,
    prescriber_id     TEXT NOT NULL,
    refills_remaining INTEGER NOT NULL DEFAULT 0 CHECK (refills_remaining >= 0),
    is_synthetic      INTEGER NOT NULL DEFAULT 0
  )`,

  // Renewal record. The accepted status labels are enforced verbatim; final
  // outcomes carry decided_at + granted_refills, and the accepted
  // outcome/refill-count pairs are 'Renewal approved' -> exactly one
  // refill, 'Visit required' -> zero.
  `CREATE TABLE IF NOT EXISTS renewals (
    id                      TEXT PRIMARY KEY,
    prescription_id         TEXT NOT NULL,
    patient_id              TEXT NOT NULL,
    pharmacy_id             TEXT NOT NULL,
    prescriber_id           TEXT NOT NULL,
    status                  TEXT NOT NULL
                            CHECK (status IN (${sqlEnum(ALL_STATUSES)})),
    next_actor              TEXT,
    submitted_at            TEXT,
    handoff_at              TEXT,
    decided_at              TEXT,
    granted_refills         INTEGER,
    request_idempotency_key TEXT,
    version                 INTEGER NOT NULL DEFAULT 1,
    CHECK (status NOT IN (${sqlEnum(FINAL_STATUSES)})
           OR (decided_at IS NOT NULL AND granted_refills IS NOT NULL)),
    CHECK (status IN (${sqlEnum(FINAL_STATUSES)})
           OR (decided_at IS NULL AND granted_refills IS NULL)),
    CHECK ((status = ${sqlLiteral(STATUS_LABELS.RENEWAL_APPROVED)} AND granted_refills = 1)
        OR (status = ${sqlLiteral(STATUS_LABELS.VISIT_REQUIRED)} AND granted_refills = 0)
        OR (status NOT IN (${sqlEnum(FINAL_STATUSES)}) AND granted_refills IS NULL))
  )`,

  // One non-final (pending) renewal per prescription; final outcomes
  // release the slot so the prescription may be renewed again later.
  `CREATE UNIQUE INDEX IF NOT EXISTS refill_pending_per_prescription
     ON renewals (prescription_id)
     WHERE status IN (${sqlEnum(NON_FINAL_STATUSES)})`,

  // Canonical renewal event record. Handoff and final-decision data live
  // here (no separate handoff/decision tables); their "one" invariants are
  // the partial unique indexes below.
  `CREATE TABLE IF NOT EXISTS renewal_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    renewal_id  TEXT NOT NULL REFERENCES renewals (id),
    event_type  TEXT NOT NULL,
    actor_role  TEXT,
    actor_id    TEXT,
    occurred_at TEXT NOT NULL,
    payload     TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS renewal_events_by_renewal
     ON renewal_events (renewal_id)`,

  // One handoff per renewal, ever.
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_events_one_handoff
     ON renewal_events (renewal_id)
     WHERE event_type = ${sqlLiteral(EVENT_TYPES.HANDOFF)}`,

  // One final decision per renewal, across outcomes: a conflicting second
  // final-decision event (any accepted outcome) is rejected.
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_events_one_final_decision
     ON renewal_events (renewal_id)
     WHERE event_type IN (${sqlEnum(FINAL_STATUSES)})`,

  // Future workflow tables (schema only; empty on initialization).
  `CREATE TABLE IF NOT EXISTS pharmacy_conversation_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    renewal_id  TEXT NOT NULL REFERENCES renewals (id),
    sender_role TEXT NOT NULL,
    sender_id   TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS pharmacy_conversation_messages_by_renewal
     ON pharmacy_conversation_messages (renewal_id)`,

  `CREATE TABLE IF NOT EXISTS office_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    renewal_id  TEXT NOT NULL REFERENCES renewals (id),
    decision_id TEXT,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    audience    TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS office_messages_by_renewal
     ON office_messages (renewal_id)`,

  `CREATE TABLE IF NOT EXISTS phone_notes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    renewal_id        TEXT NOT NULL REFERENCES renewals (id),
    pharmacy_actor_id TEXT NOT NULL,
    note              TEXT NOT NULL,
    created_at        TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS phone_notes_by_renewal
     ON phone_notes (renewal_id)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES identities (id),
    created_at  TEXT NOT NULL,
    expires_at  TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS synthetic_accounts (
    username      TEXT PRIMARY KEY,
    identity_id   TEXT NOT NULL UNIQUE REFERENCES identities (id),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
  )`,
];

// Normalize the single-value rows that node:sqlite may surface either as a
// named object ({ journal_mode: 'wal' }) or as a bare value.
function pragmaValue(row, key) {
  if (row === undefined || row === null) return undefined;
  if (typeof row === 'object') {
    if (key in row) return row[key];
    const firstKey = Object.keys(row)[0];
    return firstKey === undefined ? undefined : row[firstKey];
  }
  return row;
}

/**
 * Initialize the full durable schema on an open connection. Idempotent.
 *
 * WAL journal mode and foreign-key enforcement are required durability
 * boundaries: each is set, read back, and asserted. If either cannot be
 * established, initialization throws instead of silently continuing.
 */
export function initSchema(db) {
  // Required durability boundary: WAL.
  db.prepare('PRAGMA journal_mode = WAL').get();
  const journalMode = String(
    pragmaValue(db.prepare('PRAGMA journal_mode').get(), 'journal_mode')
  ).toLowerCase();
  if (journalMode !== 'wal') {
    throw new Error(
      `initSchema: required WAL journal mode could not be established (effective: ${journalMode})`
    );
  }

  // Required integrity boundary: per-connection foreign-key enforcement.
  db.prepare('PRAGMA foreign_keys = ON').get();
  const foreignKeys = Number(
    pragmaValue(db.prepare('PRAGMA foreign_keys').get(), 'foreign_keys')
  );
  if (foreignKeys !== 1) {
    throw new Error(
      `initSchema: required foreign-key enforcement could not be established (effective: ${foreignKeys})`
    );
  }

  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  return db;
}

/**
 * Create the full durable schema (idempotent) and return the connection.
 * Every store connection is WAL-backed and transactional.
 */
export function initDatabase(dbPath) {
  mkdirSync(dirname(dbPath) || '.', { recursive: true });
  const db = new DatabaseSync(dbPath);
  initSchema(db);
  return db;
}

function open(dbPath) {
  return initDatabase(dbPath);
}

/**
 * Commit the synthetic marker to markers.value and close the connection,
 * so the write is durable across process restarts.
 */
export function writeMarker(dbPath, value) {
  const db = open(dbPath);
  try {
    const stmt = db.prepare(
      `INSERT INTO markers (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    stmt.run(MARKER_KEY, value);
  } finally {
    db.close();
  }
}

/**
 * Open a brand-new connection (simulating a restart) and read back the
 * marker. Returns null when no marker has been committed yet.
 */
export function readMarker(dbPath) {
  const db = open(dbPath);
  try {
    const row = db
      .prepare(`SELECT value FROM markers WHERE key = ?`)
      .get(MARKER_KEY);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}


export const SYNTHETIC_FIXTURES = Object.freeze({
  identities: [
    { id: 'ending-a-patient', role: 'patient', display_name: 'Ava Mercer' },
    { id: 'ending-a-prescriber', role: 'prescriber', display_name: 'Dr. Naomi Okafor' },
    { id: 'pharmacy-cedar', role: 'pharmacy', display_name: 'Cedar Crossing Pharmacy' },
    { id: 'ending-b-patient', role: 'patient', display_name: 'Boris Laine' },
    { id: 'ending-b-prescriber', role: 'prescriber', display_name: 'Dr. Priya Raman' },
    { id: 'denial-patient', role: 'patient', display_name: 'Cleo Voss' },
    { id: 'denial-prescriber', role: 'prescriber', display_name: 'Dr. Emil Hart' },
    { id: 'pharmacy-dunmore', role: 'pharmacy', display_name: 'Dunmore Corner Pharmacy' },
  ],
  prescriptions: [
    {
      id: 'ending-a-rx',
      patient_id: 'ending-a-patient',
      pharmacy_id: 'pharmacy-cedar',
      prescriber_id: 'ending-a-prescriber',
      refills_remaining: 1,
    },
    {
      id: 'ending-b-rx',
      patient_id: 'ending-b-patient',
      pharmacy_id: 'pharmacy-cedar',
      prescriber_id: 'ending-b-prescriber',
      refills_remaining: 0,
    },
    {
      id: 'denial-rx',
      patient_id: 'denial-patient',
      pharmacy_id: 'pharmacy-dunmore',
      prescriber_id: 'denial-prescriber',
      refills_remaining: 1,
    },
  ],
  renewals: [
    {
      // Ending A: the approved terminal renewal.
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
    },
    {
      // Ending B: the single 'Sent to pharmacy' example (non-final).
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
    },
  ],
});

function applyFixtureSeed(db, fixtures) {
  const insertIdentity = db.prepare(
    `INSERT INTO identities (id, role, display_name, is_synthetic)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(id) DO NOTHING`
  );
  const insertPrescription = db.prepare(
    `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO NOTHING`
  );
  const insertRenewal = db.prepare(
    `INSERT INTO renewals
       (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
        status, next_actor, submitted_at, handoff_at, decided_at, granted_refills,
        request_idempotency_key, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)
     ON CONFLICT(id) DO NOTHING`
  );

  // One transaction: the seed is all-or-nothing.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const identity of fixtures.identities) {
      insertIdentity.run(identity.id, identity.role, identity.display_name);
    }
    for (const prescription of fixtures.prescriptions) {
      insertPrescription.run(
        prescription.id,
        prescription.patient_id,
        prescription.pharmacy_id,
        prescription.prescriber_id,
        prescription.refills_remaining
      );
    }
    for (const renewal of fixtures.renewals) {
      insertRenewal.run(
        renewal.id,
        renewal.prescription_id,
        renewal.patient_id,
        renewal.pharmacy_id,
        renewal.prescriber_id,
        renewal.status,
        renewal.next_actor ?? null,
        renewal.submitted_at ?? null,
        renewal.handoff_at ?? null,
        renewal.decided_at ?? null,
        renewal.granted_refills ?? null
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction already ended; the original error is authoritative.
    }
    throw err;
  }

  const countTable = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    identities: countTable('identities'),
    prescriptions: countTable('prescriptions'),
    renewals: countTable('renewals'),
  };
}

export function seedSyntheticFixtures(dbPath, fixtures = SYNTHETIC_FIXTURES) {
  const db = open(dbPath);
  try {
    return applyFixtureSeed(db, fixtures);
  } finally {
    db.close();
  }
}


export const SESSION_COOKIE_NAME = 'rfrl_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export const SYNTHETIC_ACCOUNTS = Object.freeze([
  { username: 'ava.mercer', identity_id: 'ending-a-patient', password: 'patient-ava-2026' },
  { username: 'boris.laine', identity_id: 'ending-b-patient', password: 'patient-boris-2026' },
  { username: 'cleo.voss', identity_id: 'denial-patient', password: 'patient-cleo-2026' },
  { username: 'dr.naomi.okafor', identity_id: 'ending-a-prescriber', password: 'prescriber-naomi-2026' },
  { username: 'dr.priya.raman', identity_id: 'ending-b-prescriber', password: 'prescriber-priya-2026' },
  { username: 'dr.emil.hart', identity_id: 'denial-prescriber', password: 'prescriber-emil-2026' },
  { username: 'pharmacy.cedar', identity_id: 'pharmacy-cedar', password: 'pharmacy-cedar-2026' },
  { username: 'pharmacy.dunmore', identity_id: 'pharmacy-dunmore', password: 'pharmacy-dunmore-2026' },
]);

const accountSalt = (username) => `rfrl-demo-salt-${username}`;

// Fixed iteration count for the synthetic credential KDF (a module
// constant, so verification is reproducible without persisting it). Kept
// modest: these are local fictional accounts, and the loop must stay cheap
// in the constrained test runtime.
export const CREDENTIAL_HASH_ITERATIONS = 1_000;

/**
 * Salted credential hash: iterated SHA-256 over "salt:password"
 * (CREDENTIAL_HASH_ITERATIONS rounds) as lowercase hex. Deliberately plain
 * createHash — no scrypt/PBKDF2 native path — so verification behaves
 * identically in every Node build; these are local fictional accounts, not
 * real credentials. The persisted row holds salt + hash, never the password.
 */
export function hashPassword(password, salt, iterations = CREDENTIAL_HASH_ITERATIONS) {
  const material = `${String(salt)}:${String(password)}`;
  let digest = createHash('sha256').update(material).digest();
  for (let i = 1; i < iterations; i += 1) {
    digest = createHash('sha256').update(digest).update(material).digest();
  }
  return digest.toString('hex');
}

// Constant-time comparison of hex digests (avoids a native timing API).
function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a provided password against the stored salted hash in constant
 * time.
 */
export function verifyPassword(password, salt, expectedHashHex, iterations = CREDENTIAL_HASH_ITERATIONS) {
  return constantTimeEqualHex(
    hashPassword(password, salt, iterations),
    String(expectedHashHex)
  );
}

function applyAccountSeed(db, accounts) {
  const insertAccount = db.prepare(
    `INSERT INTO synthetic_accounts (username, identity_id, password_salt, password_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO NOTHING`
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const account of accounts) {
      const salt = account.password_salt ?? accountSalt(account.username);
      insertAccount.run(
        account.username,
        account.identity_id,
        salt,
        hashPassword(account.password, salt)
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction already ended; the original error is authoritative.
    }
    throw err;
  }

  return {
    accounts: db.prepare(`SELECT COUNT(*) AS n FROM synthetic_accounts`).get().n,
  };
}

/**
 * Commit the local synthetic credential accounts (salt + salted hash only)
 * for the seeded identities — SYNTHETIC_ACCOUNTS by default, or an explicit
 * account set — on a fresh transactional connection at dbPath. Idempotent
 * and all-or-nothing, mirroring seedSyntheticFixtures. Returns { accounts }.
 */
export function seedSyntheticAccounts(dbPath, accounts = SYNTHETIC_ACCOUNTS) {
  const db = open(dbPath);
  try {
    return applyAccountSeed(db, accounts);
  } finally {
    db.close();
  }
}

const cookieForToken = (token, ttlMs) => {
  const maxAge = Math.max(0, Math.floor(Number(ttlMs) / 1000));
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    attributes,
    header: `${SESSION_COOKIE_NAME}=${token}; ${attributes.join('; ')}`,
  };
};

const NO_SESSION_BODY = Object.freeze({
  ok: false,
  error: 'no-session',
  message: 'No signed-in session is available; sign in first.',
});

/**
 * Local synthetic sign-in (in-process response object, no network).
 *
 *   success:   { status: 200, body: { ok: true, identity: { id, role,
 *                 display_name }, cookie: <cookie name> }, cookie: { name,
 *                 value, attributes, header } }
 *   bad creds: { status: 401, body: { ok: false,
 *                 error: 'invalid-credentials', message }, cookie: null }
 *   save fail: { status: 503, body: { ok: false,
 *                 error: 'session-save-failed', message, recoverable: true },
 *                 cookie: null }
 *
 * The opaque cookie (HttpOnly, SameSite=Lax) is attached only after the
 * server-side session row has committed.
 */
export function signIn(dbPath, username, password, options = {}) {
  const db = open(dbPath);
  try {
    const account = db
      .prepare(
        `SELECT username, identity_id, password_salt, password_hash
           FROM synthetic_accounts
          WHERE username = ?`
      )
      .get(String(username ?? ''));
    const identity = account
      ? db
          .prepare(`SELECT id, role, display_name FROM identities WHERE id = ?`)
          .get(account.identity_id)
      : undefined;

    // Always run the KDF so a missing account and a wrong password are
    // indistinguishable; the response never says which one failed.
    const salt = account ? account.password_salt : accountSalt('');
    const valid = Boolean(
      account && identity && verifyPassword(password, salt, account.password_hash)
    );
    if (!valid) {
      return {
        status: 401,
        body: {
          ok: false,
          error: 'invalid-credentials',
          message:
            'Sign-in failed. Check the username and password for this local synthetic account.',
        },
        cookie: null,
      };
    }

    // Opaque token: carries no identity, role, or username data.
    const token = randomBytes(32).toString('hex');
    const ttlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + Number(ttlMs)).toISOString();

    // Server-side session first: commit the row, then (and only then)
    // issue the cookie.
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        `INSERT INTO sessions (token, identity_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      ).run(token, identity.id, createdAt, expiresAt);
      // Injected persistence failure point: AFTER the session INSERT and
      // BEFORE the COMMIT. The attempted session row is still inside the
      // open transaction, so the ROLLBACK below is what removes it.
      if (options.failSessionCommit) {
        throw new Error(
          'simulated SQLite failure while committing the session row'
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction already ended; the original error is authoritative.
      }
      return {
        status: 503,
        body: {
          ok: false,
          error: 'session-save-failed',
          message:
            'Sign-in was verified, but the session could not be saved. No session was started; please try signing in again.',
          recoverable: true,
        },
        cookie: null,
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        // Role established from the stored identity at sign-in time.
        identity: { id: identity.id, role: identity.role, display_name: identity.display_name },
        cookie: SESSION_COOKIE_NAME,
      },
      cookie: cookieForToken(token, ttlMs),
    };
  } finally {
    db.close();
  }
}

/**
 * Authenticated session lookup: resolve the opaque cookie to the stored
 * identity (id, role, display_name — the role re-derived from the
 * identities table). Unknown or expired tokens get a clear 401
 * no-session response. Pure read: it never mutates state.
 */
export function getSession(dbPath, token, options = {}) {
  const db = open(dbPath);
  try {
    const row = token
      ? db
          .prepare(
            `SELECT s.identity_id, s.expires_at, i.role, i.display_name
               FROM sessions s
               JOIN identities i ON i.id = s.identity_id
              WHERE s.token = ?`
          )
          .get(String(token))
      : undefined;
    if (!row || (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now())) {
      return { status: 401, body: { ...NO_SESSION_BODY }, identity: null, cookie: null };
    }
    const identity = { id: row.identity_id, role: row.role, display_name: row.display_name };
    return { status: 200, body: { ok: true, identity }, identity, cookie: null };
  } finally {
    db.close();
  }
}

/**
 * Sign-out / session invalidation: delete the server-side session row for
 * the token. Idempotent — an unknown token still succeeds with
 * invalidated: false. Returns a cookie-clear directive.
 */
export function signOut(dbPath, token, options = {}) {
  const db = open(dbPath);
  try {
    const result = db
      .prepare(`DELETE FROM sessions WHERE token = ?`)
      .run(token === undefined || token === null ? '' : String(token));
    const invalidated = Number(result.changes) > 0;
    const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    return {
      status: 200,
      body: { ok: true, invalidated, cookie: SESSION_COOKIE_NAME },
      clearCookie: {
        name: SESSION_COOKIE_NAME,
        value: '',
        attributes,
        header: `${SESSION_COOKIE_NAME}=; ${attributes.join('; ')}`,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * The single in-process application handler callers use for sign-in,
 * authenticated session lookup, and sign-out. Requests and responses are
 * plain objects; no network or external credentials are involved.
 */
export function handleAppRequest(dbPath, request, options = {}) {
  const route = request ? request.route : undefined;
  if (route === 'sign-in') {
    return signIn(dbPath, request.username, request.password, options);
  }
  if (route === 'session') {
    return getSession(dbPath, request.cookie, options);
  }
  if (route === 'sign-out') {
    return signOut(dbPath, request.cookie, options);
  }
  return {
    status: 404,
    body: {
      ok: false,
      error: 'unknown-route',
      message: `Unknown route: ${String(route)}`,
    },
    cookie: null,
  };
}


const ROLE_OWNERSHIP_COLUMN = Object.freeze({
  patient: 'patient_id',
  pharmacy: 'pharmacy_id',
  prescriber: 'prescriber_id',
});

const CASE_SELECT_SQL = `
  SELECT r.*, p.display_name AS patient_name,
         ph.display_name AS pharmacy_name,
         pr.display_name AS prescriber_name
    FROM renewals r
    JOIN identities p  ON p.id  = r.patient_id
    JOIN identities ph ON ph.id = r.pharmacy_id
    JOIN identities pr ON pr.id = r.prescriber_id`;

function normalizeCaseRow(row) {
  return {
    id: row.id,
    prescription_id: row.prescription_id,
    patient_id: row.patient_id,
    pharmacy_id: row.pharmacy_id,
    prescriber_id: row.prescriber_id,
    status: row.status,
    next_actor: row.next_actor ?? null,
    submitted_at: row.submitted_at ?? null,
    handoff_at: row.handoff_at ?? null,
    decided_at: row.decided_at ?? null,
    granted_refills: row.granted_refills ?? null,
    patient_name: row.patient_name,
    pharmacy_name: row.pharmacy_name,
    prescriber_name: row.prescriber_name,
  };
}

const deny = (reason) => ({ ok: false, reason });

/**
 * Role queue read with the object-level predicate applied: the list of
 * saved renewal records this signed-in identity is allowed to see.
 *
 *   identity = { id, role } — the current durable session identity.
 *   success  = { ok: true, role, cases: [caseView, ...] }  (may be empty)
 *   denial   = { ok: false, reason: 'unknown-role' }
 *
 * Read-only: a SELECT on one short-lived connection; never mutates state.
 */
export function listRoleCases(dbPath, identity) {
  const role = identity && identity.role;
  const column = ROLE_OWNERSHIP_COLUMN[role];
  if (!column || !(identity && identity.id)) return deny('unknown-role');
  const db = open(dbPath);
  try {
    const rows = db
      .prepare(
        `${CASE_SELECT_SQL}
        WHERE r.${column} = ?
        ORDER BY r.submitted_at IS NULL, r.submitted_at, r.id`
      )
      .all(String(identity.id));
    return { ok: true, role, cases: rows.map(normalizeCaseRow) };
  } finally {
    db.close();
  }
}

/**
 * Case-detail read (the copied-link target) with the object-level
 * ownership/assignment check applied to the specific record.
 *
 *   success  = { ok: true, role, case: caseView }
 *   denial   = { ok: false, reason: 'unknown-role' }
 *            | { ok: false, reason: 'not-authorized' }
 *
 * The denial reason is deliberately OPAQUE: a record id that does not
 * exist and a record id that belongs to another identity produce the
 * exact same fixed denial for the signed-in reader. An unrelated
 * identity therefore cannot probe which record ids exist (no existence
 * disclosure), and no denial carries any case field.
 *
 * Read-only: a SELECT on one short-lived connection; a denial returns no
 * case field and changes no durable state.
 */
export function getRoleCase(dbPath, renewalId, identity) {
  const role = identity && identity.role;
  const column = ROLE_OWNERSHIP_COLUMN[role];
  if (!column || !(identity && identity.id)) return deny('unknown-role');
  const id = renewalId === undefined || renewalId === null ? '' : String(renewalId);
  const db = open(dbPath);
  try {
    const row = db.prepare(`${CASE_SELECT_SQL}\n      WHERE r.id = ?`).get(id);
    if (!row || row[column] !== String(identity.id)) return deny('not-authorized');
    return { ok: true, role, case: normalizeCaseRow(row) };
  } finally {
    db.close();
  }
}


export const caseRefFor = (renewalId) =>
  createHash('sha256').update(`rfrl-case-ref-v1:${renewalId}`).digest('hex').slice(0, 32);

const ASK_LOCK_MAX_ATTEMPTS = 10;
const ASK_LOCK_RETRY_DELAY_MS = 5;

// Synchronous pause (milliseconds) for the bounded lock retry: Atomics.wait
// on a guaranteed-zero cell blocks the calling thread without touching the
// event loop. Worst-case added latency is the full budget (≤ 45 ms of sleep,
// well under the 100 ms cap) and only occurs under genuine cross-thread/
// cross-process write-lock contention.
const askLockSleepCell = new Int32Array(new SharedArrayBuffer(4));
const askLockSleepSync = (ms) => { Atomics.wait(askLockSleepCell, 0, 0, ms); };

function renewalView(row) {
  return {
    id: row.id,
    prescription_id: row.prescription_id,
    patient_id: row.patient_id,
    pharmacy_id: row.pharmacy_id,
    prescriber_id: row.prescriber_id,
    status: row.status,
    next_actor: row.next_actor ?? null,
    submitted_at: row.submitted_at ?? null,
    handoff_at: row.handoff_at ?? null,
    decided_at: row.decided_at ?? null,
    granted_refills: row.granted_refills ?? null,
    request_idempotency_key: row.request_idempotency_key ?? null,
    version: row.version ?? null,
  };
}

const isFinalStatus = (status) => !NON_FINAL_STATUSES.includes(status);

// Handoff eligibility for a FRESHLY LOCKED renewal row: the acting pharmacy
// still owns the case and a prescriber is assigned. Applied under the write
// lock both before a transition is made and before a replay (already
// 'Awaiting prescriber') is returned, and again to any committed winner
// found during the UNIQUE-recovery re-read, so no path ever returns a replay
// or a transition for an ineligible row.
const handoffEligible = (row, pharmacyId) =>
  Boolean(
    row && row.pharmacy_id === String(pharmacyId) && row.prescriber_id
  );

export function askPatientForRenewal(dbPath, identity, prescriptionId, options = {}) {
  const id = identity && identity.id;
  const rxId =
    prescriptionId === undefined || prescriptionId === null ? '' : String(prescriptionId);
  const db = open(dbPath);
  let locked = false;
  let lockRetries = 0;
  try {
    // (1) Authorize (pure read on this short-lived connection): patient
    // role, prescription ownership, pharmacy + prescriber assignment.
    if (!identity || identity.role !== 'patient' || !id) {
      return { ok: false, code: 'not-authorized' };
    }
    const rx = db
      .prepare(
        `SELECT id, patient_id, pharmacy_id, prescriber_id
           FROM prescriptions
          WHERE id = ?`
      )
      .get(rxId);
    if (!rx || rx.patient_id !== String(id) || !rx.pharmacy_id || !rx.prescriber_id) {
      // One opaque result for unknown, another patient's, or
      // unassigned prescriptions: no existence or ownership disclosure.
      return { ok: false, code: 'unknown-prescription' };
    }

    // (2) Acquire the write lock with the bounded retry. Observed
    // node:sqlite behavior: a concurrent writer makes BEGIN IMMEDIATE
    // throw "database is locked" immediately; the retry acquires it once
    // the holder releases.
    const begin = db.prepare('BEGIN IMMEDIATE');
    for (let attempt = 1; attempt <= ASK_LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        begin.run();
        locked = true;
        break;
      } catch (err) {
        const message = String((err && err.message) || '');
        if (!/database is locked/i.test(message) && !/SQLITE_BUSY/i.test(message)) {
          throw err;
        }
        lockRetries += 1;
        if (attempt < ASK_LOCK_MAX_ATTEMPTS) askLockSleepSync(ASK_LOCK_RETRY_DELAY_MS);
      }
    }
    if (!locked) {
      // Budget exhausted under sustained contention: no durable state was
      // changed; the client may retry.
      return { ok: false, code: 'ask-save-failed', recoverable: true, lockRetries };
    }

    // (3) Re-read under the write lock (fresh, AFTER acquisition).
    const existing = db
      .prepare(
        `SELECT * FROM renewals WHERE prescription_id = ?
          ORDER BY (status IN (${sqlEnum(NON_FINAL_STATUSES)})) DESC, submitted_at, id
          LIMIT 1`
      )
      .get(rxId);
    if (existing) {
      db.exec('ROLLBACK');
      locked = false;
      return {
        ok: true,
        code: isFinalStatus(existing.status) ? 'already-final' : 'already-pending',
        renewal: renewalView(existing),
        created: false,
        lockRetries,
      };
    }

    // (4) Eligibility under the lock, then the atomic renewal + event.
    const rxCurrent = db
      .prepare(`SELECT refills_remaining FROM prescriptions WHERE id = ?`)
      .get(rxId);
    if (!rxCurrent || Number(rxCurrent.refills_remaining) !== 0) {
      db.exec('ROLLBACK');
      locked = false;
      return { ok: false, code: 'ineligible-prescription', lockRetries };
    }

    const now = new Date().toISOString();
    const renewalId = randomBytes(16).toString('hex');
    const patientId = String(id);
    try {
      db.prepare(
        `INSERT INTO renewals
           (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
            status, next_actor, submitted_at, handoff_at, decided_at,
            granted_refills, request_idempotency_key, version)
         VALUES (?, ?, ?, ?, ?, ?, 'pharmacy', ?, NULL, NULL, NULL, NULL, 1)`
      ).run(
        renewalId,
        rxId,
        patientId,
        rx.pharmacy_id,
        rx.prescriber_id,
        STATUS_LABELS.SENT_TO_PHARMACY,
        now
      );
      db.prepare(
        `INSERT INTO renewal_events
           (renewal_id, event_type, actor_role, actor_id, occurred_at, payload)
         VALUES (?, ?, 'patient', ?, ?, ?)`
      ).run(
        renewalId,
        EVENT_TYPES.SUBMITTED,
        patientId,
        now,
        JSON.stringify({ synthetic: true, prescription_id: rxId })
      );
      // Injected persistence failure point: AFTER the INSERTs and BEFORE
      // the COMMIT (mirrors signIn's failSessionCommit seam). The
      // attempted rows are still inside the open transaction, so the
      // ROLLBACK below is what removes them.
      if (options && options.failAskCommit) {
        throw new Error('simulated SQLite failure while committing the ask');
      }
      db.exec('COMMIT');
      locked = false;
      return {
        ok: true,
        code: 'created',
        created: true,
        lockRetries,
        renewal: {
          id: renewalId,
          prescription_id: rxId,
          patient_id: patientId,
          pharmacy_id: rx.pharmacy_id,
          prescriber_id: rx.prescriber_id,
          status: STATUS_LABELS.SENT_TO_PHARMACY,
          next_actor: 'pharmacy',
          submitted_at: now,
          handoff_at: null,
          decided_at: null,
          granted_refills: null,
          request_idempotency_key: null,
          version: 1,
        },
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction already ended; the original error is authoritative.
      }
      locked = false;
      // UNIQUE backstop (defense-in-depth): if a pathological double-writer
      // both passed the under-lock re-read, the loser's INSERT violates the
      // one-pending-per-prescription rule. ROLLBACK, re-read the
      // now-committed winner, and return it idempotently. A UNIQUE violation
      // with no committed winner row is not a resolvable race: re-throw.
      if (/UNIQUE constraint failed/i.test(String((err && err.message) || ''))) {
        const winner = db
          .prepare(`SELECT * FROM renewals WHERE prescription_id = ?`)
          .get(rxId);
        if (winner) {
          return {
            ok: true,
            code: isFinalStatus(winner.status) ? 'already-final' : 'already-pending',
            renewal: renewalView(winner),
            created: false,
            lockRetries,
          };
        }
        throw err;
      }
      return { ok: false, code: 'ask-save-failed', recoverable: true, lockRetries };
    }
  } finally {
    // The transaction (if still open) is discarded with the connection.
    db.close();
  }
}


/**
 * Pharmacy handoff: the assigned responsible pharmacy advances its own
 * 'Sent to pharmacy' renewal to 'Awaiting prescriber' — the SAME renewal
 * row — setting the prescriber role as next actor, recording the handoff
 * time, bumping the version, and inserting exactly one canonical
 * 'handoff' event, all atomically in one write transaction.
 *
 *   dbPath — the durable SQLite file.
 *   identity = { id, role } — the current durable session identity (the
 *                role comes from the server-side session, never from the
 *                client).
 *   renewalId — the server-resolved renewal record (the stable case ref is
 *                resolved by the caller before this point).
 *   options.failHandoffCommit — TEST-ONLY injected persistence failure
 *                AFTER the real UPDATE + event INSERT and BEFORE the
 *                COMMIT (mirrors the ask's failAskCommit seam). Off by
 *                default; the rollback is what removes the attempted
 *                writes.
 *
 * Outcomes:
 *   first handoff:  { ok: true, code: 'handed-off', handed_off: true,
 *                     renewal: renewalView, lockRetries }
 *   replay / repeat: { ok: true, code: 'already-handed-off',
 *                     handed_off: true, renewal: renewalView,
 *                     lockRetries } — the original handoff_at is
 *                     preserved; no second event is inserted.
 *   denial:         { ok: false, code: 'not-authorized', ... }
 *   save failure:   { ok: false, code: 'handoff-save-failed',
 *                     recoverable: true, lockRetries }
 *
 * The denial is deliberately OPAQUE: a renewal id that does not exist and
 * a renewal assigned to another pharmacy produce the exact same fixed
 * denial (the same no-existence-disclosure discipline as getRoleCase), and
 * no denial carries any case field. The same fixed denial { ok: false,
 * code: 'not-authorized' } is returned for ineligible or out-of-window
 * rows — the acting pharmacy no longer owns the case, no prescriber is
 * assigned, or the status is not 'Sent to pharmacy' / 'Awaiting prescriber'
 * (e.g. a final status): the record is not handable, and no event or state
 * change occurs. The under-lock eligibility check is applied before either
 * returning a replay or making the transition, and again to any committed
 * winner returned during the UNIQUE-recovery re-read.
 *
 * Integrity mirrors the ask transaction: one BEGIN IMMEDIATE write
 * transaction with the same bounded lock retry, an under-lock re-read,
 * and the renewal_events_one_handoff unique index as the defense-in-depth
 * backstop for a pathological double-writer (a rejected second event is
 * converted to the idempotent already-handed-off outcome when a committed
 * winner exists).
 */
export function handoffRenewalToPrescriber(dbPath, identity, renewalId, options = {}) {
  const id = identity && identity.id;
  const rnId =
    renewalId === undefined || renewalId === null ? '' : String(renewalId);
  const db = open(dbPath);
  let locked = false;
  let lockRetries = 0;
  try {
    // (1) Authorize (pure read on this short-lived connection): pharmacy
    // role, and object-level assignment to the requesting pharmacy.
    if (!identity || identity.role !== 'pharmacy' || !id) {
      return { ok: false, code: 'not-authorized' };
    }
    const row = db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(rnId);
    if (!row || row.pharmacy_id !== String(id)) {
      // One opaque result for an unknown id and an unrelated id: no
      // existence or assignment disclosure.
      return { ok: false, code: 'not-authorized' };
    }

    // (2) Acquire the write lock with the bounded retry. Observed
    // node:sqlite behavior: a concurrent writer makes BEGIN IMMEDIATE
    // throw "database is locked" immediately; the retry acquires it once
    // the holder releases (same loop as the ask path).
    const begin = db.prepare('BEGIN IMMEDIATE');
    for (let attempt = 1; attempt <= ASK_LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        begin.run();
        locked = true;
        break;
      } catch (err) {
        const message = String((err && err.message) || '');
        if (!/database is locked/i.test(message) && !/SQLITE_BUSY/i.test(message)) {
          throw err;
        }
        lockRetries += 1;
        if (attempt < ASK_LOCK_MAX_ATTEMPTS) askLockSleepSync(ASK_LOCK_RETRY_DELAY_MS);
      }
    }
    if (!locked) {
      // Budget exhausted under sustained contention: no durable state was
      // changed; the client may retry.
      return { ok: false, code: 'handoff-save-failed', recoverable: true, lockRetries };
    }

    // (3) Re-read the row under the write lock (fresh, AFTER acquisition),
    // and verify the under-lock eligibility before either returning a
    // replay or making the transition: the acting pharmacy must still own
    // the case and a prescriber must be assigned.
    const current = db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(rnId);
    if (!handoffEligible(current, id)) {
      // Ineligible row (ownership changed, prescriber unassigned, or the
      // record is gone): the plan's exact fixed denial, no status detail,
      // no event, no state change.
      db.exec('ROLLBACK');
      locked = false;
      return { ok: false, code: 'not-authorized' };
    }
    if (current.status === STATUS_LABELS.AWAITING_PRESCRIBER) {
      // Replay / overlapping loser: the handoff is already committed.
      // Roll back the no-op transaction and return the saved state
      // idempotently — the original handoff_at is preserved, and no
      // second event is inserted.
      db.exec('ROLLBACK');
      locked = false;
      return {
        ok: true,
        code: 'already-handed-off',
        handed_off: true,
        renewal: renewalView(current),
        lockRetries,
      };
    }
    if (current.status !== STATUS_LABELS.SENT_TO_PHARMACY) {
      // Eligible assignment but outside the handoff window (e.g. a final
      // status): the same fixed denial, no status detail, no event, no
      // state change.
      db.exec('ROLLBACK');
      locked = false;
      return { ok: false, code: 'not-authorized' };
    }

    // (4) The atomic writes inside the transaction: one renewal-row
    // update (guarded by the under-lock re-read) + one handoff event at
    // the same handoff time.
    const now = new Date().toISOString();
    try {
      db.prepare(
        `UPDATE renewals
            SET status = ?, next_actor = 'prescriber', handoff_at = ?,
                version = version + 1
          WHERE id = ?`
      ).run(STATUS_LABELS.AWAITING_PRESCRIBER, now, rnId);
      db.prepare(
        `INSERT INTO renewal_events
           (renewal_id, event_type, actor_role, actor_id, occurred_at, payload)
         VALUES (?, ?, 'pharmacy', ?, ?, ?)`
      ).run(
        rnId,
        EVENT_TYPES.HANDOFF,
        String(id),
        now,
        JSON.stringify({ synthetic: true, renewal_id: rnId })
      );
      // Injected persistence failure point: AFTER the UPDATE + INSERT and
      // BEFORE the COMMIT (mirrors the ask's failAskCommit seam). The
      // attempted writes are still inside the open transaction, so the
      // ROLLBACK below is what removes them.
      if (options && options.failHandoffCommit) {
        throw new Error('simulated SQLite failure while committing the handoff');
      }
      db.exec('COMMIT');
      locked = false;
      const updated = db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(rnId);
      return {
        ok: true,
        code: 'handed-off',
        handed_off: true,
        renewal: renewalView(updated),
        lockRetries,
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction already ended; the original error is authoritative.
      }
      locked = false;
      // UNIQUE backstop (defense-in-depth): a pathological double-writer's
      // second handoff event is rejected by the
      // renewal_events_one_handoff index. ROLLBACK, re-read the
      // now-committed row, and — only if it is eligible (acting pharmacy
      // still owns it, prescriber assigned) and already 'Awaiting
      // prescriber' — return it idempotently (mirrors the ask UNIQUE
      // catch). A UNIQUE violation with no eligible committed winner is
      // not a resolvable race: recoverable save failure.
      if (/UNIQUE constraint failed/i.test(String((err && err.message) || ''))) {
        const winner = db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(rnId);
        if (
          handoffEligible(winner, id) &&
          winner.status === STATUS_LABELS.AWAITING_PRESCRIBER
        ) {
          return {
            ok: true,
            code: 'already-handed-off',
            handed_off: true,
            renewal: renewalView(winner),
            lockRetries,
          };
        }
      }
      return { ok: false, code: 'handoff-save-failed', recoverable: true, lockRetries };
    }
  } finally {
    // The transaction (if still open) is discarded with the connection.
    db.close();
  }
}


export const PATIENT_PRESCRIPTION_STATES = Object.freeze({
  PENDING: 'pending',
  FINAL: 'final',
  NO_RENEWAL: 'no-renewal',
  INELIGIBLE: 'ineligible',
});

// One row per owned prescription. The LEFT JOIN selects the canonical
// renewal for the prescription when one exists: prefer the non-final
// record, then the earliest submitted_at, then the id — the same selection
// order askPatientForRenewal's under-lock re-read uses — so a prescription
// can never produce two list rows. Rows with a renewal sort first
// (earliest submitted first), then the remaining prescriptions by id.
const PATIENT_RX_SELECT_SQL = `
  SELECT p.id AS id,
         p.refills_remaining AS refills_remaining,
         ph.display_name AS pharmacy_name,
         pr.display_name AS prescriber_name,
         r.id AS renewal_id,
         r.status AS renewal_status,
         r.next_actor AS renewal_next_actor,
         r.submitted_at AS renewal_submitted_at,
         r.handoff_at AS renewal_handoff_at,
         r.decided_at AS renewal_decided_at,
         r.granted_refills AS renewal_granted_refills
    FROM prescriptions p
    JOIN identities ph ON ph.id = p.pharmacy_id
    JOIN identities pr ON pr.id = p.prescriber_id
    LEFT JOIN renewals r
      ON r.prescription_id = p.id
     AND r.id = (
          SELECT r2.id FROM renewals r2
           WHERE r2.prescription_id = p.id
           ORDER BY (r2.status IN (${sqlEnum(NON_FINAL_STATUSES)})) DESC,
                    r2.submitted_at, r2.id
           LIMIT 1
        )
   WHERE p.patient_id = ?
   ORDER BY (r.id IS NULL), (r.submitted_at IS NULL), r.submitted_at, p.id`;

function patientPrescriptionState(row) {
  if (row.renewal_id !== null && row.renewal_id !== undefined) {
    return isFinalStatus(row.renewal_status)
      ? PATIENT_PRESCRIPTION_STATES.FINAL
      : PATIENT_PRESCRIPTION_STATES.PENDING;
  }
  return Number(row.refills_remaining) === 0
    ? PATIENT_PRESCRIPTION_STATES.NO_RENEWAL
    : PATIENT_PRESCRIPTION_STATES.INELIGIBLE;
}

function patientPrescriptionView(row) {
  const view = {
    id: row.id,
    pharmacy_name: row.pharmacy_name,
    prescriber_name: row.prescriber_name,
    refills_remaining: row.refills_remaining,
    state: patientPrescriptionState(row),
  };
  if (row.renewal_id !== null && row.renewal_id !== undefined) {
    // Existing renewal details — present ONLY when a renewal exists.
    view.renewal_id = row.renewal_id;
    view.status = row.renewal_status;
    view.next_actor = row.renewal_next_actor ?? null;
    view.submitted_at = row.renewal_submitted_at ?? null;
    view.handoff_at = row.renewal_handoff_at ?? null;
    view.decided_at = row.renewal_decided_at ?? null;
    view.granted_refills = row.renewal_granted_refills ?? null;
    view.renewal_case_ref = caseRefFor(row.renewal_id);
  }
  return view;
}

/**
 * Patient prescription list (the patient queue of their OWN prescriptions)
 * with the ownership predicate applied: only the signed-in patient's own
 * prescriptions are returned, each with the server-derived state.
 *
 *   identity = { id, role } — the current durable session identity.
 *   success  = { ok: true, role: 'patient',
 *                prescriptions: [prescriptionView, ...] }  (may be empty)
 *   denial   = { ok: false, reason: 'not-authorized' }  (signed-in
 *                pharmacy or prescriber — the read is patient-role-only)
 *            | { ok: false, reason: 'unknown-role' }    (unrecognized
 *                role or unusable identity)
 *
 * Each prescriptionView:
 *   { id, pharmacy_name, prescriber_name, refills_remaining, state,
 *     [renewal_id, status, next_actor, submitted_at, handoff_at,
 *      decided_at, granted_refills, renewal_case_ref] }
 * The bracketed renewal fields (and the stable case reference) are present
 * ONLY when a renewal exists for the prescription.
 *
 * Read-only: a SELECT on one short-lived connection; a denial returns no
 * prescription field and changes no durable state.
 */
export function listPatientPrescriptions(dbPath, identity) {
  const role = identity && identity.role;
  if (!(identity && identity.id)) return deny('unknown-role');
  if (role !== 'patient') {
    return ROLE_OWNERSHIP_COLUMN[role]
      ? deny('not-authorized')
      : deny('unknown-role');
  }
  const db = open(dbPath);
  try {
    const rows = db.prepare(PATIENT_RX_SELECT_SQL).all(String(identity.id));
    return {
      ok: true,
      role: 'patient',
      prescriptions: rows.map(patientPrescriptionView),
    };
  } finally {
    db.close();
  }
}
