require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

require('./db'); // ensures tables exist before routes touch them

const security = require('./security');
const authRoutes = require('./routes/auth');
const batchRoutes = require('./routes/batches');
const unitRoutes = require('./routes/units');
const verifyRoutes = require('./routes/verify');
const companyRoutes = require('./routes/company');
const adminRoutes = require('./routes/admin');

const app = express();

// Railway sits behind a proxy that handles HTTPS. This makes req.protocol say
// "https" and req.ip show the visitor's real address.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Protection against abuse (see security.js)
app.use('/api', security.apiLimiter);
app.use('/api/verify', security.verifyLimiter);
app.post('/api/auth/login', security.loginGuard);
app.post('/api/auth/register', security.registerLimiter, security.registerRules);

app.use('/api/auth', authRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api', unitRoutes); // /api/batches/:batchId/units, /api/units/:code/qr.png, /api/units/:code/review
app.use('/api/verify', verifyRoutes);
app.use('/api', companyRoutes); // alerts and settings
app.use('/api/admin', adminRoutes);

// Serve the frontend so the whole app runs from one origin (no CORS headaches).
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Anything that goes wrong inside a route becomes a clean JSON error
// instead of an HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Product Authenticator running at http://localhost:${PORT}`);
  require('./jobs').start();
});
