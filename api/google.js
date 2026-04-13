// MAWD Google API — Gmail send + Calendar create + read
// Supports per-user OAuth2 refresh tokens (multi-MAWD) or env var fallback (Travis)

// Per-user token: pass { refreshToken } to any function, or it falls back to env var
async function getAccessToken(userRefreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = userRefreshToken || process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth not configured');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Token refresh failed: ' + err);
  }

  const data = await res.json();
  return data.access_token;
}

// ── Gmail: Create draft ──
export async function createDraft({ to, subject, body, cc, bcc, _refreshToken }) {
  const token = await getAccessToken(_refreshToken);

  // Build RFC 2822 email
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);

  const raw = headers.join('\r\n') + '\r\n\r\n' + body;
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: { raw: encoded } })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Draft creation failed: ' + err);
  }

  return await res.json();
}

// ── Gmail: Send email ──
export async function sendEmail({ to, subject, body, html, cc, bcc, _refreshToken }) {
  const token = await getAccessToken(_refreshToken);

  // RFC 2047 encode subject if it contains non-ASCII characters
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?='
    : subject;

  const contentType = html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  const headers = [
    `From: Travis Atreo <travis@travisatreo.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);

  const raw = headers.join('\r\n') + '\r\n\r\n' + (html || body);
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encoded })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Email send failed: ' + err);
  }

  return await res.json();
}

// ── Calendar: Create event ──
export async function createEvent({ summary, description, startTime, endTime, attendees, location, _refreshToken }) {
  const token = await getAccessToken(_refreshToken);

  const event = {
    summary,
    description: description || '',
    start: { dateTime: startTime, timeZone: 'America/Los_Angeles' },
    end: { dateTime: endTime, timeZone: 'America/Los_Angeles' },
  };

  if (location) event.location = location;
  if (attendees && attendees.length) {
    event.attendees = attendees.map(e => ({ email: e }));
    event.conferenceData = undefined;
  }

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Event creation failed: ' + err);
  }

  return await res.json();
}

// ── Gmail: List recent emails ──
export async function listEmails({ maxResults = 10, query = '', labelIds, _refreshToken } = {}) {
  const token = await getAccessToken(_refreshToken);

  let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;
  if (query) url += `&q=${encodeURIComponent(query)}`;
  if (labelIds) url += `&labelIds=${labelIds}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('List emails failed: ' + await res.text());
  const data = await res.json();

  if (!data.messages || data.messages.length === 0) return [];

  // Fetch headers for each message
  const emails = await Promise.all(data.messages.map(async (msg) => {
    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!mRes.ok) return null;
    const mData = await mRes.json();
    const headers = {};
    (mData.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
    return {
      id: mData.id,
      threadId: mData.threadId,
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '(no subject)',
      date: headers.Date || '',
      snippet: mData.snippet || '',
      labels: mData.labelIds || [],
      isUnread: (mData.labelIds || []).includes('UNREAD')
    };
  }));

  return emails.filter(Boolean);
}

// ── Gmail: Read full email ──
export async function readEmail({ id, _refreshToken }) {
  const token = await getAccessToken(_refreshToken);

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('Read email failed: ' + await res.text());
  const data = await res.json();

  const headers = {};
  (data.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });

  // Extract plain text body
  function getBody(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const result = getBody(part);
        if (result) return result;
      }
    }
    return '';
  }

  return {
    id: data.id,
    threadId: data.threadId,
    from: headers.From || '',
    to: headers.To || '',
    subject: headers.Subject || '',
    date: headers.Date || '',
    body: getBody(data.payload),
    snippet: data.snippet || '',
    labels: data.labelIds || [],
    isUnread: (data.labelIds || []).includes('UNREAD')
  };
}

// ── Gmail: Read full thread ──
export async function readThread({ threadId, _refreshToken }) {
  const token = await getAccessToken(_refreshToken);

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('Read thread failed: ' + await res.text());
  const data = await res.json();

  function getBody(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const result = getBody(part);
        if (result) return result;
      }
    }
    return '';
  }

  return (data.messages || []).map(msg => {
    const headers = {};
    (msg.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
    return {
      id: msg.id,
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '',
      date: headers.Date || '',
      body: getBody(msg.payload),
      snippet: msg.snippet || ''
    };
  });
}

// ── Gmail: Reply to an email (in-thread) ──
export async function replyToEmail({ messageId, threadId, to, body, html, _refreshToken }) {
  const token = await getAccessToken(_refreshToken);

  // Get original message to grab subject and Message-ID for threading
  const origRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!origRes.ok) throw new Error('Failed to fetch original message');
  const origData = await origRes.json();
  const origHeaders = {};
  (origData.payload?.headers || []).forEach(h => { origHeaders[h.name] = h.value; });

  const subject = origHeaders.Subject?.startsWith('Re:') ? origHeaders.Subject : `Re: ${origHeaders.Subject || ''}`;
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?='
    : subject;

  const contentType = html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  const headers = [
    `From: Travis Atreo <travis@travisatreo.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
    `In-Reply-To: ${origHeaders['Message-ID'] || ''}`,
    `References: ${origHeaders['Message-ID'] || ''}`
  ];

  const raw = headers.join('\r\n') + '\r\n\r\n' + (html || body);
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encoded, threadId })
  });

  if (!res.ok) throw new Error('Reply failed: ' + await res.text());
  return await res.json();
}

// ── Calendar: List events ──
export async function listEvents({ timeMin, timeMax, maxResults = 10, query, _refreshToken } = {}) {
  const token = await getAccessToken(_refreshToken);

  const now = new Date();
  const min = timeMin || now.toISOString();
  const max = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  let url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
    `timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}` +
    `&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`;
  if (query) url += `&q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('List events failed: ' + await res.text());
  const data = await res.json();

  return (data.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || '(no title)',
    start: ev.start?.dateTime || ev.start?.date || '',
    end: ev.end?.dateTime || ev.end?.date || '',
    location: ev.location || '',
    attendees: (ev.attendees || []).map(a => ({ email: a.email, status: a.responseStatus })),
    description: ev.description || '',
    htmlLink: ev.htmlLink || ''
  }));
}

// ── Calendar: Find free time slots ──
export async function findFreeTime({ emails, timeMin, timeMax, duration = 30, _refreshToken } = {}) {
  const token = await getAccessToken(_refreshToken);

  const now = new Date();
  const min = timeMin || now.toISOString();
  const max = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const items = (emails || []).map(email => ({ id: email }));
  // Always include the current user
  if (!items.find(i => i.id === 'primary')) {
    items.unshift({ id: 'primary' });
  }

  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      timeMin: min,
      timeMax: max,
      items
    })
  });

  if (!res.ok) throw new Error('FreeBusy query failed: ' + await res.text());
  const data = await res.json();

  // Parse busy times per calendar
  const busyByCalendar = {};
  for (const [cal, info] of Object.entries(data.calendars || {})) {
    busyByCalendar[cal] = (info.busy || []).map(b => ({
      start: b.start,
      end: b.end
    }));
  }

  // Find common free slots (simple: merge all busy, find gaps)
  const allBusy = Object.values(busyByCalendar).flat()
    .map(b => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping busy periods
  const merged = [];
  for (const b of allBusy) {
    if (merged.length && b.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  // Find free slots of at least `duration` minutes between 9am-6pm PT
  const durationMs = duration * 60 * 1000;
  const freeSlots = [];
  const startTime = new Date(min).getTime();
  const endTime = new Date(max).getTime();

  let cursor = startTime;
  for (const busy of merged) {
    if (busy.start - cursor >= durationMs) {
      // Check if the gap falls in business hours
      const gapStart = new Date(cursor);
      const hour = gapStart.getHours();
      if (hour >= 9 && hour < 18) {
        freeSlots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(Math.min(cursor + durationMs, busy.start)).toISOString()
        });
      }
    }
    cursor = Math.max(cursor, busy.end);
  }
  // Check gap after last busy
  if (endTime - cursor >= durationMs) {
    freeSlots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(cursor + durationMs).toISOString()
    });
  }

  return {
    busyByCalendar,
    freeSlots: freeSlots.slice(0, 10),
    duration,
    range: { min, max }
  };
}

// ── Execute a tool call ──
// Note: save_memory is handled directly in chat.js, not here
// Pass _refreshToken through to support per-user OAuth
export async function executeTool(name, input, refreshToken) {
  const inputWithToken = refreshToken ? { ...input, _refreshToken: refreshToken } : input;
  switch (name) {
    case 'send_email':
      return await sendEmail(inputWithToken);
    case 'create_draft':
      return await createDraft(inputWithToken);
    case 'create_event':
      return await createEvent(inputWithToken);
    case 'list_emails':
      return await listEmails(inputWithToken);
    case 'read_email':
      return await readEmail(inputWithToken);
    case 'read_thread':
      return await readThread(inputWithToken);
    case 'reply_to_email':
      return await replyToEmail(inputWithToken);
    case 'list_events':
      return await listEvents(inputWithToken);
    case 'find_free_time':
      return await findFreeTime(inputWithToken);
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
