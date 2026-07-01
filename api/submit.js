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
};

// How close together two submissions have to be to count as "the same burst" rather
// than a genuinely new inquiry. Tune freely — 15 minutes is a reasonable starting
// point for "probably an accidental double-submit or quick correction," while
// anything beyond this (hours, days, months later) is treated as a real new case.
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
  individual:   { levelId: '4', termId: '7' }, // Navigation Participant
  organization: { levelId: '2', termId: '3' }, // FoundationReady Client
  provider:     { levelId: '3', termId: '5' }, // Provider Network Member
  volunteer:    { levelId: '1', termId: '1' }, // QCLS Community (pending dedicated Volunteer level)
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
async function appendProgramInterestHistory(accountId, formType) {
  if (!FIELD_IDS.programInterestHistory) return { status: 0, data: { skipped: 'field not configured yet' } };

  try {
    const acct = await neonGet(`/accounts/${accountId}`);
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
// prevents duplicate memberships (and duplicate "welcome" emails) when someone with
// an existing account submits another inquiry in the SAME category. A genuinely
// different category (e.g. they were Navigation Participant, now also Volunteer)
// still creates its own membership — that's real, useful history, not a duplicate.
// If this check itself fails for any reason, defaults to "no existing membership
// found" so a real first-time submission is never silently blocked by an API hiccup.
async function hasExistingMembershipAtLevel(accountId, levelId) {
  try {
    const res = await neonGet(`/accounts/${accountId}/memberships`);
    const list = res.data?.memberships || res.data?.membershipList || [];
    return list.some(m => String(m.membershipLevel?.id) === String(levelId));
  } catch (err) {
    console.error('Membership check failed (defaulting to "no existing membership"):', err);
    return false;
  }
}

// ── Read the last-submitted timestamp BEFORE this submission overwrites it —
// used to decide whether this looks like a rapid duplicate resubmit or a genuinely
// new inquiry. Defaults to "treat as new" (null) if the field isn't configured yet
// or the read fails, so a real submission is never silently short-circuited.
async function getLastSubmittedAt(accountId) {
  if (!FIELD_IDS.lastSubmittedAt) return null;
  try {
    const acct = await neonGet(`/accounts/${accountId}`);
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
  return r.data?.id || null;
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
  return r.data?.id || null;
}

// ── Update custom fields using correct optionValues structure ──
async function updateCustomFields(accountId, formType, payload) {
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

  // Fetch account to determine type
  const acct = await neonGet(`/accounts/${accountId}`);
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
async function createAcknowledgmentMembership(accountId, formType) {
  const mapping = MEMBERSHIP_MAP[formType] || MEMBERSHIP_MAP.default;

  const alreadyHasThisLevel = await hasExistingMembershipAtLevel(accountId, mapping.levelId);
  if (alreadyHasThisLevel) {
    console.log(`Account ${accountId} already has a membership at level ${mapping.levelId} — skipping duplicate, no acknowledgment email fired this time.`);
    return { status: 0, data: { skipped: 'duplicate membership at this level' } };
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

    // 1. Check for existing account
    let accountId = await findAccountByEmail(email);

    // 2. Create account if not found
    if (!accountId) {
      const isOrg = formType === 'organization' || formType === 'provider' || organization?.trim();
      if (isOrg && organization) {
        accountId = await createCompany(payload);
      } else {
        accountId = await createIndividual(payload);
      }
    }

    if (!accountId) {
      console.error('Failed to create/find account for:', email);
      return res.status(200).json({ success: true, warning: 'Account creation failed silently' });
    }

    console.log(`Account ID: ${accountId} for ${email}`);

    // Read the previous submission timestamp BEFORE this one overwrites it —
    // this is what decides whether this looks like a rapid duplicate resubmit
    // (skip re-tagging Provisional) or a genuinely new inquiry (re-tag normally).
    const lastSubmittedAt = await getLastSubmittedAt(accountId);
    const isRapidResubmit = lastSubmittedAt && (Date.now() - lastSubmittedAt.getTime()) < RAPID_RESUBMIT_WINDOW_MS;

    // 3. Update custom fields (triggers conditional workflow)
    const fieldResult = await updateCustomFields(accountId, formType, payload);
    console.log('Custom fields status:', fieldResult.status, JSON.stringify(fieldResult.data).substring(0,200));

    // 3b. Append to the permanent, never-overwritten Program Interest history —
    // works the same way for every request type (OurWalk, FoundationReady, qPartner, weCARES)
    const historyResult = await appendProgramInterestHistory(accountId, formType);
    console.log('Program Interest history status:', historyResult.status, JSON.stringify(historyResult.data).substring(0,200));

    // 4. Add to Provisional group — skipped if this looks like a rapid duplicate
    //    resubmit (within RAPID_RESUBMIT_WINDOW_MS of their last one). A genuinely
    //    new inquiry, even from a returning account, re-tags normally.
    let groupResult;
    if (isRapidResubmit) {
      console.log(`Account ${accountId} resubmitted within ${RAPID_RESUBMIT_WINDOW_MS / 60000} minutes of their last submission — treating as the same burst, skipping Provisional re-tag.`);
      groupResult = { status: 0, data: { skipped: 'rapid resubmit' } };
    } else {
      groupResult = await addToProvisionalGroup(accountId);
    }
    console.log('Provisional group status:', groupResult.status, JSON.stringify(groupResult.data).substring(0,200));

    // 5. Create acknowledgment membership — fires INSTANT native Neon email
    //    (skips cleanly if this account already has a membership at this exact level —
    //    see hasExistingMembershipAtLevel — so repeat inquiries in the same category
    //    never create duplicates, while a genuinely new category still does)
    const membershipResult = await createAcknowledgmentMembership(accountId, formType);
    console.log('Membership (instant email) status:', membershipResult.status, JSON.stringify(membershipResult.data).substring(0,200));

    // 6. Create activity
    const activityResult = await createActivity(accountId, formType, payload);
    console.log('Activity status:', activityResult.status, JSON.stringify(activityResult.data).substring(0,200));

    return res.status(200).json({ success: true, accountId });

  } catch(err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org or call 574-CARE-NOW.' });
  }
}
