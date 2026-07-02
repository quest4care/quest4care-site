// QCLS Form Submission Handler v6
// Vercel Serverless Function → Neon One API
// Creates account, adds to Provisional group, sets custom fields, triggers workflow

const NEON_ORG = 'quest4care';
const NEON_BASE = 'https://api.neoncrm.com/v2';

// ── Field IDs from neon_config.txt (generated 2026-06-29) ──
const FIELD_IDS = {
  followUpNeeded:    '153',
  followUpNeededYes: '198',  // "Yes"
  followUpNeededNo:  '199',  // "No"
  followUpType:      '154',
  followUpSource:    '156',
  programInterest:   '87',
  county:            '91',
  interestArea:      '83',
  // NEW — append-only text field, never overwritten. Create this in Neon (plain text,
  // same "Navigation Survey"-style group is fine, or a new "History" group) and paste
  // the resulting ID here. Until filled in, history tracking for Program Interest is
  // skipped — the "live" programInterest field still updates normally either way.
  programInterestHistory: '248',
  // NEW — plain text field storing an ISO timestamp of the most recent submission.
  // Used only to detect rapid back-to-back resubmits (accidental double-clicks,
  // same-session corrections) vs. a genuinely new inquiry weeks/months later.
  lastSubmittedAt: '249',
  // NEW — captures whatever the person actually wrote in the "Tell us more" box
  // on the original form (individual/org/volunteer forms have this; provider
  // doesn't). Lets the confirmation email show their own words back to them
  // instead of just Name/County/Source. Cross-pillar, not pillar-prefixed, since
  // every form type feeds into it the same way.
  initialMessage: '250', // raw text, passed to the survey's acknowledgment box
  // NEW — a computed, natural-reading paragraph combining primary need + county +
  // message into one sentence, for the confirmation email. Replaces a bare
  // Name/County/Submitted-Via bullet table, which read like a form dump rather
  // than something a person actually processed.
  initialSummary: '251',
  // NEW — captures whether this submission is for the account holder or someone
  // else (a family member, friend, or client they're helping). The form asked
  // this from the start but the answer was previously discarded entirely.
  reachingOutFor: '252',
  personName: '253', // the other person's name, if reachingOutFor = someone-else
  // NEW — append-only, never overwritten. Deliberately SEPARATE from initialMessage
  // (250) rather than making that field itself append-only — initialMessage still
  // needs to hold just the CURRENT message, since the survey's acknowledgment box
  // reads it directly via URL param and would break if it suddenly contained a
  // whole multi-line history instead of one message.
  initialMessageHistory: '256',
  smsConsent: '93', // Checkbox, single option id=62 — write only when checked, omit when not
};

// How close together two submissions have to be to count as "the same burst" rather
// than a genuinely new inquiry. Tune freely — 15 minutes is a reasonable starting
// point for "probably an accidental double-submit or quick correction," while
// anything beyond this (hours, days, months later) is treated as a real new case.
// Controls TWO decisions: whether to re-tag Provisional, and whether to create a
// new membership/fire a new acknowledgment email. Both should agree on what counts
// as "the same burst" — a genuinely new inquiry deserves both, not just one.
const RAPID_RESUBMIT_WINDOW_MS = 15 * 60 * 1000;

// Human-readable labels, used only for the append-only history field so it reads
// clearly at a glance (the live dropdown field still uses PROGRAM_INTEREST's option IDs)
const PROGRAM_INTEREST_LABELS = {
  individual:   'OurWalk™ (Community Access Navigation)',
  organization: 'FoundationReady™ Assessment',
  provider:     'qPartner™ (Provider Network)',
  volunteer:    'weCARES™ (Volunteer)',
  donation:     'General Inquiry',
  default:      'General Inquiry',
};

// Program Interest option IDs
const PROGRAM_INTEREST = {
  individual:   '31', // Community Access Navigation
  organization: '32', // FoundationReady Assessment
  provider:     '33', // Provider Network
  volunteer:    '34', // Volunteer
  donation:     '35', // General Inquiry
  default:      '35', // General Inquiry
};

// County option IDs
const COUNTY_IDS = {
  'Henry County':        '59',
  'Madison County':      '60',
  'Both Counties':       '59', // map to Henry, note both in message
  'Other Indiana County': '61',
  'Other':               '61',
};

// Follow-Up Type option IDs
const FOLLOWUP_TYPE = {
  individual:   '209', // Navigation Follow-Up
  organization: '208', // Grant Readiness Review
  provider:     '209', // Navigation Follow-Up
  volunteer:    '209', // Navigation Follow-Up
  default:      '210', // Other
};

const PROVISIONAL_GROUP_ID = '31';

// Membership levels confirmed live in Neon — all $0 fee, all ACTIVE
// Used with sendAcknowledgeEmail:true to fire an INSTANT native email
// (confirmed working live June 29, 2026 — see DOC03 Decision Record)
const MEMBERSHIP_MAP = {
  individual:   { levelId: '4', termId: '7' }, // OurWalk Navigation Participant
  organization: { levelId: '2', termId: '3' }, // FoundationReady Client
  provider:     { levelId: '3', termId: '5' }, // qPartner Provider Network Member
  volunteer:    { levelId: '8', termId: '15' }, // weCARES Volunteer
  default:      { levelId: '1', termId: '1' }, // QCLS Community
};

function authHeader() {
  const key = process.env.NEON_API_KEY;
  return 'Basic ' + Buffer.from(`${NEON_ORG}:${key}`).toString('base64');
}

const headers = () => ({
  'Authorization': authHeader(),
  'Content-Type': 'application/json',
  'Accept': 'application/json'
});

async function neonPost(path, body) {
  const res = await fetch(`${NEON_BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { status: res.status, data: {} }; }
}

async function neonPatch(path, body) {
  const res = await fetch(`${NEON_BASE}${path}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { status: res.status, data: {} }; }
}

async function neonGet(path) {
  const res = await fetch(`${NEON_BASE}${path}`, {
    method: 'GET',
    headers: headers()
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { status: res.status, data: {} }; }
}

// ── Append-only Program Interest history — never overwrites, works for every
// request type. Reads whatever's already there, adds today's entry, writes it back.
// If the field isn't configured yet (programInterestHistory is null) or the read
// fails for any reason, this just skips — the live programInterest field still
// updates normally either way, so nothing about the actual submission breaks.
async function appendProgramInterestHistory(accountId, formType, prefetchedAccount) {
  if (!FIELD_IDS.programInterestHistory) return { status: 0, data: { skipped: 'field not configured yet' } };

  try {
    const acct = prefetchedAccount || await neonGet(`/accounts/${accountId}`);
    const isCompany = !!acct.data?.companyAccount;
    const wrapper = isCompany ? 'companyAccount' : 'individualAccount';
    const existingFields = acct.data?.[wrapper]?.accountCustomFields || [];
    const existingEntry = existingFields.find(f => String(f.fieldId || f.id) === String(FIELD_IDS.programInterestHistory));
    const existingValue = existingEntry?.value || '';

    const today = new Date();
    const todayStr = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
    const label = PROGRAM_INTEREST_LABELS[formType] || PROGRAM_INTEREST_LABELS.default;
    const newEntry = `${todayStr}: ${label}`;
    const combined = existingValue ? `${existingValue}\n${newEntry}` : newEntry;

    return neonPatch(`/accounts/${accountId}`, {
      [wrapper]: { accountCustomFields: [{ id: FIELD_IDS.programInterestHistory, value: combined }] }
    });
  } catch (err) {
    console.error('Program Interest history append failed (non-fatal):', err);
    return { status: 0, data: { error: 'append failed, see logs' } };
  }
}

// ── Check whether the account already holds a membership at this exact level —
// (Previously there was a check here for "does any membership already exist at
// this level, ever" — replaced by the rapid-resubmit time window above, since
// that version incorrectly blocked genuinely new inquiries weeks/months later,
// not just accidental double-submits. See createAcknowledgmentMembership below.)

// ── Read the last-submitted timestamp BEFORE this submission overwrites it —
// used to decide whether this looks like a rapid duplicate resubmit or a genuinely
// new inquiry. Defaults to "treat as new" (null) if the field isn't configured yet
// or the read fails, so a real submission is never silently short-circuited.
async function getLastSubmittedAt(accountId, prefetchedAccount) {
  if (!FIELD_IDS.lastSubmittedAt) return null;
  try {
    const acct = prefetchedAccount || await neonGet(`/accounts/${accountId}`);
    const isCompany = !!acct.data?.companyAccount;
    const wrapper = isCompany ? 'companyAccount' : 'individualAccount';
    const existingFields = acct.data?.[wrapper]?.accountCustomFields || [];
    const entry = existingFields.find(f => String(f.fieldId || f.id) === String(FIELD_IDS.lastSubmittedAt));
    return entry?.value ? new Date(entry.value) : null;
  } catch (err) {
    console.error('Reading last-submitted timestamp failed (defaulting to "treat as new"):', err);
    return null;
  }
}

// ── Find existing account by email ──
async function findAccountByEmail(email) {
  const r = await neonPost('/accounts/search', {
    searchFields: [{ field: 'Email', operator: 'EQUAL', value: email }],
    outputFields: ['Account ID', 'First Name', 'Last Name'],
    pagination: { currentPage: 0, pageSize: 1 }
  });
  return r.data?.searchResults?.[0]?.['Account ID'] || null;
}

// ── Create individual account ──
async function createIndividual(payload) {
  const parts = (payload.name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  const r = await neonPost('/accounts', {
    individualAccount: {
      primaryContact: {
        firstName,
        lastName,
        email1: payload.email,
        phone1: payload.phone || ''
      }
    }
  });
  return { id: r.data?.id || null, status: r.status, raw: r.data };
}

// ── Create company account ──
async function createCompany(payload) {
  const parts = (payload.name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  const r = await neonPost('/accounts', {
    companyAccount: {
      name: payload.organization,
      primaryContact: {
        firstName,
        lastName,
        email1: payload.email,
        phone1: payload.phone || ''
      }
    }
  });
  return { id: r.data?.id || null, status: r.status, raw: r.data };
}

// ── Update custom fields using correct optionValues structure ──
// ── Builds one natural-reading sentence from the initial form's data, for the
// confirmation email. Replaces a bare Name/County/Submitted-Via bullet table —
// this is what actually makes the email feel like someone processed the request
// instead of just logging it. Fully grounded in structured data + their own
// written words, nothing invented, no AI — same principle as the survey's
// buildConstituentSummary in survey-submit.js.
// ── Append-only Initial Message history — never overwrites, mirrors the exact
// same pattern as appendProgramInterestHistory. Reuses the already-fetched
// account to avoid another redundant GET.
async function appendInitialMessageHistory(accountId, message, prefetchedAccount) {
  if (!FIELD_IDS.initialMessageHistory || !message) return { status: 0, data: { skipped: 'field not configured yet or nothing to log' } };
  try {
    const acct = prefetchedAccount || await neonGet(`/accounts/${accountId}`);
    const isCompany = !!acct.data?.companyAccount;
    const wrapper = isCompany ? 'companyAccount' : 'individualAccount';
    const existingFields = acct.data?.[wrapper]?.accountCustomFields || [];
    const existingEntry = existingFields.find(f => String(f.fieldId || f.id) === String(FIELD_IDS.initialMessageHistory));
    const existingValue = existingEntry?.value || '';

    const today = new Date();
    const todayStr = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
    const newEntry = `${todayStr}: ${message}`;
    const combined = existingValue ? `${existingValue}\n\n${newEntry}` : newEntry;

    return neonPatch(`/accounts/${accountId}`, {
      [wrapper]: { accountCustomFields: [{ id: FIELD_IDS.initialMessageHistory, value: combined }] }
    });
  } catch (err) {
    console.error('Initial Message history append failed (non-fatal):', err);
    return { status: 0, data: { error: 'append failed, see logs' } };
  }
}

function buildInitialSummary(payload) {
  const parts = [];
  const isForSomeoneElse = payload.reachingOutFor === 'someone-else' && payload.personName;
  const subject = isForSomeoneElse ? payload.personName : "you";
  const possessive = isForSomeoneElse ? `${payload.personName}'s` : 'your';

  if (payload.primaryNeed) {
    let s = isForSomeoneElse
      ? `You reached out on behalf of ${subject} about ${payload.primaryNeed.toLowerCase()}`
      : `You reached out about ${payload.primaryNeed.toLowerCase()}`;
    if (payload.county) s += ` in ${payload.county}`;
    s += '.';
    parts.push(s);
  } else if (payload.county) {
    parts.push(isForSomeoneElse
      ? `You reached out on behalf of ${subject}, who's in ${payload.county}.`
      : `You reached out to us from ${payload.county}.`);
  }
  if (payload.message) {
    parts.push(`In your own words: "${payload.message}"`);
  }
  return parts.join(' ').trim();
}

async function updateCustomFields(accountId, formType, payload, prefetchedAccount) {
  const countyId = COUNTY_IDS[payload.county] || null;
  const programId = PROGRAM_INTEREST[formType] || PROGRAM_INTEREST.default;
  const followUpTypeId = FOLLOWUP_TYPE[formType] || FOLLOWUP_TYPE.default;
  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowStr = `${String(tomorrow.getMonth()+1).padStart(2,'0')}/${String(tomorrow.getDate()).padStart(2,'0')}/${tomorrow.getFullYear()}`;

  const customFields = [
    // QCLS Follow-Up Needed = Yes (dropdown — needs optionValues)
    { id: FIELD_IDS.followUpNeeded, optionValues: [{ id: FIELD_IDS.followUpNeededYes }] },
    // QCLS Follow-Up Type (dropdown — needs optionValues)
    { id: FIELD_IDS.followUpType, optionValues: [{ id: followUpTypeId }] },
    // QCLS Follow-Up Source (text field — uses value)
    { id: FIELD_IDS.followUpSource, value: payload.source || 'quest4care.org' },
    // QCLS Follow-Up Due Date (text field — uses value)
    { id: '155', value: tomorrowStr },
    // Program Interest (dropdown — needs optionValues)
    { id: FIELD_IDS.programInterest, optionValues: [{ id: programId }] },
  ];

  // County (dropdown — needs optionValues)
  if (countyId) {
    customFields.push({ id: FIELD_IDS.county, optionValues: [{ id: countyId }] });
  }

  // Record this submission's timestamp for next time's rapid-resubmit check
  if (FIELD_IDS.lastSubmittedAt) {
    customFields.push({ id: FIELD_IDS.lastSubmittedAt, value: new Date().toISOString() });
  }

  // Their own written message, if the form they used had that field and they filled it in
  if (FIELD_IDS.initialMessage && payload.message) {
    customFields.push({ id: FIELD_IDS.initialMessage, value: payload.message });
  }

  // Computed natural-language summary for the confirmation email
  if (FIELD_IDS.initialSummary) {
    const summary = buildInitialSummary(payload);
    if (summary) customFields.push({ id: FIELD_IDS.initialSummary, value: summary });
  }

  // Who this is actually for — was being silently discarded before this fix
  if (FIELD_IDS.reachingOutFor && payload.reachingOutFor) {
    customFields.push({ id: FIELD_IDS.reachingOutFor, value: payload.reachingOutFor });
  }
  if (FIELD_IDS.personName && payload.personName) {
    customFields.push({ id: FIELD_IDS.personName, value: payload.personName });
  }

  // SMS consent — single opt-in checkbox (option id=62). Only written when
  // actually checked; omitted entirely when not, since there's no "declined"
  // option to select — absence of the field IS the "no consent" state.
  if (FIELD_IDS.smsConsent && payload.smsConsent === true) {
    customFields.push({ id: FIELD_IDS.smsConsent, optionValues: [{ id: '62' }] });
  }

  // Reuse the already-fetched account instead of asking Neon again
  const acct = prefetchedAccount || await neonGet(`/accounts/${accountId}`);
  const isCompany = !!acct.data?.companyAccount;

  const wrapper = isCompany ? 'companyAccount' : 'individualAccount';

  return neonPatch(`/accounts/${accountId}`, {
    [wrapper]: { accountCustomFields: customFields }
  });
}

// ── Create membership with sendAcknowledgeEmail:true — fires INSTANT native email ──
// This is the confirmed-working alternative to waiting for the daily workflow scan.
// Membership level maps to inquiry type; each level's acknowledgment email template
// in Neon should be customized per inquiry type (next session task).
async function createAcknowledgmentMembership(accountId, formType, isRapidResubmit) {
  const mapping = MEMBERSHIP_MAP[formType] || MEMBERSHIP_MAP.default;

  // Only skip if this looks like an accidental rapid double-submit (within the
  // same short window as the Provisional group check). A genuinely new inquiry
  // weeks or months later — even in the same category — gets its own membership
  // record and its own email. Multiple records over time for the same person is
  // real, valuable history (recurring need), not noise to suppress.
  if (isRapidResubmit) {
    console.log(`Account ${accountId} resubmitted within the rapid-resubmit window — skipping duplicate membership/email this time.`);
    return { status: 0, data: { skipped: 'rapid resubmit' } };
  }

  const startDate = new Date();
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 1);

  return neonPost('/memberships', {
    accountId: String(accountId),
    membershipLevel: { id: mapping.levelId },
    membershipTerm: { id: mapping.termId },
    termUnit: 'YEAR',
    termDuration: 1,
    enrollType: 'JOIN',
    transactionDate: startDate.toISOString(),
    termStartDate: startDate.toISOString(),
    termEndDate: endDate.toISOString(),
    fee: 0,
    totalCharge: 0,
    sendAcknowledgeEmail: true,
    status: 'SUCCEEDED'
  });
}

// ── Add account to Provisional group ──
async function addToProvisionalGroup(accountId) {
  return neonPost(`/accounts/${accountId}/groups/${PROVISIONAL_GROUP_ID}`, {});
}

// ── Create activity (follow-up task) ──
async function createActivity(accountId, formType, payload) {
  const details = [
    payload.organization ? `Organization: ${payload.organization}` : null,
    payload.ein ? `EIN: ${payload.ein}` : null,
    payload.title ? `Title: ${payload.title}` : null,
    payload.county ? `County: ${payload.county}` : null,
    payload.contactPref ? `Preferred contact: ${payload.contactPref}` : null,
    payload.primaryNeed ? `Primary Need: ${payload.primaryNeed}` : null,
    payload.interest ? `Interest: ${payload.interest}` : null,
    payload.serviceCategory ? `Service Categories: ${payload.serviceCategory}` : null,
    payload.skills ? `Skills: ${payload.skills}` : null,
    payload.availability ? `Availability: ${payload.availability}` : null,
    payload.message ? `Message: ${payload.message}` : null,
    `Source: ${payload.source || 'quest4care.org'}`,
    `Submitted: ${payload.submitted_at || new Date().toISOString()}`,
  ].filter(Boolean).join('\n');

  const subjectMap = {
    individual:   'OurWalk™ Navigation Request',
    organization: 'FoundationReady™ Inquiry',
    provider:     'qPartner™ Provider Application',
    volunteer:    'weCARES™ Volunteer Application',
  };

  const today = new Date();
  const todayStr = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;

  return neonPost('/activities', {
    subject: subjectMap[formType] || 'Website Inquiry',
    status: { id: '2' },
    priority: 'High',
    activityDates: [{ startDate: todayStr }],
    details,
    account: { id: String(accountId) }
  });
}

// ── Main handler ──
const NEWSLETTER_GROUP_ID = null; // e.g. '32' — create a "Newsletter Subscribers" Group in Neon and paste its ID here

// ── Newsletter signup — deliberately lightweight. Just finds/creates an account
// and adds it to a Group, skipping everything meant for "I need help" inquiries
// (Follow-Up fields, Activity creation, the OurWalk-style acknowledgment
// membership/email). Someone signing up for quarterly updates shouldn't get
// treated like a navigation case.
async function handleNewsletterSignup(payload, res) {
  const email = payload.email?.trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });

  let accountId = await findAccountByEmail(email);
  if (!accountId) {
    const parts = (payload.name || '').trim().split(/\s+/);
    const r = await neonPost('/accounts', {
      individualAccount: {
        primaryContact: { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '', email1: email }
      }
    });
    accountId = r.data?.id || null;
  }
  if (!accountId) {
    return res.status(200).json({ success: true, warning: 'Newsletter signup account creation failed' });
  }

  if (NEWSLETTER_GROUP_ID) {
    await neonPost(`/accounts/${accountId}/groups/${NEWSLETTER_GROUP_ID}`, {});
  }
  return res.status(200).json({ success: true, accountId });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://quest4care.org');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    const { formType, email, organization } = payload;

    if (!email) return res.status(400).json({ error: 'Email is required' });

    if (formType === 'newsletter') {
      return await handleNewsletterSignup(payload, res);
    }

    // 1. Check for existing account
    let accountId = await findAccountByEmail(email);
    let creationDebug = null;

    // 2. Create account if not found
    if (!accountId) {
      const isOrg = formType === 'organization' || formType === 'provider' || organization?.trim();
      const creationResult = isOrg && organization
        ? await createCompany(payload)
        : await createIndividual(payload);
      accountId = creationResult.id;
      creationDebug = { status: creationResult.status, raw: creationResult.raw };
    }

    if (!accountId) {
      console.error('Failed to create/find account for:', email, JSON.stringify(creationDebug));
      // Still tells the browser "success" so a real constituent never sees a scary
      // error mid-submission — but now includes the actual Neon error in the body
      // itself, visible directly in the browser's Network tab (F12 → Network →
      // this request → Response), instead of requiring a trip through Vercel's logs.
      return res.status(200).json({
        success: true,
        warning: 'Account creation failed',
        debug: creationDebug
      });
    }

    console.log(`Account ID: ${accountId} for ${email}`);

    // Fetch the account ONCE here and reuse it below — updateCustomFields and
    // appendProgramInterestHistory each used to do their own independent GET for
    // the exact same data. One fetch, shared.
    const prefetchedAccount = await neonGet(`/accounts/${accountId}`);

    // Read the previous submission timestamp BEFORE this one overwrites it —
    // this is what decides whether this looks like a rapid duplicate resubmit
    // (skip re-tagging Provisional) or a genuinely new inquiry (re-tag normally).
    // This has to happen before the parallel batch below, since one of those
    // operations (Provisional group) depends on its result.
    const lastSubmittedAt = await getLastSubmittedAt(accountId, prefetchedAccount);
    const isRapidResubmit = lastSubmittedAt && (Date.now() - lastSubmittedAt.getTime()) < RAPID_RESUBMIT_WINDOW_MS;

    // Everything below this point writes to different places and none of them
    // depend on each other's results — they were previously run one at a time
    // (each waiting for the last to finish before starting), which is why a
    // single submission was taking as long as all five combined. Running them
    // together cuts total wait time down to roughly the slowest single one,
    // not the sum of all five.
    const [fieldResult, historyResult, messageHistoryResult, groupResult, membershipResult, activityResult] = await Promise.all([
      updateCustomFields(accountId, formType, payload, prefetchedAccount),
      appendProgramInterestHistory(accountId, formType, prefetchedAccount),
      appendInitialMessageHistory(accountId, payload.message, prefetchedAccount),
      isRapidResubmit
        ? Promise.resolve({ status: 0, data: { skipped: 'rapid resubmit' } })
        : addToProvisionalGroup(accountId),
      createAcknowledgmentMembership(accountId, formType, isRapidResubmit),
      createActivity(accountId, formType, payload),
    ]);

    if (isRapidResubmit) {
      console.log(`Account ${accountId} resubmitted within ${RAPID_RESUBMIT_WINDOW_MS / 60000} minutes of their last submission — treating as the same burst, skipping Provisional re-tag.`);
    }
    console.log('Custom fields status:', fieldResult.status, JSON.stringify(fieldResult.data).substring(0,200));
    console.log('Program Interest history status:', historyResult.status, JSON.stringify(historyResult.data).substring(0,200));
    console.log('Initial Message history status:', messageHistoryResult.status, JSON.stringify(messageHistoryResult.data).substring(0,200));
    console.log('Provisional group status:', groupResult.status, JSON.stringify(groupResult.data).substring(0,200));
    console.log('Membership (instant email) status:', membershipResult.status, JSON.stringify(membershipResult.data).substring(0,200));
    console.log('Activity status:', activityResult.status, JSON.stringify(activityResult.data).substring(0,200));

    return res.status(200).json({ success: true, accountId });

  } catch(err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org or call 574-CARE-NOW.' });
  }
}
