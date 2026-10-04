require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

require('./db'); // ensures tables exist before routes touch them

const authRoutes = require('./routes/auth');
const batchRoutes = require('./routes/batches');
const unitRoutes = require('./routes/units');
const verifyRoutes = require('./routes/verify');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api', unitRoutes); // exposes /api/batches/:batchId/units and /api/units/:code/qr.png
app.use('/api/verify', verifyRoutes);

// Serve the frontend so the whole app runs from one origin (no CORS headaches).
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Product Authenticator running at http://localhost:${PORT}`);
});
