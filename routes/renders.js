import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';
import zlib from 'zlib';
import { promisify } from 'util';

import mongoose from 'mongoose';
import Render from '../models/Render.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const router = express.Router();

function gridBucket() {
  if (!mongoose.connection?.db) throw new Error('Mongo non connesso');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'renders' });
}

async function putInGrid(filename, buffer) {
  const bucket = gridBucket();
  const id = await new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, { contentType: 'image/png' });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(buffer);
  });
  return id;
}

function safeUploadName(name) {
  if (!name || typeof name !== 'string') return null;
  const base = path.basename(name);
  if (!base || base === '.' || base === '..') return null;
  return base;
}

async function unlinkUpload(name) {
  const base = safeUploadName(name);
  if (!base) return;
  await fs.unlink(path.join(UPLOADS_DIR, base)).catch(() => {});
}

async function deleteGridFile(filename, gridFileId) {
  try {
    const bucket = gridBucket();
    if (gridFileId) await bucket.delete(gridFileId).catch(() => {});
    const base = safeUploadName(filename);
    if (!base) return;
    const files = await bucket.find({ filename: base }).toArray();
    for (const f of files) await bucket.delete(f._id).catch(() => {});
  } catch {}
}

function auxNamesFrom(render) {
  const meta = render?.metadata && typeof render.metadata === 'object' ? render.metadata : {};
  const names = [];
  if (Array.isArray(meta.auxFiles)) names.push(...meta.auxFiles);
  for (const key of ['sourceImage', 'planImage', 'plan2d']) {
    if (meta[key]) names.push(meta[key]);
  }
  return names.map(safeUploadName).filter(Boolean);
}

async function purgeRenderStorage(render) {
  if (!render) return;
  await unlinkUpload(render.imageFile);
  await deleteGridFile(render.imageFile, render.gridFileId);
  for (const name of auxNamesFrom(render)) {
    await unlinkUpload(name);
    await deleteGridFile(name, null);
  }
}

async function referencedUploadNames() {
  const docs = await Render.find({}, { imageFile: 1, metadata: 1 }).lean();
  const names = new Set();
  for (const doc of docs) {
    const image = safeUploadName(doc.imageFile);
    if (image) names.add(image);
    for (const name of auxNamesFrom(doc)) names.add(name);
  }
  return names;
}

async function sweepOrphanUploads(maxAgeMs = 60 * 60 * 1000) {
  const referenced = await referencedUploadNames();
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(UPLOADS_DIR);
  } catch {
    return { removed };
  }
  const now = Date.now();
  for (const name of entries) {
    const base = safeUploadName(name);
    if (!base || referenced.has(base)) continue;
    const full = path.join(UPLOADS_DIR, base);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < maxAgeMs) continue;
      await fs.unlink(full);
      removed += 1;
    } catch {}
  }
  try {
    const bucket = gridBucket();
    const files = await bucket.find({}).toArray();
    for (const f of files) {
      if (referenced.has(f.filename)) continue;
      await bucket.delete(f._id).catch(() => {});
      removed += 1;
    }
  } catch {}
  return { removed };
}

async function cleanupExpiredRenders() {
  try {
    const cutoff = new Date();
    const expired = await Render.find({ expiresAt: { $lt: cutoff } }).lean();
    for (const r of expired) {
      await purgeRenderStorage(r);
      await Render.deleteOne({ _id: r._id });
    }
    if (expired.length) console.log(`Puliti ${expired.length} render scaduti (7gg)`);
  } catch (err) {
    console.error('cleanupExpiredRenders', err.message);
  }
}

// Esegui cleanup all'avvio e ogni 6 ore
setTimeout(cleanupExpiredRenders, 5000);
setInterval(cleanupExpiredRenders, 6 * 60 * 60 * 1000);

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

// ... resto del file originale con le patch di expiresAt e prompt ...
export default router;
