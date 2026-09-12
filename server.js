import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import adminRoutes from './routes/admin.js';
import clientsRoutes from './routes/clients.js';
import rendersRoutes from './routes/renders.js';
import publicRoutes from './routes/public.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import Admin from './models/Admin.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/interior-design';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"]
    }
  }
}));

app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
  credentials: true
}));

app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadsDir));

app.use('/api/admin', adminRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/renders', rendersRoutes);
app.use('/api', publicRoutes);

app.get(['/', '/admin'], (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const existing = await Admin.findOne({ username });
  if (existing) return;
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  await Admin.create({
    username,
    password,
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    firstName: 'Admin',
    companyName: 'Studio Render'
  });
  console.log(`👤 Admin iniziale creato: ${username}`);
}

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('✅ MongoDB connesso');
    await ensureAdmin();
    app.listen(PORT, () => {
      console.log(`🚀 Server su http://localhost:${PORT}`);
      console.log(`📍 Admin UI: http://localhost:${PORT}/admin`);
    });
  })
  .catch((err) => {
    console.error('❌ MongoDB Connection Error:', err.message);
    process.exit(1);
  });

export default app;
