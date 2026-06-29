// QCLS Form Submission Handler
// Vercel Serverless Function → Neon One API
// api/submit.js

const NEON_ORG = 'quest4care';
const NEON_BASE = `https://api.neoncrm.com/v2`;

function authHeader() {
  const key = process.env.NEON_API_KEY;
  return 'Basic ' + Buffer.from(`${NEON_ORG}:${key}`).toString('base64');
}

async function findAccountByEmail(email) {
  const res = await fetch(`${NEON_BASE}/accounts/search`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      searchFields: [{ field: 'Email', operator: 'EQUAL', value: email }],
      outputFields: ['Account ID', 'First Name', 'Last Name', 'Company Name'],
      pagination: { currentPage: 0, pageSize: 1 }
    })
  });
  const data = await res.json();
  return data.searchResults?.[0] || null;
}

async function createIndividualAccount(payload) {
  const nameParts = (payload.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const body = {
    individualAccount: {
      primaryContact: {
        firstName,
        lastName,
        email1: payload.email,
        phone1: payload.phone || ''
      }
    }
  };

  const res = await fetch(`${NEON_BASE}/accounts`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data.id;
}

async function createCompanyAccount(payload) {
  const body = {
    companyAccount: {
      name: payload.organization,
      primaryContact: {
        firstName: (payload.name || '').split(' ')[0] || '',
        lastName: (payload.name || '').split(' ').slice(1).join(' ') || '',
        email1: payload.email,
        phone1: payload.phone || ''
      }
    }
  };

  const res = await fetch(`${NEON_BASE}/accounts`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data.id;
}

async function updateAccountCustomFields(accountId, fields) {
  await fetch(`${NEON_BASE}/accounts/${accountId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ customFields: fields })
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://quest4care.org');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    const { formType, email, organization } = payload;

    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Check for existing account
    const existing = await findAccountByEmail(email);
    let accountId = existing?.['Account ID'] || null;

    // Determine account type
    const isOrg = formType === 'organization' || formType === 'provider' || (organization && organization.trim().length > 0);

    if (!accountId) {
      if (isOrg && organization) {
        accountId = await createCompanyAccount(payload);
      } else {
        accountId = await createIndividualAccount(payload);
      }
    }

    // Set follow-up flag via custom fields (fallback for activities bug ticket 676995)
    if (accountId) {
      await updateAccountCustomFields(accountId, [
        { id: '153', value: 'Yes' },      // QCLS Follow-Up Needed
        { id: '154', value: formType },    // Follow-Up Type
        { id: '155', value: new Date().toISOString().split('T')[0] }, // Due Date
        { id: '156', value: 'quest4care.org' } // Source
      ]);
    }

    return res.status(200).json({ success: true, accountId });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org.' });
  }
}
