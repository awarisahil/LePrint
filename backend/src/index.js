import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requireAuth, requireRole } from './middleware/auth.js';
import jobRoutes from './routes/jobs.js';
import vendorRoutes from './routes/vendor.js';
import adminRoutes from './routes/admin.js';

const app = express();
// Dev: allow the Vite dev server to call the API. Tighten to your real origin in production.
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pdf-platform-backend' });
});

// Identity check: proves the backend can verify callers and read their role.
// Later slices (job generation, downloads) build on requireAuth/requireRole.
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/admin-only-ping', requireAuth, requireRole('ADMIN'), (_req, res) => {
  res.json({ pong: true });
});

app.use('/api/jobs', jobRoutes);
app.use('/api/vendor', vendorRoutes);
app.use('/api/admin', adminRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
