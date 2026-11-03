import 'dotenv/config';
import express from 'express';
import { requireAuth, requireRole } from './middleware/auth.js';
import jobRoutes from './routes/jobs.js';

const app = express();
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
