#!/usr/bin/env bun
// Import fan emails into Supabase fan_contacts table
// Usage: SUPABASE_SERVICE_ROLE_KEY=xxx bun scripts/import_fans.js

import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const SUPABASE_URL = 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_SERVICE_ROLE_KEY env var');
  process.exit(1);
}

const CSV_DIR = '/Users/travis/Documents/Fanded M1/Fanded MAWD/Trav_s MAWD/CSV_s';

// ── Step 1: Create fan_contacts table if not exists ──
async function createTable() {
  console.log('Creating fan_contacts table...');
  const sql = `
    CREATE TABLE IF NOT EXISTS fan_contacts (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      source TEXT,
      fan_score NUMERIC,
      platforms TEXT,
      mailchimp_status TEXT,
      patreon_tier TEXT,
      fanded_tier TEXT,
      location TEXT,
      do_not_email BOOLEAN DEFAULT false,
      do_not_sms BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `;

  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/exec_sql', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  // If RPC doesn't exist, try the SQL endpoint
  if (!res.ok) {
    console.log('RPC not available, using SQL editor endpoint...');
    const sqlRes = await fetch(SUPABASE_URL + '/pg', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: sql })
    });
    if (!sqlRes.ok) {
      console.log('Note: Table creation via API failed. Will try direct insert (table may already exist).');
    }
  }
}

// ── Step 2: Load and deduplicate fans ──
function loadFans() {
  const fans = new Map(); // email -> fan data
  const unsubscribed = new Set();
  const cleaned = new Set();

  // Load Mailchimp unsubscribed + cleaned (do_not_email)
  try {
    const unsub = readFileSync(CSV_DIR + '/MAILCHIMP audience_export_92ff67cb02/unsubscribed_email_audience_export_92ff67cb02.csv', 'utf8');
    const unsubRows = parse(unsub, { columns: true, skip_empty_lines: true });
    for (const row of unsubRows) {
      const email = (row['Email Address'] || '').toLowerCase().trim();
      if (email) unsubscribed.add(email);
    }
    console.log('Mailchimp unsubscribed:', unsubscribed.size);
  } catch (e) { console.log('No unsubscribed file'); }

  try {
    const clean = readFileSync(CSV_DIR + '/MAILCHIMP audience_export_92ff67cb02/cleaned_email_audience_export_92ff67cb02.csv', 'utf8');
    const cleanRows = parse(clean, { columns: true, skip_empty_lines: true });
    for (const row of cleanRows) {
      const email = (row['Email Address'] || '').toLowerCase().trim();
      if (email) cleaned.add(email);
    }
    console.log('Mailchimp cleaned:', cleaned.size);
  } catch (e) { console.log('No cleaned file'); }

  // Load primary source: fan_scores_ranked.csv
  try {
    const data = readFileSync(CSV_DIR + '/fan_scores_ranked.csv', 'utf8');
    const rows = parse(data, { columns: true, skip_empty_lines: true });
    for (const row of rows) {
      const email = (row.Email || '').toLowerCase().trim();
      if (!email || !email.includes('@')) continue;

      fans.set(email, {
        email,
        name: row.Name || '',
        phone: null,
        source: 'fan_scores',
        fan_score: parseFloat(row['Total Score']) || null,
        platforms: row.Platforms || '',
        mailchimp_status: row['Mailchimp Status'] || '',
        patreon_tier: row['Patreon Tier'] || '',
        fanded_tier: row['Fanded Tier'] || '',
        location: row.Location || '',
        do_not_email: unsubscribed.has(email) || cleaned.has(email),
        do_not_sms: false
      });
    }
    console.log('Fan scores loaded:', fans.size, 'emails');
  } catch (e) { console.error('Error loading fan_scores:', e.message); }

  // Supplement: Mailchimp subscribed (for any emails not in fan_scores)
  try {
    const data = readFileSync(CSV_DIR + '/MAILCHIMP audience_export_92ff67cb02/subscribed_email_audience_export_92ff67cb02.csv', 'utf8');
    const rows = parse(data, { columns: true, skip_empty_lines: true });
    let added = 0;
    for (const row of rows) {
      const email = (row['Email Address'] || '').toLowerCase().trim();
      if (!email || !email.includes('@')) continue;
      if (fans.has(email)) continue; // already have it

      const name = [row['First Name'], row['Last Name']].filter(Boolean).join(' ');
      fans.set(email, {
        email,
        name,
        phone: null,
        source: 'mailchimp',
        fan_score: null,
        platforms: 'mailchimp',
        mailchimp_status: 'subscribed',
        patreon_tier: '',
        fanded_tier: '',
        location: [row.REGION, row.CC].filter(Boolean).join(', '),
        do_not_email: false,
        do_not_sms: false
      });
      added++;
    }
    console.log('Mailchimp additions:', added);
  } catch (e) { console.error('Error loading Mailchimp:', e.message); }

  // Supplement: Fanded Club (for phone numbers)
  try {
    let data = readFileSync(CSV_DIR + '/Fanded Club/export.csv', 'utf8');
    // Strip BOM if present
    if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1);
    const rows = parse(data, { columns: true, skip_empty_lines: true, bom: true });
    let phonesAdded = 0;
    let newAdded = 0;
    for (const row of rows) {
      const email = (row.Email || '').toLowerCase().trim();
      const phone = (row.Phone || '').trim();

      if (email && fans.has(email) && phone) {
        fans.get(email).phone = phone;
        phonesAdded++;
      } else if (email && !fans.has(email)) {
        fans.set(email, {
          email,
          name: row.Name || '',
          phone: phone || null,
          source: 'fanded_club',
          fan_score: null,
          platforms: 'fanded_club',
          mailchimp_status: '',
          patreon_tier: '',
          fanded_tier: row.Tier || '',
          location: '',
          do_not_email: false,
          do_not_sms: false
        });
        newAdded++;
      } else if (!email && phone) {
        // Phone-only contacts
        fans.set('phone_' + phone, {
          email: null,
          name: row.Name || '',
          phone,
          source: 'fanded_club',
          fan_score: null,
          platforms: 'fanded_club',
          mailchimp_status: '',
          patreon_tier: '',
          fanded_tier: row.Tier || '',
          location: '',
          do_not_email: true,
          do_not_sms: false
        });
        newAdded++;
      }
    }
    console.log('Fanded Club: phones added to existing:', phonesAdded, ', new contacts:', newAdded);
  } catch (e) { console.error('Error loading Fanded Club:', e.message); }

  return fans;
}

// ── Step 3: Insert into Supabase ──
async function insertFans(fans) {
  const records = Array.from(fans.values()).map(f => ({
    email: f.email,
    name: f.name || null,
    phone: f.phone || null,
    source: f.source,
    fan_score: f.fan_score,
    platforms: f.platforms || null,
    mailchimp_status: f.mailchimp_status || null,
    patreon_tier: f.patreon_tier || null,
    fanded_tier: f.fanded_tier || null,
    location: f.location || null,
    do_not_email: f.do_not_email || false,
    do_not_sms: f.do_not_sms || false
  }));

  console.log('\nTotal contacts to insert:', records.length);
  console.log('With email:', records.filter(r => r.email && r.email.includes('@')).length);
  console.log('Do not email:', records.filter(r => r.do_not_email).length);
  console.log('With phone:', records.filter(r => r.phone).length);

  // Insert in batches of 100
  const batchSize = 100;
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    // Filter out phone-only contacts (null email) for this batch
    const emailBatch = batch.filter(r => r.email);
    const res = await fetch(SUPABASE_URL + '/rest/v1/fan_contacts?on_conflict=email', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(emailBatch)
    });

    if (res.ok) {
      inserted += batch.length;
      process.stdout.write(`\rInserted: ${inserted}/${records.length}`);
    } else {
      const err = await res.text();
      console.error(`\nBatch error at ${i}: ${err}`);
      errors++;
    }
  }

  console.log('\n\nDone!');
  console.log('Inserted:', inserted);
  console.log('Errors:', errors);

  // Final count
  const countRes = await fetch(SUPABASE_URL + '/rest/v1/fan_contacts?select=count', {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'count=exact'
    }
  });
  const countHeader = countRes.headers.get('content-range');
  console.log('Total in table:', countHeader);
}

// ── Run ──
async function main() {
  await createTable();
  const fans = loadFans();
  await insertFans(fans);
}

main().catch(console.error);
