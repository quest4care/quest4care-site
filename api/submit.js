// QCLS Form Submission Handler
// Vercel Serverless Function → Neon One API v2
// Creates account, adds to Provisional group, writes activity, updates custom fields

const NEON_ORG = 'quest4care';
const NEON_BASE = 'https://api.neoncrm.com/v2';

// Activity Status IDs (from /v2/properties/activityStatuses)
const ACTIVITY_STATUS = {
  NOT_STARTED: 2,
  IN_PROGRESS: 3,
  COMPLETED: 4,
  WAITING: 5,
  DEFERRED: 6,
  OTHER: 7
};

// Custom field IDs
const FIELDS = {
  PROGRAM_INTEREST: '87',   // Account custom field
  COUNTY: '91',             // Account custom field
  INTEREST_AREA: '83',      // Account custom field
  FOLLOW_UP_NEEDED: '153',  // QCLS Follow-Up Needed
  FOLLOW_UP_TYPE: '154',    // QCLS Follow-Up Type
  FOLLOW_UP_DUE: '155',     // QCLS Follow-Up Due Date
  FOLLOW_UP_SOURCE: '156',  // QCLS Follow-Up Source
};

// Program Interest option IDs
const PROGRAM_IDS = {
  individual:   '31', // Community Access Navigation
  organization: '32', // FoundationReady Assessment
  provider:     '33', // Provider Network
  volunteer:    '34', // Volunteer
  default:      '35', // General Inquiry
};

// County option IDs
const COUNTY_IDS = {
  'Henry County': '59',
  'Madison County': '60',
  'Other': '61',
  'Other Indiana County': '61',
};

function authHeader() {
  const key = process.env.NEON_API_KEY;
  return 'Basic ' + Buffer.from(`${NEON_ORG}:${key}`).toString('base64');
}

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  const lastName = parts.pop();
  return { firstName: parts.join(' '), lastName };
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function dueDateISO(daysFromNow = 1) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

async function neonPost(path, body) {
  const res = await fetch(`${NEON_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({}));
}

async function neonPatch(path, body) {
  const res = await fetch(`${NEON_BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json().catch(() => ({}));
}

async function findAccountByEmail(email) {
  const data = await neonPost('/accounts/search', {
    searchFields: [{ field: 'Email', operator: 'EQUAL', value: email }],
    outputFields: ['Account ID', 'First Name', 'Last Name'],
    pagination: { currentPage: 0, pageSize: 1 }
  });
  return data.searchResults?.[0] || null;
}

async function createIndividualAccount(payload) {
  const { firstName, lastName } = splitName(payload.name);
  const data = await neonPost('/accounts', {
    individualAccount: {
      primaryContact: {
        firstName,
        lastName,
        email1: payload.email,
        phone1: payload.phone || ''
      }
    }
  });
  return data.id || null;
}

async function createCompanyAccount(payload) {
  const { firstName, lastName } = splitName(payload.name);
  const data = await neonPost('/accounts', {
    companyAccount: {
      name: payload.organization,
      primaryContact: { firstName, lastName, email1: payload.email, phone1: payload.phone || '' }
    }
  });
  return data.id || null;
}

async function updateCustomFields(accountId, formType, payload) {
  const customFields = [
    { id: FIELDS.FOLLOW_UP_NEEDED, value: 'Yes' },
    { id: FIELDS.FOLLOW_UP_TYPE, value: formType },
    { id: FIELDS.FOLLOW_UP_DUE, value: dueDateISO(1) },
    { id: FIELDS.FOLLOW_UP_SOURCE, value: payload.source || 'quest4care.org' },
  ];

  if (payload.county && COUNTY_IDS[payload.county]) {
    customFields.push({ id: FIELDS.COUNTY, value: COUNTY_IDS[payload.county] });
  }

  customFields.push({ id: FIELDS.PROGRAM_INTEREST, value: PROGRAM_IDS[formType] || PROGRAM_IDS.default });

  return neonPatch(`/accounts/${accountId}`, { customFields });
}

async function addNote(accountId, payload, formType) {
  const parts = [
    `Form: ${formType} · Source: quest4care.org · ${new Date().toISOString()}`,
  ];
  if (payload.county) parts.push(`County: ${payload.county}`);
  if (payload.message) parts.push(`Message: ${payload.message}`);
  if (payload.serviceCategory) parts.push(`Service Categories: ${payload.serviceCategory}`);
  if (payload.providerTypes) parts.push(`Provider Type: ${payload.providerTypes}`);
  if (payload.skills) parts.push(`Skills: ${payload.skills}`);
  if (payload.volunteerTypes) parts.push(`Volunteer Type: ${payload.volunteerTypes}`);
  if (payload.availability) parts.push(`Availability: ${payload.availability}`);
  if (payload.ein) parts.push(`EIN: ${payload.ein}`);
  if (payload.interest) parts.push(`Interest: ${payload.interest}`);

  return neonPost(`/accounts/${accountId}/notes`, { note: parts.join('\n') });
}

async function createActivity(accountId, payload, formType) {
  const subjectMap = {
    individual: 'OurWalk™ Navigation Request',
    organization: 'FoundationReady™ Inquiry',
    provider: 'qPartner™ Provider Application',
    volunteer: 'weCARES™ Volunteer Application',
  };

  const { firstName } = splitName(payload.name);

  const nowISO = new Date().toISOString();
  const tomorrowISO = new Date(Date.now() + 86400000).toISOString();

  const activityBody = {
    subject: subjectMap[formType] || 'QCLS Inquiry',
    note: `New inquiry received via quest4care.org. Follow up within one business day.\n\nName: ${payload.name || ''}\nEmail: ${payload.email || ''}\nPhone: ${payload.phone || ''}\nCounty: ${payload.county || ''}\nMessage: ${payload.message || ''}`,
    priority: 'High',
    status: { id: ACTIVITY_STATUS.NOT_STARTED },
    activityDates: [{
      startDate: nowISO,
      endDate: tomorrowISO,
    }],
    clientAccount: [{
      accountId: String(accountId),
    }],
  };

  return neonPost('/activities', activityBody);
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

    // Duplicate detection
    const existing = await findAccountByEmail(email);
    let accountId = existing?.['Account ID'] || null;

    // Create account if not found
    const isOrg = ['organization', 'provider'].includes(formType) || (organization && organization.trim().length > 0);

    if (!accountId) {
      if (isOrg && organization) {
        accountId = await createCompanyAccount(payload);
      } else {
        accountId = await createIndividualAccount(payload);
      }
    }

    if (accountId) {
      // Run in parallel — custom fields, note, activity
      const [fieldsResult, noteResult, activityResult] = await Promise.all([
        updateCustomFields(accountId, formType, payload),
        addNote(accountId, payload, formType),
        createActivity(accountId, payload, formType),
      ]);

      console.log('Custom fields:', JSON.stringify(fieldsResult));
      console.log('Note:', JSON.stringify(noteResult));
      console.log('Activity:', JSON.stringify(activityResult));
    }

    return res.status(200).json({ success: true, accountId });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org.' });
  }
}
