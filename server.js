const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const session      = require('express-session');
const passport     = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto       = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Env ───────────────────────────────────────────────────────────────────────
const DD_API_KEY         = process.env.DD_API_KEY;
const DD_APP_KEY         = process.env.DD_APP_KEY;
const GOOGLE_CLIENT_ID   = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET     = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CALLBACK_URL       = process.env.CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

// ── Session ───────────────────────────────────────────────────────────────────
app.use(session({
  name: 'polyscore_session',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 * 7, // 7 days
  },
}));

// ── Passport / Google OAuth ───────────────────────────────────────────────────
passport.use(new GoogleStrategy(
  { clientID: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, callbackURL: CALLBACK_URL },
  (_accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    console.log('[OAuth] email received:', email);
    if (!email || (!email.endsWith('@poly-ai.com') && !email.endsWith('@polyai.com'))) {
      console.log('[OAuth] REJECTED — not a PolyAI domain');
      return done(null, false, { message: 'not_polyai' });
    }
    console.log('[OAuth] ACCEPTED');

    return done(null, { email, name: profile.displayName, avatar: profile.photos?.[0]?.value });
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorised' });
  res.redirect('/login');
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  const error = req.query.error;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>PolyAI — Polyscore Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#1a1d27;border:1px solid #2a2d3a;border-radius:16px;padding:48px 40px;
      text-align:center;max-width:380px;width:100%}
    .logo{font-size:40px;margin-bottom:16px}
    h1{font-size:20px;font-weight:700;margin-bottom:8px}
    p{color:#8892a4;font-size:14px;margin-bottom:32px;line-height:1.5}
    .btn{display:inline-flex;align-items:center;gap:10px;background:white;color:#1a1a1a;
      padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;
      text-decoration:none;transition:opacity 0.15s}
    .btn:hover{opacity:0.9}
    .btn img{width:20px;height:20px}
    .error{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);
      border-radius:8px;padding:10px 16px;color:#f87171;font-size:13px;margin-bottom:20px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>Polyscore Dashboard</h1>
    <p>Sign in with your PolyAI Google account to continue</p>
    ${error === 'not_polyai' ? '<div class="error">Access denied — only @poly-ai.com accounts allowed.</div>' : ''}
    <a href="/auth/google" class="btn">
      <img src="https://www.google.com/favicon.ico" alt="Google"/>
      Sign in with Google
    </a>
  </div>
</body>
</html>`);
});

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=not_polyai' }),
  (_req, res) => res.redirect('/')
);

app.post('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie('polyscore_session');
      res.redirect('/login');
    });
  });
});

// ── Static files (protected) ──────────────────────────────────────────────────
// Serve index.html explicitly so auth middleware runs (CDN must not cache it)
app.get('/', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Other static assets (JS, CSS, etc.) — no auth needed for assets
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // disable auto index.html serving
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// ── API: /api/polyscores ──────────────────────────────────────────────────────
app.get('/api/polyscores', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to params required' });

    const payload = {
      filter: {
        query: 'service:callamari @client_env:live',
        from,
        to,
      },
      compute: [
        { aggregation: 'avg', metric: '@poly_score' },
        { aggregation: 'count' },
      ],
      group_by: [
        { facet: '@account_id', limit: 50 },
        { facet: '@project_id', limit: 50 },
      ],
      page: { limit: 1000 },
    };

    const ddRes = await fetch('https://api.datadoghq.com/api/v2/logs/analytics/aggregate', {
      method: 'POST',
      headers: {
        'DD-API-KEY': DD_API_KEY,
        'DD-APPLICATION-KEY': DD_APP_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!ddRes.ok) {
      const text = await ddRes.text();
      return res.status(ddRes.status).json({ error: text });
    }

    const data = await ddRes.json();
    const buckets = data?.data?.buckets || [];

    const results = buckets
      .map(b => ({
        project: b.by['@project_id'],
        account: b.by['@account_id'],
        score:   b.computes?.c0 ?? null,
        calls:   b.computes?.c1 ?? 0,
      }))
      .filter(d => d.score !== null)
      .sort((a, b) => b.score - a.score);

    res.json({ results, from, to });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: /api/me ──────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// Catch-all: redirect unauthenticated to login
app.use((req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login');
  res.status(404).send('Not found');
});

app.listen(PORT, () => console.log(`Polyscore dashboard on port ${PORT}`));
