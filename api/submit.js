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
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const customFields = [
    // QCLS Follow-Up Needed = Yes (dropdown — needs optionValues)
    { id: FIELD_IDS.followUpNeeded, optionValues: [{ id: FIELD_IDS.followUpNeededYes }] },
    // QCLS Follow-Up Type (dropdown — needs optionValues)
    { id: FIELD_IDS.followUpType, optionValues: [{ id: followUpTypeId }] },
    // QCLS Follow-Up Source (text field — uses value)
    { id: FIELD_IDS.followUpSource, value: payload.source || 'quest4care.org' },
    // QCLS Follow-Up Due Date (text field — uses value)
    { id: '155', value: tomorrow },
    // Program Interest (dropdown — needs optionValues)
    { id: FIELD_IDS.programInterest, optionValues: [{ id: programId }] },
  ];

  // County (dropdown — needs optionValues)
  if (countyId) {
    customFields.push({ id: FIELD_IDS.county, optionValues: [{ id: countyId }] });
  }

  // Fetch account to determine type
  const acct = await neonGet(`/accounts/${accountId}`);
  const isCompany = !!acct.data?.companyAccount;
  
  const patchBody = isCompany
    ? { companyAccount: { customFields } }
    : { individualAccount: { customFields } };

  return neonPatch(`/accounts/${accountId}`, patchBody);
}

// ── Add account to Provisional group ──
async function addToProvisionalGroup(accountId) {
  return neonPost(`/accounts/${accountId}/groups`, {
    id: PROVISIONAL_GROUP_ID
  });
}

// ── Create activity (follow-up task) ──
async function createActivity(accountId, formType, payload) {
  const details = [
    payload.organization ? `Organization: ${payload.organization}` : null,
    payload.ein ? `EIN: ${payload.ein}` : null,
    payload.title ? `Title: ${payload.title}` : null,
    payload.county ? `County: ${payload.county}` : null,
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

  const today = new Date().toISOString().split('T')[0];

  return neonPost('/activities', {
    subject: subjectMap[formType] || 'Website Inquiry',
    status: { id: '2' },     // Not Started
    priority: 'High',
    activityDates: [{ startDate: today }],
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

    // 3. Update custom fields (triggers conditional workflow)
    const fieldResult = await updateCustomFields(accountId, formType, payload);
    console.log('Custom fields status:', fieldResult.status, JSON.stringify(fieldResult.data).substring(0,200));

    // 4. Add to Provisional group
    const groupResult = await addToProvisionalGroup(accountId);
    console.log('Provisional group status:', groupResult.status, JSON.stringify(groupResult.data).substring(0,200));

    // 5. Create activity
    const activityResult = await createActivity(accountId, formType, payload);
    console.log('Activity status:', activityResult.status, JSON.stringify(activityResult.data).substring(0,200));

    return res.status(200).json({ success: true, accountId });

  } catch(err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org or call 574-CARE-NOW.' });
  }
}
