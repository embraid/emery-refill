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
  caseRefFor,
} from '../store.mjs';
import { startServer } from '../server.mjs';

const HTML = { Accept: 'text/html', Connection: 'close' };

// Case-data disclosure tokens: any fixture value appearing in a denial or
// anonymous page means case data was disclosed in the HTML.
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
  'handoff-view-rx', 'handoff-view-rn',
  '2026-11-21T11:00:00Z', '2026-11-21T11:30:00Z',
];

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
    `${label}: no inline event handlers (controls stay keyboard-operable natives)`);
}

function assertClearHeading(html, label, expectedHeading) {
  const m = html.match(/<h1>([\s\S]*?)<\/h1>/);
  assert.ok(m, `${label}: page has a clear <h1> heading`);
  if (expectedHeading !== undefined) {
    assert.equal(m[1].trim(), expectedHeading, `${label}: clear page heading text`);
  }
}

// --- minimal deterministic HTML helpers (server-rendered markup is stable) --

function definitionValue(html, term) {
  const m = html.match(new RegExp(`<dt>${term}</dt>\\s*<dd>([\\s\\S]*?)</dd>`));
  assert.ok(m, `detail page exposes the ${term} definition`);
  return m[1].trim();
}

function queueRows(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert.ok(tbody, 'queue page renders a queue table');
  const rows = [];
  for (const tr of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [];
    for (const td of tr[1].matchAll(/<td>([\s\S]*?)<\/td>/g)) {
      const inner = td[1];
      const link = inner.match(/<a href="([^"]+)">([\s\S]*?)<\/a>/);
      cells.push(link
        ? { text: link[2].trim(), href: link[1] }
        : { text: inner.trim(), href: null });
    }
    rows.push(cells);
  }
  return rows;
}

async function fetchHtml(url, { headers = {}, ...rest } = {}) {
  const res = await fetch(url, { headers: { ...HTML, ...headers }, ...rest });
  const text = await res.text();
  return { res, text };
}

// Form sign-in as a browser would submit the labeled form: urlencoded
// POST to /sign-in; on success the server 303-redirects to the return
// target (the role queue by default, or the page the visitor came from
// when the sign-in prompt carried a returnTo) and sets the HttpOnly
// session cookie.
async function formSignIn(base, username, password, { expectOk = true, returnTo = null } = {}) {
  const fields = [`username=${encodeURIComponent(username)}`, `password=${encodeURIComponent(password)}`];
  if (returnTo !== null) fields.push(`returnTo=${encodeURIComponent(returnTo)}`);
  const res = await fetch(`${base}/sign-in`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...HTML, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: fields.join('&'),
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (expectOk) {
    assert.equal(res.status, 303, `${username}: form sign-in redirects to the return target`);
    if (returnTo === null) {
      assert.equal(res.headers.get('location'), '/cases', `${username}: redirect lands on the role queue`);
    } else {
      assert.equal(res.headers.get('location'), returnTo, `${username}: redirect lands back on the requested page`);
    }
    assert.ok(sessionCookie, `${username}: form sign-in sets the session cookie`);
    for (const attribute of ['HttpOnly', 'SameSite=Lax']) {
      assert.ok(sessionCookie.includes(attribute), `${username}: cookie carries ${attribute}`);
    }
  }
  const token = sessionCookie
    ? sessionCookie.slice(`${SESSION_COOKIE_NAME}=`.length).split(';')[0]
    : null;
  const text = await res.text();
  return { res, token, cookieHeader: token ? `${SESSION_COOKIE_NAME}=${token}` : null, text };
}

async function formSignOut(base, cookieHeader) {
  const res = await fetch(`${base}/sign-out`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...HTML, Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(res.status, 303, 'form sign-out redirects');
  assert.equal(res.headers.get('location'), '/', 'sign-out lands back on the landing page');
  return res;
}

// Submit the rendered sign-out form exactly as a browser submits it after
// activating its native submit button: an empty urlencoded POST from the
// bound form to the form's action URL, carrying the session cookie.
// Returns the response and the session token it carried.
async function submitSignOutForm(base, cookieHeader, { formAttrs = null, expectOk = true } = {}) {
  const action = formAttrs?.action ?? '/sign-out';
  const res = await fetch(`${base}${action}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...HTML, Cookie: cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  const clearCookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
    .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? null;
  if (expectOk) {
    assert.equal(res.status, 303, 'sign-out form submission redirects');
    assert.equal(res.headers.get('location'), '/', 'sign-out lands back on the landing page');
    assert.ok(clearCookie, 'sign-out form submission clears the session cookie');
    for (const attribute of ['Max-Age=0', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
      assert.ok(clearCookie.includes(attribute), `clear-cookie carries ${attribute}`);
    }
  }
  return { res, clearCookie };
}

// Parse the sign-out wiring straight out of a returned signed-in page:
// the native form (id, method, action) and the bound submit button (type,
// form, visible text) — all as plain HTML attributes, no script involved.
function signOutWiring(html, label) {
  const form = html.match(/<form id="sign-out-form"([^>]*)><\/form>/);
  assert.ok(form, `${label}: page carries the sign-out form element`);
  const formAttrs = {};
  for (const attr of form[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)) formAttrs[attr[1]] = attr[2];
  assert.equal(formAttrs.method, 'post', `${label}: sign-out form method is post`);
  assert.equal(formAttrs.action, '/sign-out', `${label}: sign-out form action is the existing sign-out route`);
  assert.ok(formAttrs['aria-label'], `${label}: sign-out form has an accessible name`);

  const button = html.match(/<button([^>]*)>Sign out<\/button>/);
  assert.ok(button, `${label}: page carries a sign-out button with the visible text "Sign out"`);
  const btnAttrs = {};
  for (const attr of button[1].matchAll(/\s([a-z-]+)="([^"]*)"/g)) btnAttrs[attr[1]] = attr[2];
  assert.equal(btnAttrs.type, 'submit', `${label}: sign-out button is a native type="submit" button`);
  assert.equal(btnAttrs.form, 'sign-out-form', `${label}: sign-out button is bound to the sign-out form via the form attribute`);
  assert.ok(
    /<label class="signout-label">Sign out:\s*<button/.test(html),
    `${label}: the sign-out button is wrapped in its visible <label>`
  );
  assert.ok(!/type="button"/.test(html), `${label}: page has no inert type="button" control`);
  assert.ok(!/<script[\s>]/i.test(html), `${label}: no script backs the sign-out control`);
  return { formAttrs, btnAttrs };
}

function makeEnv(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-fixture-${tag}-`));
  const dbPath = join(dir, 'fixture.sqlite');
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  const db = initDatabase(dbPath);
  return { dir, dbPath, db };
}

// The saved fixture rows read DIRECTLY from SQLite: the test compares the
// rendered HTML against the authoritative durable state, not a hardcoded
// copy.
function savedCases(db) {
  return db
    .prepare(
      `SELECT r.id, r.status, r.next_actor, rx.refills_remaining,
              p.display_name AS patient_name,
              ph.display_name AS pharmacy_name,
              pr.display_name AS prescriber_name
         FROM renewals r
         JOIN identities p  ON p.id  = r.patient_id
         JOIN identities ph ON ph.id = r.pharmacy_id
         JOIN identities pr ON pr.id = r.prescriber_id
         JOIN prescriptions rx ON rx.id = r.prescription_id
        ORDER BY r.submitted_at IS NULL, r.submitted_at, r.id`
    )
    .all();
}

const NEXT_ACTOR_TEXT = { patient: 'Patient', pharmacy: 'Pharmacy', prescriber: 'Prescriber' };

const ROLE_SETUP = [
  { role: 'patient', username: 'ava.mercer', password: 'patient-ava-2026', expected: ['ending-a-renewal'] },
  { role: 'pharmacy', username: 'pharmacy.cedar', password: 'pharmacy-cedar-2026', expected: ['ending-a-renewal', 'ending-b-renewal'] },
  { role: 'prescriber', username: 'dr.priya.raman', password: 'prescriber-priya-2026', expected: ['ending-b-renewal'] },
];

for (const setup of ROLE_SETUP) {
  test(`HTML: ${setup.role} signs in, follows the queue link, and the displayed status/next actor match the saved fixture (queue, detail, refresh, fresh session, restart)`, async () => {
    const env = makeEnv(setup.role);
    let app;
    try {
      app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${app.port}`;
      const saved = savedCases(env.db);
      const mySaved = saved.filter((r) => r.id in Object.fromEntries(setup.expected.map((id) => [id, 1])));
      assert.deepEqual(
        mySaved.map((r) => r.id),
        setup.expected,
        `${setup.role}: the saved fixture subset this role is authorized for`
      );

      // --- sign in (native form, labeled controls) ----------------------
      const first = await formSignIn(base, setup.username, setup.password);

      // --- queue: role-appropriate, visible saved state ------------------
      const queue = await fetchHtml(`${base}/cases`, { headers: { Cookie: first.cookieHeader } });
      assert.equal(queue.res.status, 200, `${setup.role}: queue status`);
      assertClearHeading(queue.text, `${setup.role} queue`, `${setup.role[0].toUpperCase()}${setup.role.slice(1)} queue`);
      assertNoPickupReadyHtml(queue.text, `${setup.role} queue`);
      assertNoScriptsOrHandlers(queue.text, `${setup.role} queue`);

      const rows = queueRows(queue.text);
      assert.equal(rows.length, mySaved.length, `${setup.role}: queue has exactly the saved authorized rows`);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const rec = mySaved[i];
        assert.equal(row.length, 5, `${setup.role} queue row has the five columns`);
        // Column 1: the patient name is the stable, labeled queue link.
        assert.equal(row[0].text, rec.patient_name, `${setup.role} queue row ${i}: patient name`);
        assert.match(row[0].href, /^\/cases\?case=[0-9a-f]{32}$/,
          `${setup.role} queue row ${i}: stable same-origin detail link`);
        assert.equal(row[1].text, rec.pharmacy_name, `${setup.role} queue row ${i}: pharmacy`);
        assert.equal(row[2].text, rec.prescriber_name, `${setup.role} queue row ${i}: prescriber`);
        // Visible saved status and next actor text (plain <td> content).
        assert.equal(row[3].text, rec.status, `${setup.role} queue row ${i}: displayed status matches the saved fixture`);
        assert.equal(row[4].text, NEXT_ACTOR_TEXT[rec.next_actor],
          `${setup.role} queue row ${i}: displayed next actor matches the saved fixture`);
      }

      // --- follow the first queue link (the copied-link target) ----------
      const detailUrl = `${base}${rows[0][0].href}`;
      const detail = await fetchHtml(detailUrl, { headers: { Cookie: first.cookieHeader } });
      assert.equal(detail.res.status, 200, `${setup.role}: following the queue link renders the detail view`);
      assertClearHeading(detail.text, `${setup.role} detail`, `${setup.role[0].toUpperCase()}${setup.role.slice(1)} case: ${mySaved[0].patient_name}`);
      assertNoPickupReadyHtml(detail.text, `${setup.role} detail`);
      assertNoScriptsOrHandlers(detail.text, `${setup.role} detail`);
      assert.equal(definitionValue(detail.text, 'Status'), mySaved[0].status,
        `${setup.role} detail: displayed status matches the saved fixture`);
      assert.equal(definitionValue(detail.text, 'Next actor'), NEXT_ACTOR_TEXT[mySaved[0].next_actor],
        `${setup.role} detail: displayed next actor matches the saved fixture`);
      assert.equal(definitionValue(detail.text, 'Patient'), mySaved[0].patient_name,
        `${setup.role} detail: patient`);
      assert.equal(
        definitionValue(detail.text, 'Prescription refills remaining'),
        String(mySaved[0].refills_remaining),
        `${setup.role} detail: saved prescription refills remaining matches the durable store`
      );
      // The detail page's back link is a same-origin link to the queue.
      assert.ok(/<a href="\/cases">Back to my queue<\/a>/.test(detail.text),
        `${setup.role} detail: labeled same-origin back-to-queue link`);

      // --- refresh: re-GET the exact same URL ----------------------------
      const refreshed = await fetchHtml(detailUrl, { headers: { Cookie: first.cookieHeader } });
      assert.equal(refreshed.res.status, 200, `${setup.role}: refresh re-GET succeeds`);
      assert.equal(definitionValue(refreshed.text, 'Status'), mySaved[0].status,
        `${setup.role}: refresh shows the same persisted status`);
      assert.equal(definitionValue(refreshed.text, 'Next actor'), NEXT_ACTOR_TEXT[mySaved[0].next_actor],
        `${setup.role}: refresh shows the same persisted next actor`);
      // The queue still renders the same saved state after the detail visit.
      const queueAgain = await fetchHtml(`${base}/cases`, { headers: { Cookie: first.cookieHeader } });
      assert.deepEqual(queueRows(queueAgain.text), rows, `${setup.role}: queue is unchanged after refresh`);

      // --- fresh session using the COPIED URL ----------------------------
      // The copied URL is the literal string captured above — no session
      // data in it; the server rechecks the CURRENT user's authorization.
      const invalidatedBefore = env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
      assert.equal(invalidatedBefore, 1, 'exactly one committed session before sign-out');
      await formSignOut(base, first.cookieHeader);
      assert.equal(
        env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
        0,
        'sign-out invalidated the server-side session'
      );

      // The copied URL with the now-invalid session gets the clear denial
      // (401 sign-in prompt) — and the same URL signed in fresh works.
      const dead = await fetchHtml(detailUrl, { headers: { Cookie: first.cookieHeader } });
      assert.equal(dead.res.status, 401, `${setup.role}: copied URL with invalidated session is denied`);
      assert.ok(
        dead.text.includes('No signed-in session is available; sign in first.'),
        `${setup.role}: invalid-session denial has the clear, readable error text`
      );
      assertNoCaseDataHtml(dead.text, `${setup.role} invalid-session denial page`);

      // --- copied URL with NO session: the sign-in prompt carries the
      //     return target; signing in lands back on the SAME copied URL
      //     and the server reauthorizes it for the fresh session.
      const prompt = await fetchHtml(detailUrl);
      assert.equal(prompt.res.status, 401, `${setup.role}: anonymous copied URL shows the sign-in prompt`);
      assert.ok(
        prompt.text.includes(`<input type="hidden" name="returnTo" value="${rows[0][0].href}">`),
        `${setup.role}: sign-in prompt preserves the copied page as the return target`
      );
      assertNoCaseDataHtml(prompt.text, `${setup.role} anonymous sign-in prompt`);
      const reentered = await formSignIn(base, setup.username, setup.password, { returnTo: rows[0][0].href });
      assert.notEqual(reentered.token, first.token, 're-sign-in issues an independent new session token');
      assert.ok(
        reentered.res.headers.get('location') === rows[0][0].href,
        `${setup.role}: after re-sign-in the browser lands back on the copied URL`
      );
      const landed = await fetchHtml(detailUrl, { headers: { Cookie: reentered.cookieHeader } });
      assert.equal(landed.res.status, 200, `${setup.role}: copied URL resolves in the fresh session`);
      assert.equal(definitionValue(landed.text, 'Status'), mySaved[0].status,
        `${setup.role}: fresh session shows the same persisted status`);
      assert.equal(definitionValue(landed.text, 'Next actor'), NEXT_ACTOR_TEXT[mySaved[0].next_actor],
        `${setup.role}: fresh session shows the same persisted next actor`);

      const second = reentered;

      // --- server process restart against the same database file ---------
      const firstPort = app.port;
      await app.close();
      app = null;
      app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: firstPort });
      assert.equal(app.port, firstPort, 'restart rebinds the same ephemeral port');
      const restarted = await fetchHtml(detailUrl, { headers: { Cookie: second.cookieHeader } });
      assert.equal(restarted.res.status, 200, `${setup.role}: copied URL resolves after server restart`);
      assert.equal(definitionValue(restarted.text, 'Status'), mySaved[0].status,
        `${setup.role}: restart shows the same persisted status`);
      assert.equal(definitionValue(restarted.text, 'Next actor'), NEXT_ACTOR_TEXT[mySaved[0].next_actor],
        `${setup.role}: restart shows the same persisted next actor`);
    } finally {
      await app?.close();
      env.db.close();
      rmSync(env.dir, { recursive: true, force: true });
    }
  });
}

test('HTML: sign-in page has a clear heading, named labeled keyboard-operable controls, and clear readable errors', async () => {
  const env = makeEnv('signin');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // --- anonymous landing: the sign-in page -----------------------------
    const landing = await fetchHtml(`${base}/`);
    assert.equal(landing.res.status, 200);
    assert.equal(landing.res.headers.get('content-type'), 'text/html; charset=utf-8');
    assertClearHeading(landing.text, 'landing', 'Refill Relay — sign in');
    assertNoPickupReadyHtml(landing.text, 'sign-in page');
    assertNoScriptsOrHandlers(landing.text, 'sign-in page');

    // Native, named, labeled form controls (label wraps the input).
    assert.match(landing.text, /<form id="sign-in-form" method="post" action="\/sign-in" aria-label="Sign in to Refill Relay">/,
      'sign-in form is a native POST form with an accessible name and destination');
    assert.match(landing.text, /<label>Username:\s*<input type="text" name="username" id="sign-in-username"[^>]*required>\s*<\/label>/,
      'username control: named input labeled "Username"');
    assert.match(landing.text, /<label>Password:\s*<input type="password" name="password" id="sign-in-password"[^>]*required>\s*<\/label>/,
      'password control: named input labeled "Password"');
    assert.match(landing.text, /<button type="submit">Sign in<\/button>/,
      'named, keyboard-operable submit button with visible text');

    // --- wrong password: clear, readable error, no session ---------------
    const wrong = await formSignIn(base, 'ava.mercer', 'not-the-password', { expectOk: false });
    assert.equal(wrong.res.status, 401, 'wrong password is a 401 sign-in error page');
    assert.equal(wrong.token, null, 'no session cookie is issued on failed sign-in');
    assert.match(wrong.text, /<p id="sign-in-error" class="error"[^>]*>Sign-in failed\. Check the username and password for this local synthetic account\.<\/p>/,
      'failed sign-in renders the clear error text in a stable-id error paragraph');
    assert.match(wrong.text, /<button type="submit">Sign in<\/button>/,
      'the form is still present and operable after a failed sign-in');
    assert.equal(
      env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      0,
      'failed sign-in created no session row'
    );

    // --- unknown username: the same clear error (no account disclosure) --
    const unknown = await formSignIn(base, 'mallory', 'whatever', { expectOk: false });
    assert.equal(unknown.res.status, 401, 'unknown username is a 401 sign-in error page');
    assert.equal(
      unknown.text,
      wrong.text,
      'unknown username and wrong password produce the identical clear error page'
    );
    assertNoCaseDataHtml(unknown.text, 'unknown-username sign-in page');

    // --- valid sign-in lands on the queue (label/controls already proven) -
    const ok = await formSignIn(base, 'boris.laine', 'patient-boris-2026');

    // --- returnTo is same-origin only (no open redirect) ------------------
    for (const evil of ['https://evil.example/cases', '//evil.example/cases', 'http://evil.example', '/cases?x=1#frag']) {
      const res = await fetch(`${base}/sign-in`, {
        method: 'POST',
        redirect: 'manual',
        headers: { ...HTML, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `username=boris.laine&password=patient-boris-2026&returnTo=${encodeURIComponent(evil)}`,
      });
      const location = res.headers.get('location');
      assert.ok(
        location === '/cases' || location.startsWith('/cases?'),
        `returnTo ${JSON.stringify(evil)} must not become an open redirect (got ${JSON.stringify(location)})`
      );
    }
    const queue = await fetchHtml(`${base}/cases`, { headers: { Cookie: ok.cookieHeader } });
    assert.equal(queue.res.status, 200);
    // The signed-in header exposes a genuine, named, labeled,
    // keyboard-operable sign-out control: a native <button type="submit">
    // bound (form attribute) to the native POST form that targets the
    // existing /sign-out route (no inert type="button", no JavaScript).
    assert.match(queue.text,
      /<label class="signout-label">Sign out:\s*<button type="submit" form="sign-out-form">Sign out<\/button>\s*<\/label>/,
      'signed-in pages carry a named, labeled sign-out submit button');
    assert.match(queue.text, /<form id="sign-out-form" method="post" action="\/sign-out" aria-label="Sign out of Refill Relay"><\/form>/,
      'sign-out is a genuine native form that POSTs to the existing /sign-out route');
    assert.ok(!queue.text.includes('type="button"'),
      'the sign-out control is not an inert type="button" control');
    assert.ok(queue.text.includes(`Signed in as <span class="who">Boris Laine (patient)</span>`),
      'the signed-in identity is displayed as visible text');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('HTML: the sign-out control is a genuine native form that POSTs to /sign-out and invalidates the session (all three roles)', async () => {
  const env = makeEnv('signout-form');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    for (const setup of ROLE_SETUP) {
      // --- sign in and capture the authorized role's copied case URL ----
      const client = await formSignIn(base, setup.username, setup.password);
      const queue = await fetchHtml(`${base}/cases`, { headers: { Cookie: client.cookieHeader } });
      assert.equal(queue.res.status, 200, `${setup.role}: queue before sign-out`);
      const detailHref = queueRows(queue.text)[0][0].href;
      const detailUrl = `${base}${detailHref}`;

      // --- form wiring on the queue page AND the detail page ------------
      const queueWiring = signOutWiring(queue.text, `${setup.role} queue page`);
      const detailPage = await fetchHtml(detailUrl, { headers: { Cookie: client.cookieHeader } });
      signOutWiring(detailPage.text, `${setup.role} detail page`);

      // Exactly one committed session for this client so far in this env?
      // No — the three role clients accumulate; count before/after only.
      const before = env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
      assert.ok(before >= 1, 'a committed session exists before sign-out');

      // --- submit the rendered form exactly as a browser would: POST the
      //     empty urlencoded body to the form's OWN declared action URL, as
      //     parsed from the returned HTML (not a hardcoded default). ------
      const submitted = await submitSignOutForm(base, client.cookieHeader, { formAttrs: queueWiring.formAttrs });

      // Session invalidation in the durable store (read directly from
      // SQLite, same as the saved-fixture comparisons above).
      const after = env.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;
      assert.equal(after, before - 1, `${setup.role}: form submission deleted exactly this session row`);
      const staleToken = client.cookieHeader.split('=')[1];
      assert.equal(
        env.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token = ?`).get(staleToken).n,
        0,
        `${setup.role}: the submitted session token no longer resolves in SQLite`
      );

      // --- the SAME copied case link, reused: clear denial, no data -----
      const reused = await fetchHtml(detailUrl, { headers: { Cookie: client.cookieHeader } });
      assert.equal(reused.res.status, 401,
        `${setup.role}: reusing the copied case link after sign-out is denied (401)`);
      assert.ok(
        reused.text.includes('<p id="sign-in-error" class="error" tabindex="-1">No signed-in session is available; sign in first.</p>'),
        `${setup.role}: the denied reused link shows the clear, readable sign-in error`
      );
      assert.ok(
        reused.text.includes(`<input type="hidden" name="returnTo" value="${detailHref}">`),
        `${setup.role}: the denied reused link is preserved as the sign-in return target`
      );
      assertNoCaseDataHtml(reused.text, `${setup.role} denied reused-link page`);
      assertNoPickupReadyHtml(reused.text, `${setup.role} denied reused-link page`);

      // The invalidated session cannot read the queue either, and the
      // landing page is the anonymous sign-in page (no sign-out form).
      const queueDead = await fetchHtml(`${base}/cases`, { headers: { Cookie: client.cookieHeader } });
      assert.equal(queueDead.res.status, 401, `${setup.role}: invalidated session is denied on the queue too`);
      const landing = await fetchHtml(`${base}/`, { headers: { Cookie: client.cookieHeader } });
      assert.equal(landing.res.status, 200, 'landing after sign-out is the anonymous sign-in page');
      assert.ok(!landing.text.includes('sign-out-form'), 'anonymous landing page renders no sign-out form');

      // --- re-sign-in as the same role: the copied URL works again ------
      const reentered = await formSignIn(base, setup.username, setup.password, { returnTo: detailHref });
      assert.notEqual(reentered.token, client.cookieHeader.split('=')[1],
        `${setup.role}: re-sign-in issues a fresh independent session token`);
      const landed = await fetchHtml(detailUrl, { headers: { Cookie: reentered.cookieHeader } });
      assert.equal(landed.res.status, 200,
        `${setup.role}: after re-sign-in the same copied case link resolves again`);
      const saved = env.db.prepare(`SELECT status, next_actor FROM renewals WHERE id = ?`).get(setup.expected[0]);
      assert.equal(definitionValue(landed.text, 'Status'), saved.status,
        `${setup.role}: re-signed-in reused link shows the saved status`);
      assert.equal(definitionValue(landed.text, 'Next actor'), NEXT_ACTOR_TEXT[saved.next_actor],
        `${setup.role}: re-signed-in reused link shows the saved next actor`);
    }
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('HTML: an unrelated session gets a clear denial without case data, and no durable state changes', async () => {
  const env = makeEnv('denial');
  let app;
  let db = env.db;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // The authorized patient obtains her stable copied URL.
    const ava = await formSignIn(base, 'ava.mercer', 'patient-ava-2026');
    const queue = await fetchHtml(`${base}/cases`, { headers: { Cookie: ava.cookieHeader } });
    const copiedUrl = `${base}${queueRows(queue.text)[0][0].href}`;
    const detail = await fetchHtml(copiedUrl, { headers: { Cookie: ava.cookieHeader } });
    assert.equal(detail.res.status, 200, 'authorized patient reads her case');
    assert.equal(definitionValue(detail.text, 'Status'), STATUS_LABELS.RENEWAL_APPROVED,
      'authorized detail shows the saved status');

    // --- unrelated sessions: patient, pharmacy, prescriber ---------------
    const cleo = await formSignIn(base, 'cleo.voss', 'patient-cleo-2026');
    const dunmore = await formSignIn(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const emil = await formSignIn(base, 'dr.emil.hart', 'prescriber-emil-2026');

    const snapshot = (table, order) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => Object.values(r));
    const before = {
      sessions: snapshot('sessions', 'token'),
      identities: snapshot('identities', 'id'),
      prescriptions: snapshot('prescriptions', 'id'),
      renewals: snapshot('renewals', 'id'),
      renewal_events: snapshot('renewal_events', 'id'),
      pharmacy_conversation_messages: snapshot('pharmacy_conversation_messages', 'id'),
      office_messages: snapshot('office_messages', 'id'),
      phone_notes: snapshot('phone_notes', 'id'),
      synthetic_accounts: snapshot('synthetic_accounts', 'username'),
      markers: snapshot('markers', 'key'),
    };
    assert.equal(before.sessions.length, 4, 'reference includes all four sign-in sessions');

    const denied = [];
    for (const [label, cookieHeader] of [
      ['unrelated patient', cleo.cookieHeader],
      ['unrelated pharmacy', dunmore.cookieHeader],
      ['unrelated prescriber', emil.cookieHeader],
    ]) {
      const res = await fetchHtml(copiedUrl, { headers: { Cookie: cookieHeader } });
      assert.equal(res.res.status, 403, `${label}: copied case link is denied`);
      assertClearHeading(res.text, `${label} denial`, 'Access denied');
      assert.ok(
        res.text.includes('<p id="page-error" class="error" tabindex="-1">This case is not available for your signed-in role.</p>'),
        `${label}: clear, readable denial message with a stable error id`
      );
      assertNoCaseDataHtml(res.text, `${label} denial page`);
      assertNoPickupReadyHtml(res.text, `${label} denial page`);
      // The denial page is fixed and identity-free: it offers a same-origin
      // path back to sign-in and never echoes the signed-in identity or any
      // record value.
      assert.ok(/<a href="\/">Go to sign in<\/a>/.test(res.text),
        `${label}: denial page offers a same-origin sign-in link`);
      assert.ok(!res.text.includes('Cleo Voss') && !res.text.includes('Dunmore Corner Pharmacy') && !res.text.includes('Dr. Emil Hart'),
        `${label}: denial page is fixed and carries no identity`);
      denied.push(res);
    }
    assert.equal(denied[1].text, denied[0].text, 'denial pages are byte-identical across unrelated sessions');
    assert.equal(denied[2].text, denied[0].text, 'denial pages are byte-identical across roles');

    // An unknown case reference (a ref no record maps to) denies with the
    // SAME clear page — no record-existence disclosure.
    const unknownRef = `${base}/cases?case=${'0'.repeat(32)}`;
    const unknown = await fetchHtml(unknownRef, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(unknown.res.status, 403, 'unknown case ref is denied');
    assert.ok(unknown.text.includes('This case is not available for your signed-in role.'),
      'unknown case ref uses the same clear denial message');
    assertNoCaseDataHtml(unknown.text, 'unknown-ref denial page');
    assert.equal(unknown.text, denied[0].text,
      'an unknown case ref produces the byte-identical denial: no record existence disclosure');

    // Anonymous opener: the clear sign-in prompt, no case data.
    const anon = await fetchHtml(copiedUrl);
    assert.equal(anon.res.status, 401, 'anonymous copied link is denied');
    assert.ok(anon.text.includes('No signed-in session is available; sign in first.'),
      'anonymous denial has the clear, readable error text');
    assertNoCaseDataHtml(anon.text, 'anonymous denial page');

    // The unrelated identities' own queues are authorized EMPTY reads:
    // they show the clear visible empty state and NO queue table, so no
    // case row of any record can appear. (Their own signed-in name in the
    // page header is their own identity, not case data of a record.)
    for (const [label, client] of [['cleo', cleo], ['dunmore', dunmore], ['emil', emil]]) {
      const res = await fetchHtml(`${base}/cases`, { headers: { Cookie: client.cookieHeader } });
      assert.equal(res.res.status, 200, `${label}: own queue is an authorized read`);
      assert.ok(
        res.text.includes('No saved renewal cases are currently assigned to your role.'),
        `${label}: empty queue states this clearly as visible text`
      );
      assert.ok(!/<table>/.test(res.text), `${label}: empty queue renders no case rows`);
      for (const token of ['ending-a-renewal', 'ending-b-renewal', 'Ava Mercer', 'Boris Laine',
        'Dr. Naomi Okafor', 'Dr. Priya Raman', 'Cedar Crossing Pharmacy',
        STATUS_LABELS.SENT_TO_PHARMACY, STATUS_LABELS.RENEWAL_APPROVED]) {
        assert.ok(!res.text.includes(token), `${label}: own empty queue discloses no other record value`);
      }
    }

    // Durable state after the denial section equals the reference exactly.
    const after = {
      sessions: snapshot('sessions', 'token'),
      identities: snapshot('identities', 'id'),
      prescriptions: snapshot('prescriptions', 'id'),
      renewals: snapshot('renewals', 'id'),
      renewal_events: snapshot('renewal_events', 'id'),
      pharmacy_conversation_messages: snapshot('pharmacy_conversation_messages', 'id'),
      office_messages: snapshot('office_messages', 'id'),
      phone_notes: snapshot('phone_notes', 'id'),
      synthetic_accounts: snapshot('synthetic_accounts', 'username'),
      markers: snapshot('markers', 'key'),
    };
    for (const table of Object.keys(before)) {
      assert.deepEqual(after[table], before[table], `${table}: denials make no durable-state change`);
    }

    // Cross-connection reread (simulated restart): state still identical.
    db.close();
    db = null;
    const reopened = initDatabase(env.dbPath);
    try {
      const caseRow = reopened.prepare(`SELECT status, next_actor FROM renewals WHERE id = 'ending-a-renewal'`).get();
      assert.deepEqual(
        { status: caseRow.status, next_actor: caseRow.next_actor },
        { status: STATUS_LABELS.RENEWAL_APPROVED, next_actor: 'pharmacy' },
        'saved case state (status, next actor) unchanged after the denial section'
      );
      assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n, 4,
        'exactly the four sign-in sessions remain');
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

test('HTML: the JSON contract is preserved (no HTML Accept → identical JSON bodies)', async () => {
  const env = makeEnv('json-contract');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // The built-in test fetch default (Accept */*) is still JSON.
    const root = await fetch(`${base}/`, { headers: { Connection: 'close' } });
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await root.json(), { ok: true, signed_in: false, identity: null });

    // Explicit application/json is JSON too.
    const rootJson = await fetch(`${base}/`, { headers: { Accept: 'application/json', Connection: 'close' } });
    assert.equal(rootJson.headers.get('content-type'), 'application/json; charset=utf-8');

    // Sign in (JSON), then the JSON queue + detail contracts.
    const signIn = await fetch(`${base}/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ username: 'pharmacy.cedar', password: 'pharmacy-cedar-2026' }),
    });
    const token = (signIn.headers.get('set-cookie') ?? '').match(/rfrl_session=([0-9a-f]+)/)[1];
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const queue = await fetch(`${base}/cases`, { headers: { Cookie: cookie, Connection: 'close' } });
    assert.equal(queue.status, 200);
    const queueJson = await queue.json();
    assert.equal(queueJson.role, 'pharmacy');
    assert.equal(queueJson.cases.length, 2);
    assert.equal(queueJson.cases[0].status, STATUS_LABELS.RENEWAL_APPROVED);
    assert.equal(queueJson.cases[1].status, STATUS_LABELS.SENT_TO_PHARMACY);

    // Both detail forms over JSON: literal id and stable opaque ref.
    const detailId = await fetch(`${base}/cases?id=ending-a-renewal`, { headers: { Cookie: cookie, Connection: 'close' } });
    assert.equal(detailId.status, 200);
    assert.equal((await detailId.json()).case.id, 'ending-a-renewal');
    const htmlQueue = await fetchHtml(`${base}/cases`, { headers: { Cookie: cookie } });
    const ref = queueRows(htmlQueue.text)[0][0].href.split('case=')[1];
    const detailRef = await fetch(`${base}/cases?case=${ref}`, { headers: { Cookie: cookie, Connection: 'close' } });
    assert.equal(detailRef.status, 200, 'stable opaque ref also resolves over JSON');
    assert.equal((await detailRef.json()).case.id, 'ending-a-renewal');
    const detailPath = await fetch(`${base}/case/${ref}`, { headers: { Cookie: cookie, Connection: 'close' } });
    assert.equal(detailPath.status, 200, 'path form with the opaque ref resolves over JSON');
    const detailPathId = await fetch(`${base}/case/ending-a-renewal`, { headers: { Cookie: cookie, Connection: 'close' } });
    assert.equal(detailPathId.status, 200, 'Literal-id path form still resolves');
    assert.equal((await detailPathId.json()).case.id, 'ending-a-renewal');

    // HTML Accept gets the rendered page for the same routes.
    const htmlRoot = await fetchHtml(`${base}/cases`, { headers: { Cookie: cookie } });
    assert.equal(htmlRoot.res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(htmlRoot.text.includes('<h1>Pharmacy queue</h1>'), 'HTML Accept renders the queue page');

    // Unknown route: fixed 404 in both shapes, no case data.
    const missingJson = await fetch(`${base}/no-such-route`, { headers: { Connection: 'close' } });
    assert.equal(missingJson.status, 404);
    assert.deepEqual(await missingJson.json(), { ok: false, error: 'not-found', message: 'Unknown route.' });
    const missingHtml = await fetchHtml(`${base}/no-such-route`);
    assert.equal(missingHtml.res.status, 404);
    assertClearHeading(missingHtml.text, 'HTML 404', 'Page not found');
    assertNoCaseDataHtml(missingHtml.text, 'HTML 404 page');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('HTML: the patient prescriptions page passes the role-view heuristics for every row state (additive, existing role views unchanged)', async () => {
  const env = makeEnv('listing-states');
  let app;
  try {
    env.db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES ('listing-eligible-rx', 'denial-patient', 'pharmacy-dunmore', 'denial-prescriber', 0, 1)`
    ).run();
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    // --- Cleo: one no-renewal (ask form) + one ineligible (notice) -------
    const cleo = await formSignIn(base, 'cleo.voss', 'patient-cleo-2026');
    const cleoPage = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: cleo.cookieHeader } });
    assert.equal(cleoPage.res.status, 200, 'Cleo prescriptions page status');
    assertClearHeading(cleoPage.text, 'Cleo prescriptions page', 'Patient prescriptions');
    assertNoPickupReadyHtml(cleoPage.text, 'Cleo prescriptions page');
    assertNoScriptsOrHandlers(cleoPage.text, 'Cleo prescriptions page');

    const rows = queueRowsOf(cleoPage.text);
    assert.equal(rows.length, 2, 'Cleo sees her eligible + ineligible prescriptions');
    // Select rows by their saved refill count (robust to the stable id order).
    const eligibleRow = rows.find((r) => r[2].text === '0');
    const ineligibleRow = rows.find((r) => r[2].text === '1');
    assert.ok(eligibleRow, 'the eligible zero-refill row is present');
    assert.ok(ineligibleRow, 'the ineligible one-refill row is present');
    // The visible state text is from the closed map (visible text, not
    // ARIA-only): 'No renewal yet' / 'Not eligible for a renewal request'.
    assert.equal(eligibleRow[3].text, 'No renewal yet', 'eligible row: visible state text from the closed map');
    assert.equal(ineligibleRow[3].text, 'Not eligible for a renewal request', 'ineligible row: visible state text from the closed map');
    // Eligible no-renewal — the ONLY ask form: a labeled native POST to /ask
    // carrying her eligible prescription id, with a keyboard-operable submit.
    const form = eligibleRow[4].raw.match(
      /<form[^>]*method="post"[^>]*action="\/ask"[^>]*aria-label="Ask my pharmacy">\s*<input type="hidden" name="prescription_id" value="listing-eligible-rx">\s*<button type="submit">Ask my pharmacy<\/button>\s*<\/form>/
    );
    assert.ok(form, 'eligible no-renewal row renders the labeled native ask form with the named hidden prescription_id');
    assert.ok(!eligibleRow[4].raw.includes('<a '), 'eligible row: no case link (no renewal yet)');
    assert.equal((eligibleRow[4].raw.match(/<form/g) ?? []).length, 1, 'eligible row: exactly one form');
    // Ineligible — fixed visible notice, no form, no link.
    assert.ok(
      ineligibleRow[4].raw.includes('This prescription is not eligible for a renewal request.'),
      'ineligible row: fixed visible notice'
    );
    assert.equal(ineligibleRow[4].href, null, 'ineligible row: no case link');
    assert.ok(!/<form/.test(ineligibleRow[4].raw), 'ineligible row: no ask form');
    // The whole page holds exactly ONE ask form (only the eligible row).
    assert.equal((cleoPage.text.match(/<form[^>]*action="\/ask"/g) ?? []).length, 1,
      'Cleo page: exactly one ask form across all rows');

    // --- Ava: one final (terminal) row — case link, NO ask form -----------
    const ava = await formSignIn(base, 'ava.mercer', 'patient-ava-2026');
    const avaPage = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: ava.cookieHeader } });
    assert.equal(avaPage.res.status, 200, 'Ava prescriptions page status');
    assertClearHeading(avaPage.text, 'Ava prescriptions page', 'Patient prescriptions');
    assertNoPickupReadyHtml(avaPage.text, 'Ava prescriptions page');
    assertNoScriptsOrHandlers(avaPage.text, 'Ava prescriptions page');
    const avaRows = queueRowsOf(avaPage.text);
    assert.equal(avaRows.length, 1, 'Ava sees her terminal prescription');
    assert.equal(avaRows[0][3].text, 'Renewal decided', 'final row: visible state text from the closed map');
    assert.match(avaRows[0][4].href, /^\/cases\?case=[0-9a-f]{32}$/,
      'final row: action is a same-origin stable case link');
    assert.equal(avaRows[0][4].text, 'View this renewal', 'final row: the link has visible text');
    assert.ok(!avaRows[0][4].raw.includes('<form'), 'final row: no ask form (no new cycle)');
    assert.equal((avaPage.text.match(/<form[^>]*action="\/ask"/g) ?? []).length, 0, 'Ava page: no ask forms at all');

    // --- Boris: one pending row — case link, NO ask form ------------------
    const boris = await formSignIn(base, 'boris.laine', 'patient-boris-2026');
    const borisPage = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: boris.cookieHeader } });
    assert.equal(borisPage.res.status, 200, 'Boris prescriptions page status');
    assertNoPickupReadyHtml(borisPage.text, 'Boris prescriptions page');
    assertNoScriptsOrHandlers(borisPage.text, 'Boris prescriptions page');
    const borisRows = queueRowsOf(borisPage.text);
    assert.equal(borisRows.length, 1, 'Boris sees his pending prescription');
    assert.equal(borisRows[0][3].text, 'Renewal pending', 'pending row: visible state text from the closed map');
    assert.match(borisRows[0][4].href ?? '', /^\/cases\?case=[0-9a-f]{32}$/,
      'pending row: action is a same-origin stable case link');
    assert.equal(borisRows[0][4].text, 'View this renewal', 'pending row: the link has visible text');
    assert.equal((borisPage.text.match(/<form[^>]*action="\/ask"/g) ?? []).length, 0, 'Boris page: no ask forms at all');

    // --- the case links resolve to the saved case details -----------------
    const avaDetail = await fetchHtml(`${base}${avaRows[0][4].href}`, { headers: { Cookie: ava.cookieHeader } });
    assert.equal(avaDetail.res.status, 200, 'Ava case link resolves to the saved terminal case');
    assert.ok(avaDetail.text.includes(STATUS_LABELS.RENEWAL_APPROVED), 'terminal detail shows the saved status');
    const borisDetail = await fetchHtml(`${base}${borisRows[0][4].href}`, { headers: { Cookie: boris.cookieHeader } });
    assert.equal(borisDetail.res.status, 200, 'Boris case link resolves to the saved pending case');
    assert.ok(borisDetail.text.includes(STATUS_LABELS.SENT_TO_PHARMACY), 'pending detail shows the saved status');

    // --- non-patient and anonymous denials of the new page (heuristic) ----
    const dunmore = await formSignIn(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const denied = await fetchHtml(`${base}/prescriptions`, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(denied.res.status, 403, 'pharmacy: prescriptions page denied');
    assertClearHeading(denied.text, 'pharmacy prescriptions denial', 'Access denied');
    assertNoCaseDataHtml(denied.text, 'pharmacy prescriptions denial page');
    assertNoScriptsOrHandlers(denied.text, 'pharmacy prescriptions denial page');
    const anon = await fetchHtml(`${base}/prescriptions`);
    assert.equal(anon.res.status, 401, 'anonymous: prescriptions page denied');
    assertNoCaseDataHtml(anon.text, 'anonymous prescriptions prompt page');

    // --- no durable-state change from the whole section -------------------
    const snap = (table, order) =>
      env.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => Object.values(r));
    const after = {
      sessions: snap('sessions', 'token'),
      identities: snap('identities', 'id'),
      prescriptions: snap('prescriptions', 'id'),
      renewals: snap('renewals', 'id'),
      renewal_events: snap('renewal_events', 'id'),
      pharmacy_conversation_messages: snap('pharmacy_conversation_messages', 'id'),
      office_messages: snap('office_messages', 'id'),
      phone_notes: snap('phone_notes', 'id'),
      synthetic_accounts: snap('synthetic_accounts', 'username'),
      markers: snap('markers', 'key'),
    };
    assert.equal(after.prescriptions.filter((r) => r[0] === 'listing-eligible-rx').length, 1,
      'exactly one seeded eligible rx was added');
    assert.ok(after.prescriptions.every((r) => ['denial-rx', 'ending-a-rx', 'ending-b-rx', 'listing-eligible-rx'].includes(r[0])),
      'no other prescription rows were added by the view checks');
    assert.equal(after.renewals.length, 2, 'no renewal rows were created by the view checks');
    assert.equal(after.renewal_events.length, 0, 'no event rows were created by the view checks');
    assert.equal(after.sessions.length, 4, 'only the four sign-in sessions exist');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// Parse the patient prescriptions page table into rows of cell objects
// ({ text, href }) — the same shape queueRows() returns for the role queue,
// so the estate heuristics apply to the new page unchanged. The Action cell
// may hold a form (no <a>) or a link; the form case is matched separately
// by the assertions above against the raw HTML.
function queueRowsOf(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  assert.ok(tbody, 'prescriptions page renders a table body');
  const rows = [];
  for (const tr of tbody[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [];
    for (const td of tr[1].matchAll(/<td>([\s\S]*?)<\/td>/g)) {
      const raw = td[1];
      const link = raw.match(/<a href="([^"]+)">([\s\S]*?)<\/a>/);
      const textOnly = raw
        .replace(/<form[\s\S]*?<\/form>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      cells.push(link
        ? { text: link[2].trim(), href: link[1], raw }
        : { text: textOnly, href: null, raw });
    }
    rows.push(cells);
  }
  return rows;
}

test('HTML: no rendered page for any role/state contains pickup-ready text (source/rendered scan)', async () => {
  const env = makeEnv('nopickup');
  let app;
  try {
    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;
    const pages = [];
    pages.push(await fetchHtml(`${base}/`)); // sign-in (anonymous)
    for (const [username, password] of [
      ['ava.mercer', 'patient-ava-2026'],
      ['pharmacy.cedar', 'pharmacy-cedar-2026'],
      ['dr.priya.raman', 'prescriber-priya-2026'],
    ]) {
      const client = await formSignIn(base, username, password);
      const queue = await fetchHtml(`${base}/cases`, { headers: { Cookie: client.cookieHeader } });
      pages.push(queue);
      for (const row of queueRows(queue.text)) {
        const detail = await fetchHtml(`${base}${row[0].href}`, { headers: { Cookie: client.cookieHeader } });
        pages.push(detail);
      }
    }
    for (const [label, page] of pages.entries()) {
      assertNoPickupReadyHtml(page.text, `rendered page ${label}`);
    }
    assert.ok(pages.length >= 8, 'the scan covered the sign-in, queue, and detail pages for every role');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// --- pharmacy handoff form: presence / absence / no scripts ----------------

// The one handoff form the estate renders: a native POST to /handoff whose
// only field is the stable case_ref and whose control is a native
// keyboard-operable submit button. Matched as plain HTML attributes — no
// script involvement.
const HANDOFF_FORM_RE =
  /<form method="post" action="\/handoff" aria-label="Request renewal">\s*<input type="hidden" name="case_ref" value="([0-9a-f]{32})">\s*<button type="submit">Request renewal<\/button>\s*<\/form>/;

function assertNoHandoffForm(html, label) {
  const m = html.match(/<form[^>]*action="\/handoff"/g) ?? [];
  assert.equal(m.length, 0, `${label}: no handoff form`);
}

function assertOneHandoffForm(html, label, expectedRef) {
  const m = html.match(HANDOFF_FORM_RE);
  assert.ok(m, `${label}: detail page carries a native Request renewal form POSTing to /handoff`);
  const all = html.match(/<form[^>]*action="\/handoff"/g) ?? [];
  assert.equal(all.length, 1, `${label}: exactly one handoff form on the page`);
  assert.equal(m[1], expectedRef, `${label}: the hidden field carries the STABLE case reference`);
  // No other control type could shadow the submit (no inert button, no
  // inline handler, no script anywhere on the page).
  assertNoScriptsOrHandlers(html, label);
  assert.ok(!/type="button"/.test(html), `${label}: no inert type="button" control`);
}

function detailUrlForCase(base, caseId) {
  return `${base}/cases?case=${caseRefFor(caseId)}`;
}

test('HTML: the pharmacy handoff form renders exactly once for the assigned pharmacy in Sent to pharmacy and never for other roles, the unrelated pharmacy, or other statuses (no inline scripts or handlers)', async () => {
  const env = makeEnv('handoff-form');
  let app;
  try {
    // A second assigned, still 'Sent to pharmacy' case for the SAME
    // pharmacy (a fresh prescription + non-final renewal) proves the
    // presence is not tied to one record id. An extra terminal case for a
    // different assigned pharmacy adds a second role to the absent-status
    // scan.
    env.db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES ('handoff-view-rx', 'ending-b-patient', 'pharmacy-cedar', 'ending-b-prescriber', 0, 1)`
    ).run();
    env.db.prepare(
      `INSERT INTO renewals (id, prescription_id, patient_id, pharmacy_id, prescriber_id, status, next_actor, submitted_at, handoff_at)
       VALUES ('handoff-view-rn', 'handoff-view-rx', 'ending-b-patient', 'pharmacy-cedar', 'ending-b-prescriber', ?, 'pharmacy', '2026-11-21T11:00:00Z', NULL)`
    ).run(STATUS_LABELS.SENT_TO_PHARMACY);
    env.db.prepare(
      `INSERT INTO renewals (id, prescription_id, patient_id, pharmacy_id, prescriber_id, status, next_actor, submitted_at, handoff_at, decided_at, granted_refills)
       VALUES ('ending-d-renewal', 'denial-rx', 'denial-patient', 'pharmacy-dunmore', 'denial-prescriber', ?, 'pharmacy', '2026-11-21T11:00:00Z', '2026-11-21T11:30:00Z', '2026-11-21T12:00:00Z', 1)`
    ).run(STATUS_LABELS.RENEWAL_APPROVED);

    app = await startServer({ dbPath: env.dbPath, host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.port}`;

    const cedar = await formSignIn(base, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    const dunmore = await formSignIn(base, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    const boris = await formSignIn(base, 'boris.laine', 'patient-boris-2026');
    const priya = await formSignIn(base, 'dr.priya.raman', 'prescriber-priya-2026');
    const emil = await formSignIn(base, 'dr.emil.hart', 'prescriber-emil-2026');

    // Whole-table state reference BEFORE any page is read (the denial and
    // absence sections must not change durable state).
    const snapshot = (table, order) =>
      env.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => Object.values(r));
    const before = {
      sessions: snapshot('sessions', 'token'),
      identities: snapshot('identities', 'id'),
      prescriptions: snapshot('prescriptions', 'id'),
      renewals: snapshot('renewals', 'id'),
      renewal_events: snapshot('renewal_events', 'id'),
      pharmacy_conversation_messages: snapshot('pharmacy_conversation_messages', 'id'),
      office_messages: snapshot('office_messages', 'id'),
      phone_notes: snapshot('phone_notes', 'id'),
      synthetic_accounts: snapshot('synthetic_accounts', 'username'),
      markers: snapshot('markers', 'key'),
    };
    assert.equal(before.renewals.length, 4, 'reference includes the two seeded fixture cases + two added view cases');
    assert.equal(before.renewal_events.length, 0, 'no event rows exist before the view checks');

    const refB = caseRefFor('ending-b-renewal');
    const refView = caseRefFor('handoff-view-rn');

    // --- PRESENCE 1: the assigned pharmacy on a 'Sent to pharmacy' case --
    const bDetail = await fetchHtml(detailUrlForCase(base, 'ending-b-renewal'), { headers: { Cookie: cedar.cookieHeader } });
    assert.equal(bDetail.res.status, 200, 'assigned pharmacy reads the Sent to pharmacy case');
    assertClearHeading(bDetail.text, 'cedar detail b', 'Pharmacy case: Boris Laine');
    assertNoPickupReadyHtml(bDetail.text, 'cedar detail b');
    assertNoScriptsOrHandlers(bDetail.text, 'cedar detail b');
    assertOneHandoffForm(bDetail.text, 'cedar detail b (ending-b-renewal)', refB);
    // The page still shows the saved pre-handoff state next to the form.
    assert.equal(definitionValue(bDetail.text, 'Status'), STATUS_LABELS.SENT_TO_PHARMACY, 'detail b shows the saved status');
    assert.equal(definitionValue(bDetail.text, 'Next actor'), 'Pharmacy', 'detail b shows the saved next actor');
    assert.equal(definitionValue(bDetail.text, 'Handoff at'), 'Not recorded', 'detail b shows no handoff time yet');

    // --- PRESENCE 2: the other assigned 'Sent to pharmacy' case ----------
    const viewDetail = await fetchHtml(detailUrlForCase(base, 'handoff-view-rn'), { headers: { Cookie: cedar.cookieHeader } });
    assert.equal(viewDetail.res.status, 200, 'assigned pharmacy reads the second Sent to pharmacy case');
    assertOneHandoffForm(viewDetail.text, 'cedar detail (handoff-view-rn)', refView);
    assert.equal(definitionValue(viewDetail.text, 'Status'), STATUS_LABELS.SENT_TO_PHARMACY, 'detail view shows the saved status');

    // --- ABSENCE: prescriber role (assigned prescriber, same case) -------
    const bDetailPrescriber = await fetchHtml(detailUrlForCase(base, 'ending-b-renewal'), { headers: { Cookie: priya.cookieHeader } });
    assert.equal(bDetailPrescriber.res.status, 200, 'assigned prescriber reads the same case');
    assertClearHeading(bDetailPrescriber.text, 'priya detail b', 'Prescriber case: Boris Laine');
    assertNoScriptsOrHandlers(bDetailPrescriber.text, 'priya detail b');
    assertNoHandoffForm(bDetailPrescriber.text, 'priya detail b (prescriber role)');
    assert.equal(definitionValue(bDetailPrescriber.text, 'Status'), STATUS_LABELS.SENT_TO_PHARMACY, 'prescriber detail shows the saved status');

    // --- ABSENCE: patient role (the case patient) -------------------------
    const bDetailPatient = await fetchHtml(detailUrlForCase(base, 'ending-b-renewal'), { headers: { Cookie: boris.cookieHeader } });
    assert.equal(bDetailPatient.res.status, 200, 'case patient reads the same case');
    assertNoScriptsOrHandlers(bDetailPatient.text, 'boris detail b');
    assertNoHandoffForm(bDetailPatient.text, 'boris detail b (patient role)');
    assert.equal(definitionValue(bDetailPatient.text, 'Status'), STATUS_LABELS.SENT_TO_PHARMACY, 'patient detail shows the saved status');

    // --- ABSENCE: the unrelated pharmacy (denied before render) ----------
    const bDetailUnrelated = await fetchHtml(detailUrlForCase(base, 'ending-b-renewal'), { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(bDetailUnrelated.res.status, 403, 'unrelated pharmacy is denied the case before any render');
    assertClearHeading(bDetailUnrelated.text, 'dunmore denial', 'Access denied');
    assertNoCaseDataHtml(bDetailUnrelated.text, 'dunmore denial page');
    assertNoScriptsOrHandlers(bDetailUnrelated.text, 'dunmore denial page');
    assertNoHandoffForm(bDetailUnrelated.text, 'dunmore denial page (unrelated pharmacy)');

    // --- ABSENCE: the unrelated prescriber (denied before render) --------
    const bDetailUnrelatedPresc = await fetchHtml(detailUrlForCase(base, 'ending-b-renewal'), { headers: { Cookie: emil.cookieHeader } });
    assert.equal(bDetailUnrelatedPresc.res.status, 403, 'unrelated prescriber is denied the case before any render');
    assertNoScriptsOrHandlers(bDetailUnrelatedPresc.text, 'emil denial page');
    assertNoHandoffForm(bDetailUnrelatedPresc.text, 'emil denial page (unrelated prescriber)');

    // --- ABSENCE: any non-'Sent to pharmacy' status ----------------------
    // Cedar's approved terminal case: the pharmacy still reads it, but the
    // form is withheld because the status is no longer 'Sent to pharmacy'.
    const aDetail = await fetchHtml(`${base}/cases?case=${caseRefFor('ending-a-renewal')}`, { headers: { Cookie: cedar.cookieHeader } });
    assert.equal(aDetail.res.status, 200, 'pharmacy reads the approved terminal case');
    assertNoScriptsOrHandlers(aDetail.text, 'cedar detail a');
    assertNoHandoffForm(aDetail.text, 'cedar detail a (Renewal approved status)');
    assert.equal(definitionValue(aDetail.text, 'Status'), STATUS_LABELS.RENEWAL_APPROVED, 'detail a shows the approved status');
    assert.equal(definitionValue(aDetail.text, 'Handoff at'), '2026-11-21T08:30:00Z', 'detail a shows the saved handoff time');
    // Dunmore's approved terminal case: a second role with a non-Sent status.
    const dDetail = await fetchHtml(`${base}/cases?case=${caseRefFor('ending-d-renewal')}`, { headers: { Cookie: dunmore.cookieHeader } });
    assert.equal(dDetail.res.status, 200, 'dunmore reads its approved terminal case');
    assertNoScriptsOrHandlers(dDetail.text, 'dunmore detail d');
    assertNoHandoffForm(dDetail.text, 'dunmore detail d (Renewal approved status)');
    assert.equal(definitionValue(dDetail.text, 'Status'), STATUS_LABELS.RENEWAL_APPROVED, 'detail d shows the approved status');

    // --- PRESENCE (UI-driven): submit the rendered form as a browser would
    //     (native form POST of the hidden case_ref), then the same durable
    //     page shows the saved state and NO handoff form (the status is no
    //     longer 'Sent to pharmacy').
    const form = bDetail.text.match(HANDOFF_FORM_RE);
    assert.ok(form, 'the cedar detail b page still carries the handoff form before submission');
    const submittedRef = form[1];
    const formPost = await fetch(`${base}/handoff`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...HTML, Cookie: cedar.cookieHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `case_ref=${encodeURIComponent(submittedRef)}`,
    });
    assert.equal(formPost.status, 303, 'native form POST to /handoff redirects on success');
    assert.equal(formPost.headers.get('location'), `/cases?case=${refB}`, 'the form POST lands back on the stable case detail URL');
    const afterRow = env.db.prepare(`SELECT status, next_actor, handoff_at, version FROM renewals WHERE id = 'ending-b-renewal'`).get();
    assert.equal(afterRow.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'the form POST durably handed off the case');
    assert.equal(afterRow.next_actor, 'prescriber', 'the form POST set the prescriber as next actor');
    assert.ok(typeof afterRow.handoff_at === 'string' && afterRow.handoff_at.length > 0, 'the form POST recorded a handoff time');
    assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = 'ending-b-renewal' AND event_type = 'handoff'`).get().n, 1, 'the form POST recorded exactly one handoff event');

    const bDetailAfter = await fetchHtml(detailUrlForCase(base, 'ending-b-renewal'), { headers: { Cookie: cedar.cookieHeader } });
    assert.equal(bDetailAfter.res.status, 200, 'the same case detail re-renders after the handoff');
    assertClearHeading(bDetailAfter.text, 'cedar detail b after', 'Pharmacy case: Boris Laine');
    assertNoScriptsOrHandlers(bDetailAfter.text, 'cedar detail b after');
    assertNoPickupReadyHtml(bDetailAfter.text, 'cedar detail b after');
    assertNoHandoffForm(bDetailAfter.text, 'cedar detail b after handoff (status is no longer Sent to pharmacy)');
    assert.equal(definitionValue(bDetailAfter.text, 'Status'), STATUS_LABELS.AWAITING_PRESCRIBER, 'after handoff the detail shows Awaiting prescriber');
    assert.equal(definitionValue(bDetailAfter.text, 'Next actor'), 'Prescriber', 'after handoff the detail shows the prescriber next actor');
    assert.equal(definitionValue(bDetailAfter.text, 'Handoff at'), afterRow.handoff_at, 'after handoff the detail shows the saved handoff time');
    // The seeded second 'Sent to pharmacy' case still offers its own form.
    const viewDetailAfter = await fetchHtml(detailUrlForCase(base, 'handoff-view-rn'), { headers: { Cookie: cedar.cookieHeader } });
    assert.equal(viewDetailAfter.res.status, 200, 'the second case is unaffected');
    assertOneHandoffForm(viewDetailAfter.text, 'cedar detail (handoff-view-rn) after the other handoff', refView);

    // --- Durable state: reads + denials changed nothing except the one UI
    //     handoff performed above (its single renewal-row update + single
    //     handoff event). The queue/detail READS and every DENIAL in this
    //     test made no durable change; only the UI-driven form POST did.
    const after = {
      sessions: snapshot('sessions', 'token'),
      identities: snapshot('identities', 'id'),
      prescriptions: snapshot('prescriptions', 'id'),
      renewals: snapshot('renewals', 'id'),
      renewal_events: snapshot('renewal_events', 'id'),
      pharmacy_conversation_messages: snapshot('pharmacy_conversation_messages', 'id'),
      office_messages: snapshot('office_messages', 'id'),
      phone_notes: snapshot('phone_notes', 'id'),
      synthetic_accounts: snapshot('synthetic_accounts', 'username'),
      markers: snapshot('markers', 'key'),
    };
    // Tables that must be byte-identical (no form is ever rendered to a
    // denial, and reads are read-only).
    for (const table of ['identities', 'prescriptions', 'phone_notes', 'office_messages', 'pharmacy_conversation_messages', 'synthetic_accounts', 'markers']) {
      assert.deepEqual(after[table], before[table], `${table}: the handoff-form view checks make no durable-state change`);
    }
    assert.equal(after.renewals.length, before.renewals.length, 'no renewal row was created');
    // Exactly one renewal row (ending-b-renewal) changed: its status, next
    // actor, handoff time, and version from the one UI-driven handoff.
    const beforeB = before.renewals.find((r) => r[0] === 'ending-b-renewal');
    const afterB = after.renewals.find((r) => r[0] === 'ending-b-renewal');
    assert.equal(afterB[5], afterRow.status, 'ending-b-renewal status is now Awaiting prescriber');
    assert.notDeepEqual(beforeB, afterB, 'ending-b-renewal changed exactly once (the handoff)');
    // Every other renewal row is byte-identical to the reference.
    for (let i = 0; i < after.renewals.length; i += 1) {
      if (after.renewals[i][0] !== 'ending-b-renewal') {
        assert.deepEqual(after.renewals[i], before.renewals[i], `${after.renewals[i][0]}: unchanged by the view checks`);
      }
    }
    // Exactly one handoff event now exists — the one from the UI handoff.
    assert.equal(after.renewal_events.length, 1, 'exactly one handoff event after the UI handoff');
    assert.equal(after.renewal_events[0][1], 'ending-b-renewal', 'the single event is for the handed-off case');
    assert.equal(after.renewal_events[0][2], 'handoff', 'the single event is a handoff event');
    assert.equal(after.renewal_events[0][5], afterRow.handoff_at, 'the single event carries the handoff time');
  } finally {
    await app?.close();
    env.db.close();
    rmSync(env.dir, { recursive: true, force: true });
  }
});
