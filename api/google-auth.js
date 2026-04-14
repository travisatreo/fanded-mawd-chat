// Google OAuth callback — handles per-user token storage for multi-MAWD
// Step 1: GET /api/google-auth?mawd=slug → redirects to Google consent
// Step 2: Google redirects back with ?code=&state=mawd_slug → exchanges for refresh token → stores in Supabase

import { supabaseQuery } from './supabase.js';

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = 'https://fanded-mawd-chat.vercel.app/api/google-auth';

  const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
  ].join(' ');

  // Step 2: Handle callback with authorization code
  if (req.query.code) {
    const state = req.query.state || '';
    const mawdSlug = state.replace(/^gmail_/, '') === 'direct' ? '' : state.replace(/^gmail_/, '');

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      const data = await tokenRes.json();

      if (data.error) {
        return res.status(400).send(`
          <html><body style="background:#0a0a0a;color:#e0e0e0;font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
            <h2 style="color:#ef4444;">OAuth Error</h2>
            <pre>${JSON.stringify(data, null, 2)}</pre>
            <a href="/onboard.html" style="color:#C4953A;">Try again</a>
          </body></html>
        `);
      }

      // Get the user's email from the access token
      let userEmail = '';
      try {
        const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { 'Authorization': `Bearer ${data.access_token}` }
        });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          userEmail = profile.emailAddress || '';
        }
      } catch (e) {
        console.error('Failed to fetch Gmail profile:', e.message);
      }

      // Store tokens in Supabase mawd_instances if we have a slug
      if (mawdSlug && data.refresh_token) {
        try {
          await supabaseQuery(`mawd_instances?slug=eq.${mawdSlug}`, {
            method: 'PATCH',
            body: {
              google_refresh_token: data.refresh_token,
              google_scopes: SCOPES,
              google_email: userEmail
            }
          });
          console.log(`Stored Google tokens for MAWD: ${mawdSlug} (${userEmail})`);
        } catch (e) {
          console.error('Failed to store tokens in Supabase:', e.message);
        }
      }

      // Redirect back to onboarding with success
      if (mawdSlug) {
        return res.redirect(302,
          `/onboard.html?gmail=connected&mawd=${encodeURIComponent(mawdSlug)}&email=${encodeURIComponent(userEmail)}`
        );
      }

      // Fallback: show the token for manual copy (Travis's direct auth flow)
      return res.status(200).send(`
        <html>
        <body style="background:#0a0a0a;color:#e0e0e0;font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
          <h2 style="color:#C4953A;">Google OAuth Complete</h2>
          <p>Email: ${userEmail}</p>
          <p>Scopes: Gmail (send + read), Calendar</p>
          ${mawdSlug ? `<p>MAWD: ${mawdSlug} (tokens stored)</p>` : ''}
          <h3>Refresh Token:</h3>
          <textarea style="width:100%;height:120px;background:#1a1a1a;color:#C4953A;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;" readonly onclick="this.select()">${data.refresh_token || 'No refresh token returned. Try revoking access at myaccount.google.com/permissions first.'}</textarea>
          <p style="margin-top:16px;color:#888;">Copy this token to Vercel env var <strong>GOOGLE_REFRESH_TOKEN</strong> and redeploy.</p>
        </body>
        </html>
      `);
    } catch (err) {
      return res.status(500).send(`<h2>Error</h2><pre>${err.message}</pre>`);
    }
  }

  // Step 1: Redirect to Google consent
  // Pass mawd slug through state param so we know where to store tokens on callback
  const mawdSlug = req.query.mawd || '';
  const stateParam = mawdSlug ? `gmail_${mawdSlug}` : 'gmail_direct';

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&state=${encodeURIComponent(stateParam)}`;

  return res.redirect(302, authUrl);
}
