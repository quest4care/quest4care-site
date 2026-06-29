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
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchFields: [{ field: 'Email', operator: 'EQUAL', value: email }],
      outputFields: ['Account ID', 'First Name', 'Last Name', 'Company Name'],
      pagination: { currentPage: 0, pageSize: 1 }
    })
  });
  const data = await res.json();
  return data.searchResults?.[0] || null;
}

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  const lastName = parts.pop();
  return { firstName: parts.join(' '), lastName };
}

async function createIndividualAccount(payload) {
  const { firstName, lastName } = splitName(payload.name);
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
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data.id;
}

async function createCompanyAccount(payload) {
  const { firstName, lastName } = splitName(payload.name);
  const body = {
    companyAccount: {
      name: payload.organization,
      primaryContact: { firstName, lastName, email1: payload.email, phone1: payload.phone || '' }
    }
  };
  const res = await fetch(`${NEON_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data.id;
}

async function updateAccountCustomFields(accountId, fields) {
  await fetch(`${NEON_BASE}/accounts/${accountId}`, {
    method: 'PATCH',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: fields })
  });
}

async function addAccountNote(accountId, note) {
  await fetch(`${NEON_BASE}/accounts/${accountId}/notes`, {
    method: 'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ note })
  });
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
    const isOrg = formType === 'organization' || formType === 'provider' || (organization && organization.trim().length > 0);

    if (!accountId) {
      if (isOrg && organization) {
        accountId = await createCompanyAccount(payload);
      } else {
        accountId = await createIndividualAccount(payload);
      }
    }

    if (accountId) {
      // Build custom fields array
      const customFields = [
        { id: '153', value: 'Yes' },
        { id: '154', value: formType },
        { id: '155', value: new Date().toISOString().split('T')[0] },
        { id: '156', value: payload.source || 'quest4care.org' }
      ];

      // Map county to field ID 6 (County field in Intake & Program group)
      if (payload.county) {
        customFields.push({ id: '6', value: payload.county });
      }

      // Map program interest / form type to field ID 1
      if (payload.interest || payload.primaryNeed) {
        customFields.push({ id: '1', value: payload.interest || payload.primaryNeed });
      }

      await updateAccountCustomFields(accountId, customFields);

      // Write message/notes to account note
      const noteParts = [];
      if (payload.message) noteParts.push(`Message: ${payload.message}`);
      if (payload.county) noteParts.push(`County: ${payload.county}`);
      if (payload.availability) noteParts.push(`Availability: ${payload.availability}`);
      if (payload.serviceCategory) noteParts.push(`Service Category: ${payload.serviceCategory}`);
      if (payload.acceptingReferrals) noteParts.push(`Accepting Referrals: ${payload.acceptingReferrals}`);
      if (payload.ein) noteParts.push(`EIN: ${payload.ein}`);
      if (payload.donationAmount) noteParts.push(`Intended Donation: $${payload.donationAmount} ${payload.donationFrequency || ''}`);
      noteParts.push(`Form: ${formType} · Source: ${payload.source || 'quest4care.org'} · ${new Date().toISOString()}`);

      if (noteParts.length) {
        await addAccountNote(accountId, noteParts.join('\n'));
      }
    }

    return res.status(200).json({ success: true, accountId });

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org.' });
  }
}
