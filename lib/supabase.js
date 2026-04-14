// Supabase data layer for MAWD — reads real data from Fanded's production database
// All tables are prefixed with fanded_ via pgTableCreator

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jlwidechsxtgxmttypzs.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Travis's club ID — needed for all queries
const CLUB_ID = process.env.FANDED_CLUB_ID || null;

async function supabaseQuery(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');

  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...options.headers
    },
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }

  return res.json();
}

// ── Member Stats ──
export async function getMemberStats(clubId) {
  const cid = clubId || CLUB_ID;
  if (!cid) return { total: 0, newThisWeek: 0, churnRisk: 0, error: 'No club ID' };

  const now = new Date();
  const weekAgo = new Date(now - 7 * 864e5).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 864e5).toISOString();

  // Total members
  const members = await supabaseQuery(
    `fanded_users_to_clubs?club_id=eq.${cid}&select=user_id,createdAt`
  );

  // New this week
  const newMembers = members.filter(m => m.createdAt >= weekAgo);

  // Active subscriptions
  const activeSubs = await supabaseQuery(
    `fanded_subscriptions?club_id=eq.${cid}&is_active=eq.true&select=id,user_id,createdAt,updatedAt`
  );

  return {
    total: members.length,
    newThisWeek: newMembers.length,
    activeSubscriptions: activeSubs.length,
    churnRisk: members.length - activeSubs.length,
    retention: members.length > 0 ? Math.round((activeSubs.length / members.length) * 100) : 0
  };
}

// ── Revenue ──
export async function getRevenue(clubId) {
  const cid = clubId || CLUB_ID;
  if (!cid) return { mrr: 0, trend: 'unknown', error: 'No club ID' };

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString();

  // This month's payments
  const thisMonth = await supabaseQuery(
    `fanded_club_subscription_payments?club_id=eq.${cid}&created_at=gte.${thisMonthStart}&select=amount_cents`
  );

  // Last month's payments
  const lastMonth = await supabaseQuery(
    `fanded_club_subscription_payments?club_id=eq.${cid}&created_at=gte.${lastMonthStart}&created_at=lt.${thisMonthStart}&select=amount_cents`
  );

  const thisMonthTotal = thisMonth.reduce((sum, p) => sum + (p.amount_cents || 0), 0) / 100;
  const lastMonthTotal = lastMonth.reduce((sum, p) => sum + (p.amount_cents || 0), 0) / 100;

  const trend = lastMonthTotal > 0
    ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100)
    : 0;

  return {
    mrr: Math.round(thisMonthTotal),
    lastMonth: Math.round(lastMonthTotal),
    trend: trend > 0 ? `+${trend}%` : `${trend}%`,
    trendDirection: trend >= 0 ? 'up' : 'down'
  };
}

// ── Recent Fan Messages (posts/replies from fans) ──
export async function getRecentMessages(clubId, days = 7) {
  const cid = clubId || CLUB_ID;
  if (!cid) return [];

  const since = new Date(Date.now() - days * 864e5).toISOString();

  // Get recent post replies (fan messages)
  const replies = await supabaseQuery(
    `fanded_post_replies?select=id,user_id,body,createdAt,post_id&order=createdAt.desc&limit=20&createdAt=gte.${since}`
  );

  return replies.map(r => ({
    id: r.id,
    userId: r.user_id,
    body: r.body,
    createdAt: r.createdAt,
    postId: r.post_id
  }));
}

// ── Content Gap ──
export async function getContentGap(clubId) {
  const cid = clubId || CLUB_ID;
  if (!cid) return { daysSinceLastPost: 0, error: 'No club ID' };

  const recentPosts = await supabaseQuery(
    `fanded_posts?club_id=eq.${cid}&is_deleted=eq.false&is_draft=eq.false&select=id,createdAt&order=createdAt.desc&limit=1`
  );

  if (!recentPosts.length) return { daysSinceLastPost: 999, lastPostDate: null };

  const lastPost = new Date(recentPosts[0].createdAt);
  const daysSince = Math.floor((Date.now() - lastPost.getTime()) / 864e5);

  return {
    daysSinceLastPost: daysSince,
    lastPostDate: recentPosts[0].createdAt
  };
}

// ── Milestones (anniversaries this week) ──
export async function getMilestones(clubId) {
  const cid = clubId || CLUB_ID;
  if (!cid) return [];

  const members = await supabaseQuery(
    `fanded_users_to_clubs?club_id=eq.${cid}&select=user_id,createdAt`
  );

  const now = new Date();
  const milestones = [];

  for (const m of members) {
    const joinDate = new Date(m.createdAt);
    const monthsSince = (now.getFullYear() - joinDate.getFullYear()) * 12 + (now.getMonth() - joinDate.getMonth());

    // Check for yearly anniversaries within this week
    if (monthsSince > 0 && monthsSince % 12 === 0) {
      const anniversaryThisYear = new Date(now.getFullYear(), joinDate.getMonth(), joinDate.getDate());
      const daysUntil = Math.floor((anniversaryThisYear - now) / 864e5);
      if (daysUntil >= -3 && daysUntil <= 7) {
        milestones.push({
          userId: m.user_id,
          type: 'anniversary',
          years: monthsSince / 12,
          joinDate: m.createdAt
        });
      }
    }
  }

  return milestones;
}

// ── Member Profiles (for enriching data) ──
export async function getMemberProfiles(userIds) {
  if (!userIds.length) return {};

  const idFilter = userIds.map(id => `"${id}"`).join(',');
  const profiles = await supabaseQuery(
    `fanded_profiles?id=in.(${idFilter})&select=id,name,email`
  );

  const map = {};
  for (const p of profiles) {
    map[p.id] = { name: p.name, email: p.email };
  }
  return map;
}

// ── Recent Posts (for context) ──
export async function getRecentPosts(clubId, limit = 5) {
  const cid = clubId || CLUB_ID;
  if (!cid) return [];

  return supabaseQuery(
    `fanded_posts?club_id=eq.${cid}&is_deleted=eq.false&is_draft=eq.false&select=id,title,body,createdAt,likes,comments,access_level&order=createdAt.desc&limit=${limit}`
  );
}

// ── Full Business Snapshot (used by briefing + chat) ──
export async function getBusinessSnapshot(clubId) {
  const cid = clubId || CLUB_ID;

  try {
    const [memberStats, revenue, contentGap, milestones, recentPosts, recentMessages] = await Promise.all([
      getMemberStats(cid),
      getRevenue(cid),
      getContentGap(cid),
      getMilestones(cid),
      getRecentPosts(cid, 3),
      getRecentMessages(cid, 7)
    ]);

    // Enrich milestones with names
    const milestoneUserIds = milestones.map(m => m.userId);
    const messageUserIds = [...new Set(recentMessages.map(m => m.userId))];
    const allUserIds = [...new Set([...milestoneUserIds, ...messageUserIds])];
    const profiles = allUserIds.length ? await getMemberProfiles(allUserIds) : {};

    return {
      members: memberStats,
      revenue: revenue,
      contentGap: contentGap,
      milestones: milestones.map(m => ({
        ...m,
        name: profiles[m.userId]?.name || 'A fan'
      })),
      recentPosts: recentPosts.map(p => ({
        title: p.title,
        body: p.body?.substring(0, 200),
        date: p.createdAt,
        likes: p.likes,
        comments: p.comments
      })),
      recentMessages: recentMessages.map(m => ({
        ...m,
        name: profiles[m.userId]?.name || 'A fan',
        body: m.body?.substring(0, 300)
      })),
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('Business snapshot error:', err);
    return {
      error: err.message,
      members: { total: 0, newThisWeek: 0, retention: 0 },
      revenue: { mrr: 0, trend: '0%' },
      contentGap: { daysSinceLastPost: 0 },
      milestones: [],
      recentPosts: [],
      recentMessages: [],
      timestamp: new Date().toISOString()
    };
  }
}

// ── MAWD Memory System ──
// Stores learnings, preferences, and context that persists across conversations
// Uses a simple key-value table: mawd_memory

export async function getMemories(limit = 50) {
  if (!SUPABASE_KEY) return [];
  try {
    return await supabaseQuery(
      `mawd_memory?select=id,category,content,created_at&order=created_at.desc&limit=${limit}`
    );
  } catch (e) {
    console.error('Memory read error:', e.message);
    return [];
  }
}

export async function saveMemory(category, content) {
  if (!SUPABASE_KEY) return null;
  try {
    return await supabaseQuery('mawd_memory', {
      method: 'POST',
      body: { category, content, created_at: new Date().toISOString() },
      headers: { 'Prefer': 'return=representation' }
    });
  } catch (e) {
    console.error('Memory write error:', e.message);
    return null;
  }
}

export async function getMemoriesByCategory(category) {
  if (!SUPABASE_KEY) return [];
  try {
    return await supabaseQuery(
      `mawd_memory?category=eq.${category}&select=id,content,created_at&order=created_at.desc&limit=20`
    );
  } catch (e) {
    return [];
  }
}

// Export for use by other API routes
export { supabaseQuery, CLUB_ID };
