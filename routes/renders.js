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

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(Buffer.concat([local, data]));
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

async function readGridByName(filename) {
  const bucket = gridBucket();
  const files = await bucket.find({ filename }).toArray();
  if (!files.length) return null;
  const chunks = [];
  await new Promise((resolve, reject) => {
    bucket.openDownloadStreamByName(filename)
      .on('data', (c) => chunks.push(c))
      .on('error', reject)
      .on('end', resolve);
  });
  return Buffer.concat(chunks);
}

router.get('/media/:filename', async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename);
    const disk = path.join(UPLOADS_DIR, filename);
    try {
      await fs.access(disk);
      res.type('png');
      return res.sendFile(disk);
    } catch {}
    const buf = await readGridByName(filename);
    if (!buf) return res.status(404).json({ success: false, error: 'File non trovato' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(buf);
  } catch (error) {
    next(error);
  }
});

router.use(authenticate);

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY non configurata');
    err.status = 500;
    throw err;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safe = path.basename(file.originalname).replace(/[^\w.\-]+/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MODEL_EXT = ['.obj', '.mtl', '.stl', '.gltf', '.glb', '.dae', '.zip', '.txt', '.skp'];
const MODEL_MIME = [
  'application/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/obj',
  'model/obj',
  'text/plain',
  'text/x-obj'
];

const inflateRaw = promisify(zlib.inflateRaw);

const upload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (IMAGE_MIME.includes(mime) || MODEL_EXT.includes(ext) || MODEL_MIME.includes(mime) || mime.startsWith('model/')) {
      cb(null, true);
    } else cb(new Error('Formato non supportato. Usa JPG/PNG, SKP SketchUp, OBJ, MTL o uno ZIP.'));
  }
});

const analyzeUpload = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'model', maxCount: 1 },
  { name: 'mtl', maxCount: 1 }
]);

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_#\-]+/g, ' ');
}

const ROOM_KEYWORDS = {
  bagno: ['bagno', 'bathroom', 'bath ', ' wc', 'wc ', 'cassetta', 'toilet', 'bidet', 'doccia', 'shower', 'lavabo', 'lavandino', 'washbasin', 'vasca', 'bathtub', 'sanitari', 'rubinet', 'piatto doccia', 'box doccia', 'mobile bagno', 'termoarredo', 'scaldasalviette', 'water ', 'w.c', 'sospesi', 'flessa'],
  camera: ['letto', 'bed ', 'bedroom', 'camera da letto', 'materasso', 'mattress', 'comodino', 'nightstand', 'testata', 'headboard', 'piumone'],
  cucina: ['cucina', 'kitchen', 'piano cottura', 'cooktop', 'lavello cucina', 'fridge', 'frigo', 'forno', 'oven', 'cappa', 'isola cucina', 'pensile'],
  salotto: ['salotto', 'soggiorno', 'living', 'divano', 'sofa', 'tv ', 'camino'],
  ufficio: ['scrivania', 'desk', 'ufficio', 'office', 'monitor', 'workstation'],
  wellness: ['sauna', 'hammam', 'spa', 'wellness', 'idromassaggio'],
  palestra: ['gym', 'palestra', 'rack', 'tapis', 'pesi'],
  terrazzo: ['terrazzo', 'terrace', 'balcone'],
  giardino: ['giardino', 'garden', 'prato'],
  piscina: ['piscina', 'pool'],
  cabina: ['cabina', 'walk in', 'wardrobe', 'guardaroba']
};

const FIXTURE_MAP = [
  ['sanitari sospesi', ['toilet', 'vaso', 'cassetta', 'bull_sospesi', 'wc']],
  ['bidet', ['bidet']],
  ['lavabo', ['lavabo', 'lavandino', 'washbasin', 'catino']],
  ['box walk-in', ['doccia', 'shower']],
  ['vasca freestanding', ['vasca', 'bathtub']],
  ['rubinetteria', ['rubinet', 'mixer', 'faucet', 'flessa']],
  ['specchio', ['specchio', 'mirror']],
  ['finestra', ['finestra', 'window']],
  ['isola centrale', ['isola']],
  ['cappa sospesa', ['cappa', 'hood']]
];

function scoreText(text) {
  const t = ' ' + normName(text) + ' ';
  const scores = {};
  for (const [room, kws] of Object.entries(ROOM_KEYWORDS)) {
    scores[room] = kws.reduce((n, kw) => n + (t.includes(kw) ? 1 : 0), 0);
  }
  if (scores.bagno > 0) scores.camera = 0;
  let best = 'altro';
  let bestN = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestN) { bestN = v; best = k; }
  }
  return { best: bestN ? best : 'altro', scores, confidence: bestN };
}

function classifyPart(name) {
  const t = normName(name);
  if (/(paviment|floor|solaio|slab|deck)/.test(t)) return 'floor';
  if (/(soffitto|ceiling|controsoff)/.test(t)) return 'ceiling';
  if (/(muro|muratura|parete|wall|partition|tramezzo)/.test(t)) return 'wall';
  if (/(porta|door|finestra|window|infisso)/.test(t)) return 'opening';
  if (/(toilet|vaso|bidet|doccia|shower|lavabo|vasca|sanitari|cassetta|sospesi|\bwc\b|seduta|panca|seat|flessa)/.test(t)) return 'bathroom-fixture';
  if (/(vetro|glass|box.?doccia|cristallo)/.test(t)) return 'shower-glass';
  if (/(tramezzo|divisori|muretto|partition)/.test(t)) return 'wall';
  if (/(letto|bed|comodino)/.test(t)) return 'bedroom-furniture';
  if (/(cucina|kitchen|forno|cappa|isola)/.test(t)) return 'kitchen-fixture';
  return 'object';
}

function sketchupLabel(line) {
  const parts = String(line).split(/\s+/).filter(Boolean);
  const useful = parts.filter((p) => !/^mesh\d*$/i.test(p) && !/^model$/i.test(p) && !/^group\d*$/i.test(p) && !/^skp/i.test(p));
  const hit = useful.find((p) => /doccia|lavabo|bidet|cassetta|wc|vaso|finestra|porta|door|window|paviment|parete|bagno/i.test(p));
  return hit || useful[useful.length - 1] || parts[0] || line;
}

function catalogFinish(name) {
  const raw = String(name || '').replace(/_/g, ' ').trim();
  const t = normName(raw);
  if (/60\s*x\s*120|60x120/.test(t)) return `gres lastre 60x120 «${raw}»`;
  if (/30\s*x\s*60|30x60|80\s*x\s*80/.test(t)) return `gres «${raw}»`;
  if (/(maison|motley|sigma|marazzi|atlas|florim|casalgrande|fmg)/.test(t)) return `gres catalogo «${raw}»`;
  return '';
}

function guessFinishFromName(name, role) {
  const catalog = catalogFinish(name);
  if (catalog) return catalog;
  const t = normName(name);
  if (role === 'floor') {
    if (/(gres|tile|ceram|porcel)/.test(t)) return 'gres effetto pietra';
    if (/(cotto|terracotta)/.test(t)) return 'cotto fatto a mano';
    if (/(cement|microcement)/.test(t)) return 'microcemento spatolato';
    if (/(parquet|wood|legno|rovere|oak|noce)/.test(t)) return 'parquet listoni';
  }
  if (role === 'wall') {
    if (/(zellige|tile|piastrel)/.test(t)) return 'zellige artigianali';
    if (/(boiserie|cannett|wood panel)/.test(t)) return 'boiserie cannettata';
    if (/(calce|lime|argilla|clay)/.test(t)) return 'calce spatolata';
    if (/(gres|stone|pietra|marmo)/.test(t)) return 'lastre gres pietra';
    if (/(parati|wallpaper)/.test(t)) return 'carta da parati';
  }
  return '';
}

function inferDoor(size, openings, placed, hint) {
  if ((openings || []).some((a) => a.type === 'porta')) return null;
  const roomW = size[0];
  const roomD = size[2];
  const roomH = size[1];
  if (!(roomW > 50 && roomD > 50)) return null;
  const walls = {
    'z-': { length: roomW, occ: [] },
    'z+': { length: roomW, occ: [] },
    'x-': { length: roomD, occ: [] },
    'x+': { length: roomD, occ: [] }
  };
  const add = (wall, a, b) => {
    if (!walls[wall] || !(b > a)) return;
    walls[wall].occ.push([Math.max(0, a), Math.min(walls[wall].length, b)]);
  };
  for (const a of [...(openings || []), ...(placed || [])]) {
    if (a.wall === 'z-' || a.wall === 'z+') add(a.wall, a.fromX, a.fromX + (a.sizeX || a.width || 0));
    else if (a.wall === 'x-' || a.wall === 'x+') add(a.wall, a.fromZ, a.fromZ + (a.sizeZ || a.width || 0));
  }
  const hintN = normName(hint || '');
  const shower = (placed || []).find((p) => /doccia|shower/.test(normName(p.name)));
  const showerWall = shower?.wall;
  const winWall = (openings || []).find((o) => o.type === 'finestra')?.wall;
  const opposite = { 'x-': 'x+', 'x+': 'x-', 'z-': 'z+', 'z+': 'z-' };
  const prefer = [];
  if (/lato|destra|right|\bx\+/.test(hintN) && !/doccia|shower|stessa/.test(hintN)) prefer.push('x+');
  if (/lato|sinistra|left|\bx-/.test(hintN) && !/doccia|shower|stessa/.test(hintN)) prefer.push('x-');
  if (/fondo|finestra|window|\bz-/.test(hintN)) prefer.push('z-');
  if (showerWall) prefer.push(showerWall);
  if (/ingresso|doccia|stessa|opposta|\bz\+/.test(hintN)) prefer.push(showerWall || 'z+');
  if (winWall) prefer.push(opposite[winWall]);
  let best = null;
  for (const wall of [showerWall, 'z+', 'z-', 'x+', 'x-'].filter(Boolean)) {
    const w = walls[wall];
    if (!w) continue;
    const occ = w.occ.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of occ) {
      if (!merged.length || s[0] > merged[merged.length - 1][1] + 8) merged.push(s.slice());
      else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], s[1]);
    }
    let cursor = 0;
    const gaps = [];
    for (const [s, e] of merged) {
      if (s - cursor >= 70) gaps.push([cursor, s]);
      cursor = Math.max(cursor, e);
    }
    if (w.length - cursor >= 70) gaps.push([cursor, w.length]);
    for (const [s, e] of gaps) {
      const gapW = e - s;
      const doorW = Math.min(90, gapW > 100 ? 80 : gapW);
      let start = s;
      if (start + doorW > e) start = Math.max(s, e - doorW);
      let score = Math.min(gapW, 130);
      if (prefer.includes(wall)) score += 90;
      if (showerWall && wall === showerWall) score += 80;
      if (winWall && wall === winWall) score -= 40;
      if (s === 0 || e >= w.length - 1) score += 8;
      if (!best || score > best.score) best = { wall, start, doorW, score };
    }
  }
  if (!best) return null;
  const thick = 12;
  const h = Math.min(210, roomH > 50 ? roomH * 0.78 : 210);
  const item = {
    name: 'porta (vuoto in parete)',
    role: 'opening',
    type: 'porta',
    wall: best.wall,
    width: Number(best.doorW.toFixed(1)),
    height: Number(h.toFixed(1)),
    sill: 0,
    thick,
    inferred: true
  };
  if (best.wall === 'z-' || best.wall === 'z+') {
    item.fromX = Number(best.start.toFixed(1));
    item.fromZ = best.wall === 'z-' ? 0 : Number((roomD - thick).toFixed(1));
    item.sizeX = item.width;
    item.sizeY = item.height;
    item.sizeZ = thick;
  } else {
    item.fromX = best.wall === 'x-' ? 0 : Number((roomW - thick).toFixed(1));
    item.fromZ = Number(best.start.toFixed(1));
    item.sizeX = thick;
    item.sizeY = item.height;
    item.sizeZ = item.width;
  }
  return item;
}

function parseObjSummary(text, mtlText, doorHint) {
  const vertsMin = [Infinity, Infinity, Infinity];
  const vertsMax = [-Infinity, -Infinity, -Infinity];
  let vertCount = 0;
  let faces = 0;
  let current = 'oggetto';
  let currentMat = '';
  let unitsComment = '';
  const objects = new Map();
  const matsUsed = new Set();
  const matFaces = new Map();
  const allLabels = [];
  const verts = [];
  let mtllib = '';
  const ensure = (n) => {
    if (!objects.has(n)) objects.set(n, {
      name: n, materials: new Set(), faces: 0, role: classifyPart(n),
      bb: { xmin: Infinity, ymin: Infinity, zmin: Infinity, xmax: -Infinity, ymax: -Infinity, zmax: -Infinity }
    });
    return objects.get(n);
  };
  const grow = (o, v) => {
    if (v[0] < o.bb.xmin) o.bb.xmin = v[0]; if (v[0] > o.bb.xmax) o.bb.xmax = v[0];
    if (v[1] < o.bb.ymin) o.bb.ymin = v[1]; if (v[1] > o.bb.ymax) o.bb.ymax = v[1];
    if (v[2] < o.bb.zmin) o.bb.zmin = v[2]; if (v[2] > o.bb.zmax) o.bb.zmax = v[2];
  };

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') {
      if (/file units/i.test(line)) unitsComment = line.replace(/^#\s*/,'');
      if (line.startsWith('# object ') || line.startsWith('# Object ')) {
        current = sketchupLabel(line.replace(/^#\s*object\s+/i, ''));
        ensure(current);
        allLabels.push(current);
      }
      continue;
    }
    if (line.startsWith('mtllib ')) mtllib = line.slice(7).trim();
    else if (line.startsWith('o ') || line.startsWith('g ')) {
      current = sketchupLabel(line.slice(2).trim());
      ensure(current);
      allLabels.push(line.slice(2).trim());
    } else if (line.startsWith('usemtl ')) {
      currentMat = line.slice(7).trim();
      matsUsed.add(currentMat);
      ensure(current).materials.add(currentMat);
    } else if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      const x = Number(p[1]), y = Number(p[2]), z = Number(p[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        vertCount += 1;
        verts.push([x, y, z]);
        if (x < vertsMin[0]) vertsMin[0] = x; if (y < vertsMin[1]) vertsMin[1] = y; if (z < vertsMin[2]) vertsMin[2] = z;
        if (x > vertsMax[0]) vertsMax[0] = x; if (y > vertsMax[1]) vertsMax[1] = y; if (z > vertsMax[2]) vertsMax[2] = z;
      }
    } else if (line.startsWith('f ')) {
      faces += 1;
      const o = ensure(current);
      o.faces += 1;
      if (currentMat) matFaces.set(currentMat, (matFaces.get(currentMat) || 0) + 1);
      for (const tok of line.slice(2).trim().split(/\s+/)) {
        let idx = parseInt(tok, 10);
        if (!idx) continue;
        if (idx < 0) idx = verts.length + idx + 1;
        const v = verts[idx - 1];
        if (v) grow(o, v);
      }
    }
  }

  const mtl = mtlText ? parseMtl(mtlText) : {};
  const objList = [...objects.values()].map((o) => ({
    name: o.name,
    role: o.role,
    faces: o.faces,
    materials: [...o.materials].slice(0, 8)
  })).sort((a, b) => b.faces - a.faces).slice(0, 40);

  const blob = allLabels.join(' ') + ' ' + [...matsUsed].join(' ');
  const roomGuess = scoreText(blob);
  const fixtures = [];
  const blobN = normName(blob);
  for (const [label, kws] of FIXTURE_MAP) {
    if (kws.some((k) => blobN.includes(k))) fixtures.push(label);
  }

  const mapped = Object.values(mtl).filter((m) => m.map);
  const missingMaps = mapped.map((m) => m.map);
  const tiles = [...matsUsed]
    .map((n) => ({ name: n, faces: matFaces.get(n) || 0, finish: catalogFinish(n) || guessFinishFromName(n, 'wall') }))
    .filter((t) => t.finish)
    .sort((a, b) => b.faces - a.faces);

  const wallGuess = (tiles[0] && tiles[0].finish) || guessFinishFromName([...matsUsed].join(' '), 'wall');
  const floorGuess = (tiles[1] && tiles[1].finish && tiles[1].name !== tiles[0]?.name)
    ? tiles[1].finish
    : (tiles[0] ? 'gres formato diverso dal rivestimento, tono coordinato ma non uguale' : guessFinishFromName([...matsUsed].join(' '), 'floor'));

  const size = vertCount
    ? [vertsMax[0] - vertsMin[0], vertsMax[1] - vertsMin[1], vertsMax[2] - vertsMin[2]]
    : [0, 0, 0];
  const axis = [...size].sort((a, b) => b - a);
  const unitsGuess = /centimet/i.test(unitsComment) ? 'centimetri'
    : axis[0] > 80 ? 'centimetri o millimetri' : axis[0] > 8 ? 'metri' : 'unita SketchUp';
  const toHuman = (n) => unitsGuess === 'centimetri'
    ? Math.round(n) + ' cm'
    : n.toFixed(2);

  const wallOf = (bb) => {
    const cx = (bb.xmin + bb.xmax) / 2;
    const cz = (bb.zmin + bb.zmax) / 2;
    const d = {
      'x-': Math.abs(cx - vertsMin[0]),
      'x+': Math.abs(cx - vertsMax[0]),
      'z-': Math.abs(cz - vertsMin[2]),
      'z+': Math.abs(cz - vertsMax[2])
    };
    return Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
  };
  const opposite = { 'x-': 'x+', 'x+': 'x-', 'z-': 'z+', 'z+': 'z-' };
  const leftOf = { 'z-': 'x-', 'z+': 'x+', 'x-': 'z+', 'x+': 'z-' };
  const openings = [];
  const placed = [];
  for (const o of objects.values()) {
    if (!o.faces || !Number.isFinite(o.bb.xmin)) continue;
    const wall = wallOf(o.bb);
    const w = o.bb.xmax - o.bb.xmin;
    const h = o.bb.ymax - o.bb.ymin;
    const d = o.bb.zmax - o.bb.zmin;
    const along = Math.max(w, d);
    const thick = Math.min(w, d);
    const item = {
      name: o.name,
      role: o.role,
      wall,
      width: Number(along.toFixed(1)),
      height: Number(h.toFixed(1)),
      sill: Number((o.bb.ymin - vertsMin[1]).toFixed(1)),
      thick: Number(thick.toFixed(1)),
      fromX: Number((o.bb.xmin - vertsMin[0]).toFixed(1)),
      fromZ: Number((o.bb.zmin - vertsMin[2]).toFixed(1)),
      sizeX: Number(w.toFixed(1)),
      sizeY: Number(h.toFixed(1)),
      sizeZ: Number(d.toFixed(1))
    };
    const nm = normName(o.name);
    if (/handle|maniglia|cernier|plastic handle/i.test(nm)) continue;
    const isShell = w > size[0] * 0.85 && d > size[2] * 0.85 && h > size[1] * 0.7;
    if (isShell) continue;
    if (o.role === 'opening' || /(finestra|window|porta|door|infisso)/.test(nm)) {
      if (along < 25 && h < 40) continue;
      item.type = /(porta|door)/.test(nm) ? 'porta' : 'finestra';
      openings.push(item);
    } else if (o.role !== 'floor' && o.role !== 'ceiling' && (o.role !== 'object' || o.faces > 80)) {
      if (Math.max(w, d, h) < 15) continue;
      placed.push(item);
    }
  }
  placed.sort((a, b) => (b.sizeX * b.sizeZ) - (a.sizeX * a.sizeZ));
  const inferredDoor = inferDoor(size, openings, placed, doorHint);
  if (inferredDoor) {
    openings.push(inferredDoor);
    if (!fixtures.includes('porta')) fixtures.push('porta');
  }
  const win = openings.filter((a) => a.type === 'finestra').sort((a, b) => b.width * b.height - a.width * a.height)[0]
    || openings[0];
  const relWall = (wall) => {
    if (!win) return 'parete ' + wall;
    if (wall === win.wall) return 'parete FINESTRA (in fondo, da NON spostare)';
    if (wall === opposite[win.wall]) return 'parete OPPOSTA alla finestra';
    if (wall === leftOf[win.wall]) return 'parete SINISTRA guardando la finestra';
    return 'parete DESTRA guardando la finestra';
  };
  openings.forEach((a) => { a.rel = relWall(a.wall); });
  placed.forEach((a) => { a.rel = relWall(a.wall); });

  const lockLines = [
    'PIANTA VINCOLANTE DAL MODELLO 3D. Vietato ruotare, specchiare, spostare aperture o arredi. Si possono cambiare solo materiali e finiture.',
    `Stanza ${toHuman(size[0])} (X) × ${toHuman(size[2])} (Z) × h ${toHuman(size[1])}. Origine: angolo Xmin/Zmin a pavimento.`,
    win
      ? `FINESTRA: ${win.name} ${toHuman(win.width)} × h ${toHuman(win.height)}, davanzale ${toHuman(win.sill)}, a X=${toHuman(win.fromX)} sulla ${relWall(win.wall)}. Unica. Non spostarla.`
      : 'Nessuna finestra nel modello: non inventarne.',
    ...openings.filter((a) => a.type === 'porta').map((a) => `PORTA ${a.inferred ? '(stessa parete della doccia/ingresso, ricavata dal vuoto)' : a.name}: ${toHuman(a.width)} × h ${toHuman(a.height)} a X=${toHuman(a.fromX)} Z=${toHuman(a.fromZ)} sulla ${a.rel}. STESSA PARETE della doccia, non sul lato. Fissa.`),
    'ELEMENTI FISSI (coordinate dall\'angolo origine, non rimescolare):',
    ...placed.slice(0, 20).map((a) => `- ${a.name} [${a.role}] ${a.rel || a.wall} | X ${toHuman(a.fromX)} Z ${toHuman(a.fromZ)} | ${toHuman(a.sizeX)}×${toHuman(a.sizeZ)} h ${toHuman(a.sizeY)}`),
    win
      ? 'CAMERA: dalla parete opposta si guarda la finestra IN FONDO. Sinistra/destra come da elenco.'
      : 'CAMERA: stessa pianta, stesse pareti lunghe e corte del modello.'
  ];
  const layoutLock = lockLines.filter(Boolean).join('\n');

  const bathNote = roomGuess.best === 'bagno'
    ? 'Rilevato BAGNO (doccia, lavabo, bidet, cassetta WC). Vietato interpretarlo come camera da letto.'
    : '';
  const mapNote = missingMaps.length
    ? ` Texture catalogo citate nel MTL ma assenti nello ZIP: ${missingMaps.slice(0, 6).join(', ')}. Esporta da SketchUp anche la cartella delle immagini, o mettile nello ZIP.`
    : '';

  return {
    format: 'obj',
    vertices: vertCount,
    faces,
    mtllib,
    unitsGuess,
    bbox: {
      width: Number(size[0].toFixed(3)),
      depth: Number(size[2].toFixed(3)),
      height: Number(size[1].toFixed(3))
    },
    proportions: 'ingombro ' + size[0].toFixed(2) + ' x ' + size[2].toFixed(2) + ' x h ' + size[1].toFixed(2) + ' (' + unitsGuess + ')',
    suggestedRoom: roomGuess.best,
    roomConfidence: roomGuess.confidence,
    roomScores: roomGuess.scores,
    fixtures,
    objects: objList,
    openings,
    placed: placed.slice(0, 12),
    layoutLock,
    materials: [...matsUsed].slice(0, 40),
    catalogTiles: tiles.slice(0, 6),
    mtlColors: Object.values(mtl).filter((m) => m.hex).slice(0, 12).map((m) => m.name + ' ' + m.hex),
    missingMaps,
    floorGuess,
    wallGuess,
    note: [bathNote, mapNote, layoutLock ? 'Aperture, sanitari e arredi bloccati sul modello.' : ''].filter(Boolean).join(' ')
  };
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(payload));
  return Buffer.concat([len, payload, c]);
}

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgb(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf[0] !== 0x89) return null;
  let w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!w || !h || depth !== 8 || (ctype !== 2 && ctype !== 6) || w > 4096 || h > 4096) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const bpp = ctype === 6 ? 4 : 3;
  const stride = w * bpp;
  const rgb = Buffer.alloc(w * h * 3);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    if (src + 1 + stride > raw.length) return null;
    const filter = raw[src++];
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = x;
      if (filter === 1) v = (x + a) & 255;
      else if (filter === 2) v = (x + b) & 255;
      else if (filter === 3) v = (x + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (x + paeth(a, b, c)) & 255;
      row[i] = v;
    }
    src += stride;
    prev = row;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      rgb[o] = row[x * bpp];
      rgb[o + 1] = row[x * bpp + 1];
      rgb[o + 2] = row[x * bpp + 2];
    }
  }
  return { w, h, rgb };
}

function upscalePng(buf, maxSide = 1536) {
  const dec = decodePngRgb(buf);
  if (!dec) return buf;
  const { w, h, rgb } = dec;
  const long = Math.max(w, h);
  if (long >= maxSide) return buf;
  const scale = maxSide / long;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(nw * nh * 3);
  const sample = (xf, yf, c) => {
    const x0 = Math.min(w - 1, Math.max(0, Math.floor(xf)));
    const y0 = Math.min(h - 1, Math.max(0, Math.floor(yf)));
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = xf - x0, ty = yf - y0;
    const p = (x, y) => rgb[(y * w + x) * 3 + c];
    return (p(x0, y0) * (1 - tx) * (1 - ty) + p(x1, y0) * tx * (1 - ty) + p(x0, y1) * (1 - tx) * ty + p(x1, y1) * tx * ty);
  };
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const xf = (x + 0.5) / scale - 0.5;
      const yf = (y + 0.5) / scale - 0.5;
      const o = (y * nw + x) * 3;
      out[o] = Math.max(0, Math.min(255, Math.round(sample(xf, yf, 0))));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(sample(xf, yf, 1))));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(sample(xf, yf, 2))));
    }
  }
  // mild sharpen so edges (sanitari, vetro) stay readable
  const sharp = Buffer.from(out);
  const k = [-0.08, -0.08, -0.08, -0.08, 1.64, -0.08, -0.08, -0.08, -0.08];
  for (let y = 1; y < nh - 1; y++) {
    for (let x = 1; x < nw - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0, ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            acc += out[((y + dy) * nw + (x + dx)) * 3 + c] * k[ki++];
          }
        }
        sharp[(y * nw + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(acc)));
      }
    }
  }
  return encodePng(nw, nh, sharp);
}

function colorForPart(name, role, type) {
  const n = normName(name + ' ' + (type || '') + ' ' + (role || ''));
  if (/(finestra|window)/.test(n)) return [0, 170, 210];
  if (/(porta|door)/.test(n)) return [140, 90, 50];
  if (/(doccia|shower)/.test(n)) return [40, 90, 190];
  if (/(lavabo|sink|catino)/.test(n)) return [230, 200, 150];
  if (/(bidet)/.test(n)) return [210, 210, 230];
  if (/(wc|cassetta|sospesi|toilet|vaso)/.test(n)) return [250, 250, 250];
  if (/(scrivania|desk)/.test(n)) return [150, 110, 70];
  return [170, 170, 175];
}

const GLYPH = {
  A: '0110010010111111000110001', B: '1111010001111101000111110',
  C: '0111010000100001000001110', D: '1110010001100011000111100',
  E: '1111110000111101000011111', F: '1111110000111101000010000',
  G: '0111010000101111000101110', H: '1000110001111111000110001',
  I: '1111100100001000010011111', L: '1000010000100001000011111',
  M: '1000111011101011000110001', N: '1000111001101011001110001',
  O: '0111010001100011000101110', P: '1111010001111101000010000',
  R: '1111010001111101000110001', S: '0111110000011100000111110',
  T: '1111100100001000010000100', V: '1000110001010100101000100',
  W: '1000110001101011101110001', Z: '1111100010001000100011111',
  ' ': '0000000000000000000000000'
};
function glyphRow(ch, row) {
  const bits = GLYPH[ch] || GLYPH[' '];
  return bits.slice(row * 5, row * 5 + 5);
}

function surveyPng(mesh) {
  const W = 1000;
  const H = 1400;
  const rgb = Buffer.alloc(W * H * 3, 232);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
  };
  const fill = (x0, y0, x1, y1, r, g, b) => {
    const xa = Math.max(0, Math.min(W, Math.round(Math.min(x0, x1))));
    const xb = Math.max(0, Math.min(W, Math.round(Math.max(x0, x1))));
    const ya = Math.max(0, Math.min(H, Math.round(Math.min(y0, y1))));
    const yb = Math.max(0, Math.min(H, Math.round(Math.max(y0, y1))));
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) set(x, y, r, g, b);
  };
  const stroke = (x0, y0, x1, y1, t, r, g, b) => {
    fill(x0, y0, x1, y0 + t, r, g, b);
    fill(x0, y1 - t, x1, y1, r, g, b);
    fill(x0, y0, x0 + t, y1, r, g, b);
    fill(x1 - t, y0, x1, y1, r, g, b);
  };
  const text = (x, y, str, s, r, g, b) => {
    const up = String(str || '').toUpperCase().replace(/[^A-Z ]/g, ' ');
    let cx = x;
    for (const ch of up) {
      for (let row = 0; row < 7; row++) {
        const bits = glyphRow(ch, row);
        for (let col = 0; col < 5; col++) {
          if (bits[col] === '1') fill(cx + col * s, y + row * s, cx + col * s + s, y + row * s + s, r, g, b);
        }
      }
      cx += 6 * s;
    }
  };
  const labelOf = (a) => {
    const n = normName(a.name + ' ' + (a.type || '') + ' ' + (a.role || ''));
    if (/(finestra|window)/.test(n)) return 'FINESTRA';
    if (/(porta|door)/.test(n)) return 'PORTA';
    if (/(doccia|shower)/.test(n)) return 'DOCCIA';
    if (/(lavabo|sink)/.test(n)) return 'LAVABO';
    if (/bidet/.test(n)) return 'BIDET';
    if (/(wc|cassetta|sospesi|toilet)/.test(n)) return 'WC';
    return '';
  };

  const bw = mesh.bbox?.width || 300;
  const bd = mesh.bbox?.depth || 300;
  const left = 90;
  const top = 70;
  const planW = 820;
  const planH = 620;
  const scale = Math.min(planW / Math.max(bw, 1), planH / Math.max(bd, 1));
  const ox = left + (planW - bw * scale) / 2;
  const oy = top + (planH - bd * scale) / 2;
  const X = (cm) => ox + cm * scale;
  const Z = (cm) => oy + cm * scale;

  text(90, 20, 'PIANTA  ALTO E FINESTRA   BASSO E INGRESSO', 3, 40, 40, 45);
  fill(X(0), Z(0), X(bw), Z(bd), 250, 248, 242);
  stroke(X(0), Z(0), X(bw), Z(bd), 7, 30, 30, 35);
  text(X(8), Z(0) - 28, 'PARETE FINESTRA', 2, 0, 110, 150);
  text(X(8), Z(bd) + 10, 'PARETE INGRESSO', 2, 120, 50, 30);

  const mergeByLabel = (list) => {
    const map = new Map();
    for (const a of list) {
      const lab = labelOf(a);
      if (!lab) continue;
      const x0 = a.fromX || 0;
      const z0 = a.fromZ || 0;
      const x1 = x0 + Math.max(a.sizeX || a.width || 10, 8);
      const z1 = z0 + Math.max(a.sizeZ || a.thick || 10, 8);
      const cur = map.get(lab);
      if (!cur) map.set(lab, { ...a, label: lab, fromX: x0, fromZ: z0, sizeX: x1 - x0, sizeZ: z1 - z0 });
      else {
        const nx0 = Math.min(cur.fromX, x0);
        const nz0 = Math.min(cur.fromZ, z0);
        const nx1 = Math.max(cur.fromX + cur.sizeX, x1);
        const nz1 = Math.max(cur.fromZ + cur.sizeZ, z1);
        cur.fromX = nx0; cur.fromZ = nz0; cur.sizeX = nx1 - nx0; cur.sizeZ = nz1 - nz0;
      }
    }
    return [...map.values()];
  };
  const items = mergeByLabel([...(mesh.openings || []), ...(mesh.placed || [])]);
  for (const a of items) {
    const c = colorForPart(a.name, a.role, a.type || a.label);
    const x0 = X(a.fromX);
    const z0 = Z(a.fromZ);
    const x1 = X(a.fromX + a.sizeX);
    const z1 = Z(a.fromZ + a.sizeZ);
    fill(x0, z0, x1, z1, c[0], c[1], c[2]);
    stroke(x0, z0, x1, z1, 2, 20, 20, 25);
    text(x0 + 4, z0 + 4, a.label, 2, 20, 20, 25);
  }

  const camX = X(bw / 2);
  fill(camX - 16, Z(bd) + 36, camX + 16, Z(bd) + 50, 200, 40, 30);
  fill(camX - 6, Z(bd) - 36, camX + 6, Z(bd), 200, 40, 30);
  text(camX - 50, Z(bd) + 54, 'CAMERA', 2, 180, 30, 20);

  const vx0 = 80, vy0 = 800, vx1 = 920, vy1 = 1320;
  fill(vx0, vy0, vx1, vy1, 250, 248, 242);
  stroke(vx0, vy0, vx1, vy1, 6, 30, 30, 35);
  text(80, 770, 'FOTO DALLA CAMERA  VICINO IN BASSO  FINESTRA IN ALTO', 2, 40, 40, 45);
  fill(300, vy0 + 30, 700, vy0 + 210, 235, 233, 226);
  stroke(300, vy0 + 30, 700, vy0 + 210, 3, 40, 40, 45);
  const sorted = items.slice().sort((a, b) => a.fromZ - b.fromZ);
  for (const a of sorted) {
    const t = Math.min(1, Math.max(0, (a.fromZ + a.sizeZ / 2) / Math.max(bd, 1)));
    const mag = 0.42 + 0.7 * t;
    const cx = vx0 + 70 + ((a.fromX + a.sizeX / 2) / Math.max(bw, 1)) * (vx1 - vx0 - 140);
    const cy = vy0 + 50 + t * (vy1 - vy0 - 120);
    const w = Math.max(70, Math.min(220, a.sizeX * scale * mag * 1.6));
    const h = Math.max(50, Math.min(240, Math.max(a.sizeZ, 40) * scale * mag * 1.3));
    const c = colorForPart(a.name, a.role, a.type || a.label);
    fill(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, c[0], c[1], c[2]);
    stroke(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, 3, 20, 20, 25);
    text(cx - w / 2 + 6, cy - 8, a.label, 2, a.label === 'DOCCIA' || a.label === 'PORTA' ? 255 : 20, a.label === 'DOCCIA' || a.label === 'PORTA' ? 255 : 20, a.label === 'DOCCIA' || a.label === 'PORTA' ? 255 : 25);
  }

  return encodePng(W, H, rgb);
}

function surveyView3d(mesh) {
  const W = 1280;
  const H = 720;
  const rgb = Buffer.alloc(W * H * 3, 210);
  const zbuf = new Float32Array(W * H);
  zbuf.fill(1e9);
  const set = (x, y, z, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (z >= zbuf[i]) return;
    zbuf[i] = z;
    const p = i * 3;
    rgb[p] = r; rgb[p + 1] = g; rgb[p + 2] = b;
  };
  const fillTri = (a, b, c, r, g, bl) => {
    const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxx = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxy = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1) return;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const w0 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        const w1 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
        const w2 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
        if (area > 0 ? (w0 >= 0 && w1 >= 0 && w2 >= 0) : (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
          const u = w1 / area;
          const v = w2 / area;
          const ww = 1 - u - v;
          const z = ww * a[2] + u * b[2] + v * c[2];
          set(x, y, z, r, g, bl);
        }
      }
    }
  };
  const quad = (p, col) => {
    fillTri(p[0], p[1], p[2], col[0], col[1], col[2]);
    fillTri(p[0], p[2], p[3], col[0], col[1], col[2]);
  };

  const bw = mesh.bbox?.width || 300;
  const bd = mesh.bbox?.depth || 300;
  const bh = mesh.bbox?.height || 270;
  const cam = [bw * 0.58, bh * 1.2, bd * 1.45];
  const tgt = [bw * 0.4, 50, bd * 0.18];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const nrm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fwd = nrm(sub(tgt, cam));
  const rgt = nrm(crs(fwd, [0, 1, 0]));
  const upv = crs(rgt, fwd);
  const f = 860;
  const project = (x, y, z) => {
    const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
    const cx = dx * rgt[0] + dy * rgt[1] + dz * rgt[2];
    const cy = dx * upv[0] + dy * upv[1] + dz * upv[2];
    const cz = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
    const d = Math.max(30, cz);
    return [W * 0.5 + f * cx / d, H * 0.48 - f * cy / d, d];
  };
  const box = (x0, y0, z0, x1, y1, z1, col) => {
    const P = (x, y, z) => project(x, y, z);
    quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], col);
    quad([P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)], [col[0] * 0.75, col[1] * 0.75, col[2] * 0.75].map(Math.round));
    quad([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], [col[0] * 0.85, col[1] * 0.85, col[2] * 0.85].map(Math.round));
    quad([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6].map(Math.round));
    quad([P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0)], [Math.min(255, col[0] + 25), Math.min(255, col[1] + 25), Math.min(255, col[2] + 25)]);
  };

  for (let i = 0; i < rgb.length; i += 3) { rgb[i] = 186; rgb[i + 1] = 210; rgb[i + 2] = 230; }

  box(0, 0, 0, bw, 2, bd, [110, 110, 116]);
  box(0, 0, 0, 3, bh * 0.92, bd, [228, 224, 216]);
  box(bw - 3, 0, 0, bw, bh * 0.92, bd, [218, 214, 206]);
  box(0, 0, 0, bw, bh * 0.92, 3, [232, 228, 220]);

  const lab = (a) => {
    const n = normName(a.name + ' ' + (a.type || '') + ' ' + (a.role || ''));
    if (/(finestra|window)/.test(n)) return 'FINESTRA';
    if (/(porta|door)/.test(n)) return 'PORTA';
    if (/(doccia|shower)/.test(n)) return 'DOCCIA';
    if (/(lavabo|sink)/.test(n)) return 'LAVABO';
    if (/bidet/.test(n)) return 'BIDET';
    if (/(wc|cassetta|sospesi|toilet)/.test(n)) return 'WC';
    return '';
  };
  const items = [...(mesh.openings || []), ...(mesh.placed || [])];
  const by = {};
  for (const a of items) {
    const k = lab(a);
    if (!k) continue;
    if (!by[k]) by[k] = { ...a, label: k };
    else {
      const x0 = Math.min(by[k].fromX, a.fromX);
      const z0 = Math.min(by[k].fromZ, a.fromZ || 0);
      const x1 = Math.max(by[k].fromX + (by[k].sizeX || 10), a.fromX + (a.sizeX || a.width || 10));
      const z1 = Math.max(by[k].fromZ + (by[k].sizeZ || 10), (a.fromZ || 0) + (a.sizeZ || 10));
      by[k].fromX = x0; by[k].fromZ = z0; by[k].sizeX = x1 - x0; by[k].sizeZ = z1 - z0;
    }
  }
  const col = {
    FINESTRA: [0, 170, 210],
    PORTA: [140, 90, 50],
    DOCCIA: [40, 90, 190],
    LAVABO: [230, 200, 150],
    WC: [250, 250, 250],
    BIDET: [210, 210, 230]
  };
  if (by.FINESTRA) {
    const w = by.FINESTRA;
    box(w.fromX, w.sill || 100, 0, w.fromX + (w.width || w.sizeX), (w.sill || 100) + (w.height || 140), 6, col.FINESTRA);
  }
  if (by.DOCCIA) {
    const d = by.DOCCIA;
    box(d.fromX, 0, d.fromZ, d.fromX + d.sizeX, Math.max(200, d.sizeY || 120), d.fromZ + Math.max(d.sizeZ, 40), col.DOCCIA);
  }
  if (by.LAVABO) {
    const l = by.LAVABO;
    box(l.fromX, 80, l.fromZ, l.fromX + Math.max(l.sizeX, 40), 100, l.fromZ + Math.max(l.sizeZ, 45), col.LAVABO);
  }
  if (by.WC) {
    const w = by.WC;
    box(w.fromX, 0, w.fromZ, w.fromX + Math.max(w.sizeX, 35), 42, w.fromZ + Math.max(w.sizeZ, 50), col.WC);
  }
  if (by.BIDET) {
    const w = by.BIDET;
    box(w.fromX, 0, w.fromZ, w.fromX + Math.max(w.sizeX, 30), 40, w.fromZ + Math.max(w.sizeZ, 45), col.BIDET);
  }
  if (by.PORTA) {
    const p = by.PORTA;
    box(p.fromX, 0, Math.max(p.fromZ, bd - 14), p.fromX + Math.max(p.sizeX, p.width || 80), 210, bd, col.PORTA);
  }
  return encodePng(W, H, rgb);
}

function parseMtl(text) {
  const mats = {};
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('newmtl ')) {
      cur = line.slice(7).trim();
      mats[cur] = { name: cur };
    } else if (cur && /^Kd\s/.test(line)) {
      const p = line.split(/\s+/);
      const r = Number(p[1]), g = Number(p[2]), b = Number(p[3]);
      if ([r, g, b].every(Number.isFinite)) {
        const hex = '#' + [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
        mats[cur].kd = [r, g, b];
        mats[cur].hex = hex;
      }
    } else if (cur && /^map_Kd\s/.test(line)) {
      mats[cur].map = line.replace(/^map_Kd\s+/, '').trim();
    }
  }
  return mats;
}

async function unzipEntries(buf) {
  const files = {};
  if (!Buffer.isBuffer(buf) || buf.length < 22) return files;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return unzipLocalScan(buf);
  const n = buf.readUInt16LE(eocd + 10);
  let i = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n && i + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) break;
    const method = buf.readUInt16LE(i + 10);
    const compSize = buf.readUInt32LE(i + 20);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commLen = buf.readUInt16LE(i + 32);
    const localOff = buf.readUInt32LE(i + 42);
    const name = buf.slice(i + 46, i + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    i += 46 + nameLen + extraLen + commLen;
    if (!name || name.endsWith('/')) continue;
    const base = name.split('/').pop() || name;
    if (name.includes('__MACOSX') || base.startsWith('._')) continue;
    try {
      files[name] = await readZipFile(buf, localOff, method, compSize);
    } catch (err) {
      console.error('unzip skip', name, err.message);
    }
  }
  return files;
}

async function readZipFile(buf, localOff, method, compSize) {
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + nameLen + extraLen;
  const data = buf.slice(dataStart, dataStart + compSize);
  if (method === 0) return data;
  if (method === 8) return inflateRaw(data);
  throw new Error('metodo zip ' + method);
}

async function unzipLocalScan(buf) {
  const files = {};
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const flags = buf.readUInt16LE(i + 6);
    let compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8').replace(/\\/g, '/');
    const dataStart = i + 30 + nameLen + extraLen;
    if (flags & 8) {
      // data descriptor: skip this scan, central dir should have handled it
      break;
    }
    const data = buf.slice(dataStart, dataStart + compSize);
    let out = data;
    if (method === 8) out = await inflateRaw(data);
    else if (method !== 0) { i = dataStart + compSize; continue; }
    if (name && !name.endsWith('/') && !name.includes('__MACOSX')) files[name] = out;
    i = dataStart + compSize;
  }
  return files;
}

function looksLikeObj(text) {
  return /(^|\n)\s*(v |f |o |g |mtllib |usemtl )/m.test(String(text).slice(0, 8000));
}

function extractPngsFromBuffer(buf) {
  const out = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let i = 0;
  while (i < buf.length - 24) {
    const at = buf.indexOf(sig, i);
    if (at < 0) break;
    let p = at + 8;
    let ok = false;
    while (p + 12 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString('ascii', p + 4, p + 8);
      if (!Number.isFinite(len) || len < 0 || len > 40e6) break;
      p += 12 + len;
      if (type === 'IEND') { ok = true; break; }
    }
    if (ok && p - at > 400) out.push({ start: at, buf: buf.slice(at, p) });
    i = at + 8;
  }
  return out;
}

function skpStringNames(buf) {
  const found = new Set();
  const add = (s) => {
    const t = String(s || '').replace(/\0/g, '').trim();
    if (t.length < 3 || t.length > 80) return;
    if (!/[A-Za-z]/.test(t)) return;
    if (/^https?:/i.test(t)) return;
    found.add(t);
  };
  let ascii = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 32 && c < 127) ascii += String.fromCharCode(c);
    else {
      if (ascii.length >= 4) add(ascii);
      ascii = '';
    }
  }
  if (ascii.length >= 4) add(ascii);
  for (let i = 0; i + 7 < buf.length; i++) {
    if (buf[i] === 0 || buf[i + 1] !== 0) continue;
    let s = '';
    let j = i;
    while (j + 1 < buf.length && buf[j + 1] === 0 && buf[j] >= 32 && buf[j] < 127) {
      s += String.fromCharCode(buf[j]);
      j += 2;
    }
    if (s.length >= 4) add(s);
    i = j;
  }
  return [...found];
}

async function parseSkpBuffer(buf, doorHint) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) return null;
  const pngs = extractPngsFromBuffer(buf);
  let entries = {};
  const pk = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (pk >= 0) {
    try { entries = await unzipEntries(buf.slice(pk)); } catch (err) { console.error('skp zip', err.message); }
  }
  let preview = null;
  const textures = [];
  for (const [name, data] of Object.entries(entries)) {
    const low = name.replace(/\\/g, '/').toLowerCase();
    if (low.includes('model_thumbnail') && data.length > 800) preview = data;
    if (/\.(jpe?g|png|webp)$/.test(low) && data.length > 1200 && !/thumbnail|preview/i.test(low)) {
      textures.push({ name, buf: data });
    }
  }
  if (!preview) {
    const mid = pngs.filter((p) => p.buf.length >= 2500 && p.buf.length <= 900000).sort((a, b) => b.buf.length - a.buf.length);
    preview = (mid[0] || pngs.sort((a, b) => b.buf.length - a.buf.length)[0])?.buf || null;
  }
  const keepName = (n) => {
    const t = normName(n);
    if (classifyPart(n) !== 'object') return true;
    if (scoreText(n).confidence > 0) return true;
    return /(seduta|panca|seat|vetro|glass|box|flessa|tramezzo|divisori|muretto|rubinet|miscelat|piatto|nicchia|mensola|specchio|mobile|lavabo|doccia|bidet|\bwc\b|porta|finestra)/.test(t);
  };
  const names = skpStringNames(buf).filter(keepName).slice(0, 100);
  const blob = names.join('\n') + ' ' + (doorHint || '');
  const scored = scoreText(blob);
  const objects = names.slice(0, 50).map((name) => ({ name, role: classifyPart(name), faces: 0, materials: [] }));
  const fixtures = [...new Set(objects.map((o) => o.name))].slice(0, 30);
  const hasSeat = names.some((n) => /seduta|panca|seat|bench/i.test(n));
  const hasGlass = names.some((n) => /vetro|glass|cristallo|box/i.test(n));
  const layoutLock = [
    'COMPONENTI SKETCHUP — usa questi oggetti, non sostituirli con catalogo generico:',
    ...objects.slice(0, 25).map((o) => `- ${o.name} [${o.role}]`),
    hasSeat ? 'In doccia c’è una SEDUTA/PANCA: tenerla. Non toglierla.' : '',
    hasGlass ? 'Il VETRO doccia è quello del modello: non inventare un box a telaio nero in mezzo alla stanza.' : 'Non aggiungere un box doccia in vetro se non è nel modello.',
    'Tieni il muro di divisione doccia/lavabi. Stessa inquadratura assonometrica del file.'
  ].filter(Boolean).join('\n');
  return {
    format: 'skp',
    suggestedRoom: scored.best || 'altro',
    roomConfidence: scored.confidence,
    roomScores: scored.scores,
    objects,
    fixtures,
    materials: textures.map((t) => t.name).slice(0, 20),
    layoutLock,
    note: 'File SketchUp (.skp): vista + componenti nativi. Il render deve usare questi oggetti (seduta, vetro, sanitari), non un bagno da catalogo.',
    preview,
    textures: textures.slice(0, 8),
    pngCount: pngs.length,
    hasSeat,
    hasGlass
  };
}

function parseStlSummary(buf) {
  const ascii = buf.toString('utf8', 0, Math.min(buf.length, 80));
  if (ascii.startsWith('solid') && !ascii.includes('\0')) {
    const text = buf.toString('utf8');
    const n = (text.match(/facet normal/g) || []).length;
    return { format: 'stl-ascii', faces: n };
  }
  if (buf.length < 84) return { format: 'stl', note: 'file troppo corto' };
  const faces = buf.readUInt32LE(80);
  return { format: 'stl-binary', faces };
}

function imageModel() {
  return process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
}

async function saveGeneratedImage(result, prefix) {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const imageName = `${prefix}-${Date.now()}.png`;
  const dest = path.join(UPLOADS_DIR, imageName);

  let buffer;
  if (result.b64_json) {
    buffer = Buffer.from(result.b64_json, 'base64');
  } else if (result.url) {
    const imageResponse = await fetch(result.url);
    if (!imageResponse.ok) {
      throw new Error(`Download immagine fallito (${imageResponse.status})`);
    }
    buffer = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    throw new Error('Nessuna immagine restituita dal modello');
  }
  await fs.writeFile(dest, buffer);
  let gridFileId = null;
  try {
    gridFileId = await putInGrid(imageName, buffer);
  } catch (err) {
    console.error('GridFS save failed', err.message);
  }
  return {
    imageName,
    imageUrl: `/api/renders/media/${imageName}`,
    gridFileId
  };
}

async function generateInteriorImage(prompt, refPaths = []) {
  const openai = getOpenAI();
  const model = imageModel();
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'high';
  let response;

  if (refPaths.length && model.startsWith('gpt-image')) {
    const images = [];
    for (const p of refPaths) {
      const buf = await fs.readFile(p);
      const extn = path.extname(p).toLowerCase();
      const type = extn === '.jpg' || extn === '.jpeg' ? 'image/jpeg' : extn === '.webp' ? 'image/webp' : 'image/png';
      images.push(await toFile(buf, path.basename(p), { type }));
    }
    response = await openai.images.edit({
      model,
      image: images.length === 1 ? images[0] : images,
      prompt,
      size: process.env.OPENAI_IMAGE_SIZE || '1536x1024',
      quality
    });
  } else {
    const params = { model, prompt, n: 1, size: process.env.OPENAI_IMAGE_SIZE || '1536x1024' };
    if (model.startsWith('gpt-image')) params.quality = quality;
    response = await openai.images.generate(params);
  }

  const item = response.data?.[0];
  if (!item) throw new Error('Il modello immagini non ha restituito un risultato');
  return item;
}

const textureUpload = upload.fields([
  { name: 'floorTexture', maxCount: 1 },
  { name: 'wallTexture', maxCount: 1 },
  { name: 'planImage', maxCount: 1 },
  { name: 'model', maxCount: 1 },
  { name: 'mtl', maxCount: 1 }
]);

function optionalMultipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) return next();
  return textureUpload(req, res, next);
}

const VIEW_PROMPTS = {
  frontale: 'eye-level camera facing the main wall, wide architectural photo',
  angolo: 'camera from the opposite corner, 3/4 view showing two walls and the floor',
  dettaglio: 'closer shot of floor, wall cladding and material junctions',
  laterale: 'side viewpoint along the room showing depth and furniture'
};

router.get('/', async (req, res, next) => {
  try {
    const renders = await Render.find({ adminId: req.adminId })
      .populate('clientId', 'name')
      .sort({ createdAt: -1 })
      .limit(120);
    res.json({ success: true, data: renders });
  } catch (error) {
    next(error);
  }
});

router.get('/file/:id', async (req, res, next) => {
  try {
    const render = await Render.findOne({ _id: req.params.id, adminId: req.adminId });
    if (!render || !render.imageFile) {
      return res.status(404).json({ success: false, error: 'File non trovato' });
    }
    const safeName = `${(render.title || 'render').replace(/[^\w\-]+/g, '_')}-HQ.png`;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    const filePath = path.join(UPLOADS_DIR, render.imageFile);
    try {
      await fs.access(filePath);
      return res.sendFile(filePath);
    } catch {}
    const buf = await readGridByName(render.imageFile);
    if (!buf) return res.status(404).json({ success: false, error: 'File non trovato in archivio' });
    res.send(buf);
  } catch (error) {
    next(error);
  }
});

router.get('/client/:clientId', async (req, res, next) => {
  try {
    const client = await Client.findOne({ _id: req.params.clientId, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    const renders = await Render.find({ clientId: req.params.clientId }).sort({ createdAt: -1 });
    res.json({ success: true, data: renders });
  } catch (error) {
    next(error);
  }
});

router.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    const { clientId, title, description } = req.body;
    if (!req.file) return res.status(400).json({ success: false, error: 'File non caricato' });
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId obbligatorio' });

    const client = await Client.findOne({ _id: clientId, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });

    const render = await Render.create({
      clientId,
      adminId: req.adminId,
      title: title || 'Render',
      description: description || '',
      imageUrl: `/uploads/${req.file.filename}`,
      imageFile: req.file.filename,
      renderType: 'image'
    });

    res.status(201).json({ success: true, data: render });
  } catch (error) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
});

router.post('/analyze-image', analyzeUpload, async (req, res, next) => {
  try {
    const pastedNames = String(req.body?.objectList || '').trim();
    const imageFile = req.files?.image?.[0] || (req.file?.mimetype?.startsWith('image/') ? req.file : null);
    let modelFile = req.files?.model?.[0] || (!imageFile ? req.file : null);
    const mtlUpload = req.files?.mtl?.[0];
    if (!imageFile && !modelFile && !pastedNames) {
      return res.status(400).json({ success: false, error: 'Carica uno SketchUp .skp, una foto, un OBJ (o ZIP), oppure incolla i nomi dei componenti' });
    }

    const ext = modelFile ? path.extname(modelFile.originalname || '').toLowerCase() : '';

    let mesh = null;
    let mtlText = mtlUpload ? await fs.readFile(mtlUpload.path, 'utf8') : '';
    let skpSourceName = null;

    let zipMaps = [];
    const ingestSkp = async (buf) => {
      const skp = await parseSkpBuffer(buf, req.body?.doorHint || req.body?.modelBrief);
      if (!skp) return;
      mesh = skp;
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      if (skp.preview && skp.preview.length > 800) {
        let view = skp.preview;
        try { view = upscalePng(skp.preview, 1536); } catch (err) { console.error('skp upscale', err.message); }
        skpSourceName = `skp-view-${Date.now()}.png`;
        await fs.writeFile(path.join(UPLOADS_DIR, skpSourceName), view);
      }
      for (const t of skp.textures || []) {
        const base = path.basename(t.name).replace(/[^\w.\-]+/g, '_') || 'tex.png';
        const filename = `tex-${Date.now()}-${base}`;
        await fs.writeFile(path.join(UPLOADS_DIR, filename), t.buf);
        zipMaps.push({ original: t.name, basename: base, filename, bytes: t.buf.length });
      }
    };
    if (modelFile && ext === '.zip') {
      const entries = await unzipEntries(await fs.readFile(modelFile.path));
      const names = Object.keys(entries);
      const objName = names.find((n) => {
        const low = n.toLowerCase();
        const base = low.split('/').pop();
        return low.endsWith('.obj') && !low.includes('__macosx') && !base.startsWith('._');
      });
      const mtlName = names.find((n) => {
        const low = n.toLowerCase();
        const base = low.split('/').pop();
        return low.endsWith('.mtl') && !low.includes('__macosx') && !base.startsWith('._');
      });
      if (!objName) {
        const skpName = names.find((n) => {
          const low = n.toLowerCase();
          const base = low.split('/').pop();
          return low.endsWith('.skp') && !low.includes('__macosx') && !base.startsWith('._');
        });
        if (skpName) {
          await ingestSkp(entries[skpName]);
        } else {
        const seen = names.map((n) => n.split('/').pop()).filter(Boolean).slice(0, 12).join(', ') || 'vuoto';
        return res.status(400).json({
          success: false,
          error: `Nello ZIP non c’è un file .obj o .skp (trovato: ${seen}). Zippa SKP, oppure OBJ+MTL+cartella jpg.`
        });
        }
      } else {
        if (mtlName) mtlText = entries[mtlName].toString('utf8');
        mesh = parseObjSummary(entries[objName].toString('utf8'), mtlText, req.body?.doorHint || req.body?.modelBrief);
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        for (const [name, buf] of Object.entries(entries)) {
          const low = name.replace(/\\/g, '/').toLowerCase();
          if (low.includes('__macosx')) continue;
          if (!/\.(jpe?g|png|webp)$/.test(low)) continue;
          if (!buf || buf.length < 800) continue;
          const base = path.basename(name).replace(/[^\w.\-]+/g, '_');
          const filename = `tex-${Date.now()}-${base}`;
          await fs.writeFile(path.join(UPLOADS_DIR, filename), buf);
          zipMaps.push({ original: name, basename: path.basename(name), filename, bytes: buf.length });
        }
      }
    } else if (modelFile && ext === '.skp') {
      await ingestSkp(await fs.readFile(modelFile.path));
    } else if (modelFile && (ext === '.obj' || ext === '.txt' || ext === '')) {
      const text = await fs.readFile(modelFile.path, 'utf8');
      if (looksLikeObj(text) || ext === '.obj') mesh = parseObjSummary(text, mtlText, req.body?.doorHint || req.body?.modelBrief);
      else {
        return res.status(400).json({ success: false, error: 'Il file non sembra un OBJ. Esporta da SketchUp in OBJ o metti OBJ+MTL in uno ZIP.' });
      }
    } else if (modelFile && ext === '.stl') {
      mesh = parseStlSummary(await fs.readFile(modelFile.path));
    } else if (modelFile && (ext === '.gltf' || ext === '.glb' || ext === '.dae')) {
      mesh = { format: ext.slice(1), file: modelFile.originalname, bytes: modelFile.size };
    }

    if (pastedNames) {
      mesh = mesh || {
        format: 'names',
        objects: [],
        fixtures: [],
        materials: [],
        suggestedRoom: 'altro',
        roomConfidence: 0
      };
      const extra = scoreText(pastedNames);
      if (extra.confidence >= (mesh.roomConfidence || 0)) {
        mesh.suggestedRoom = extra.best;
        mesh.roomConfidence = extra.confidence;
        mesh.roomScores = extra.scores;
      }
      if (mesh.suggestedRoom === 'bagno') {
        mesh.note = 'Rilevato BAGNO. Vietato interpretarlo come camera da letto.';
      }
      const blobN = normName(pastedNames);
      mesh.fixtures = mesh.fixtures || [];
      for (const [label, kws] of FIXTURE_MAP) {
        if (kws.some((k) => blobN.includes(k)) && !mesh.fixtures.includes(label)) mesh.fixtures.push(label);
      }
      pastedNames.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 40).forEach((name) => {
        mesh.objects = mesh.objects || [];
        mesh.objects.push({ name, role: classifyPart(name), faces: 0, materials: [] });
      });
    }

    const modelBrief = String(req.body?.modelBrief || '').trim();
    let vision = '';
    let hqName = skpSourceName;
    if (imageFile) {
      let buf = await fs.readFile(imageFile.path);
      try { buf = upscalePng(buf, 1536); } catch (err) { console.error('png upscale', err.message); }
      hqName = `view-hq-${Date.now()}.png`;
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      await fs.writeFile(path.join(UPLOADS_DIR, hqName), buf);
    }
    const visionFile = hqName ? path.join(UPLOADS_DIR, hqName) : null;
    if (visionFile) {
      const imageBuffer = await fs.readFile(visionFile);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = imageFile?.mimetype || 'image/png';
      const openai = getOpenAI();
      const skpHint = mesh?.format === 'skp'
        ? `\nQuesta è la VISTA SketchUp del file .skp. Fai un INVENTARIO vincolante, oggetto per oggetto.
Per ogni elemento visibile: nome, posizione (parete ingresso / sinistra / destra / fondo / centro), quantità.
Distingui con cura:
- specchio tondo/ovale vs lavabo (uno specchio NON è un secondo lavandino)
- vetro doccia/vasca: c'è? copre tutta la vasca o solo metà? Se c'è, va TENUTO
- vasca: ci sono bocchette idromassaggio? se sì, tenerle
- termoarredo / calorifero
- WC, bidet, cassetta, porta o solo apertura nel muro
VIETATO elencare cose non visibili: niente portarotolo, flaconi, piante, speaker se non si vedono.
Conta i lavabi. Conta i sanitari. Questa lista sarà l'unica verità per il render.\n`
        : '';
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 2200,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
              {
                type: 'text',
                text: `Sei un architetto. Analizza QUESTO spazio come base vincolante per un render fotorealistico.
Non inventare una planimetria diversa.
${skpHint}
Elenca in italiano:
1. Tipo di ambiente e destinazione
2. INVENTARIO oggetti visibili (elenco puntato, posizione, quantità). Niente extra.
3. Geometria: pianta, aperture (porte/finestre/vani) e dove stanno — un vano non è una porta
4. Layout fisso: muri, divisori, nicchie
5. RIVESTIMENTI — una riga per superficie, non unificare:
   - Pavimento: materiale, colore, formato
   - Parete sinistra / destra / fondo / ingresso: piastrelle o pittura, colore
   Se una parete è piastrellata e un’altra è liscia, dillo. Non scrivere “pareti beige” per tutte.
6. Vetri, specchi, vasca/doccia, idromassaggio: sì/no e dove
7. Cosa è vincolo e cosa è modificabile (solo finiture)
8. Istruzioni per il render: stessa inquadratura, stessi oggetti, niente accessori inventati
${mesh ? `DATI MESH (vincolanti). Stanza rilevata: ${mesh.suggestedRoom}. ${mesh.note || ''}
PIANTA BLOCCATA:
${mesh.layoutLock || ''}
Oggetti: ${(mesh.objects||[]).slice(0,25).map(o=>o.name+'['+o.role+']').join(', ')}
Quote: ${mesh.proportions}
Aperture: ${JSON.stringify(mesh.openings||[])}
Se suggestedRoom è bagno: è un BAGNO, mai una camera da letto, niente letto/piumoni.
NON spostare porte/finestre. NON ruotare la stanza.
${JSON.stringify({ fixtures: mesh.fixtures, materials: mesh.materials, mtlColors: mesh.mtlColors })}` : ''}
${modelBrief ? `DIRETTIVE DELL'UTENTE SUL MODELLO (prioritarie): ${modelBrief}` : ''}`
              }
            ]
          }
        ]
      });
      vision = response.choices?.[0]?.message?.content || '';
    } else if (mesh) {
      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `Da questo modello 3D SketchUp ricostruisci una lettura architettonica VINCOLANTE.
Stanza rilevata dal parser: ${mesh.suggestedRoom} (${mesh.note || 'nessuna nota'}).
Se è bagno: descrivi sanitari, doccia/vasca, lavabo. VIETATO: letto, camera, piumoni.
L'OBJ è GEOMETRIA. I materiali scelti dall'utente (se presenti nelle direttive) vincono su colori placeholder del modello.
ORIENTAMENTO E APERTURE (non modificarli):
${mesh.layoutLock || 'non disponibile'}
Aperture: ${JSON.stringify(mesh.openings || [])}
Posizioni: ${JSON.stringify(mesh.placed || [])}
Mesh: ${JSON.stringify({ suggestedRoom: mesh.suggestedRoom, fixtures: mesh.fixtures, objects: (mesh.objects||[]).slice(0,30), proportions: mesh.proportions, materials: mesh.materials, mtlColors: mesh.mtlColors, floorGuess: mesh.floorGuess, wallGuess: mesh.wallGuess })}
${modelBrief ? `DIRETTIVE UTENTE (prioritarie, anche su pavimento/pareti/colori): ${modelBrief}` : ''}
Scrivi in italiano: tipo stanza, quale parete ha la finestra, quale ha la porta, cosa sta a sinistra/destra GUARDANDO la finestra. Vietato inventare un orientamento diverso.`
        }]
      });
      vision = response.choices?.[0]?.message?.content || '';
    }

    if (vision && mesh) {
      const floorHit = vision.match(/pavimento[:\s—-]+([^\n]{6,90})/i);
      const wallHit = vision.match(/parete[^:\n]{0,20}[:\s—-]+([^\n]{6,90})/i);
      if (!mesh.floorGuess && floorHit) mesh.floorGuess = floorHit[1].replace(/\.$/, '').trim();
      if (!mesh.wallGuess && wallHit) mesh.wallGuess = wallHit[1].replace(/\.$/, '').trim();
    }

    const analysis = [
      mesh?.layoutLock ? `PIANTA E APERTURE BLOCCATE\n${mesh.layoutLock}\n` : '',
      modelBrief ? `DIRETTIVE UTENTE SUL 3D\n${modelBrief}\n` : '',
      vision,
      mesh ? `\n\nDATI MODELLO 3D\n${JSON.stringify({
        format: mesh.format,
        suggestedRoom: mesh.suggestedRoom,
        fixtures: mesh.fixtures,
        objects: (mesh.objects || []).slice(0, 25),
        materials: mesh.materials,
        layoutLock: mesh.layoutLock,
        note: mesh.note,
        hasSeat: mesh.hasSeat,
        hasGlass: mesh.hasGlass
      }, null, 2)}` : ''
    ].join('').trim();

    let textureRefs = [];
    if (mesh && zipMaps.length) {
      const missing = mesh.missingMaps || [];
      const still = [];
      const found = [];
      for (const m of missing) {
        const b = path.basename(m).toLowerCase();
        const hit = zipMaps.find((s) => s.basename.toLowerCase() === b);
        if (hit) found.push({ ...hit, mtlMap: m });
        else still.push(m);
      }
      // also keep unmatched jpg as extra catalog refs
      for (const s of zipMaps) {
        if (!found.some((f) => f.filename === s.filename)) found.push(s);
      }
      mesh.missingMaps = still;
      if (!still.length && mesh.note) {
        mesh.note = String(mesh.note).replace(/Texture catalogo citate[\s\S]*?ZIP\./, '').trim();
      }
      const tiles = mesh.catalogTiles || [];
      const pickFor = (finish) => {
        const n = normName(finish || '');
        return found.find((f) => n && normName(f.basename).split(/[.\s_-]+/).some((p) => p.length > 3 && n.includes(p)));
      };
      const floorHit = pickFor(mesh.floorGuess) || found[1] || found[0];
      const wallHit = pickFor(mesh.wallGuess) || found[0];
      const uniq = [];
      for (const h of [floorHit, wallHit, ...found]) {
        if (h && !uniq.some((u) => u.filename === h.filename)) uniq.push(h);
      }
      textureRefs = uniq.slice(0, 4).map((h, i) => ({
        filename: h.filename,
        url: `/api/renders/media/${h.filename}`,
        role: i === 0 ? 'floor' : i === 1 ? 'wall' : 'catalog'
      }));
      if (textureRefs.length) {
        mesh.note = [mesh.note, `Usate ${textureRefs.length} texture dallo ZIP come riferimento pavimento/pareti.`].filter(Boolean).join(' ');
      }
    }

    let planImage = null;
    let plan2dName = null;
    if (mesh && (mesh.placed?.length || mesh.openings?.length)) {
      try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        const stamp = Date.now();
        plan2dName = `plan-${stamp}.png`;
        planImage = `view3d-${stamp}.png`;
        await fs.writeFile(path.join(UPLOADS_DIR, plan2dName), surveyPng(mesh));
        await fs.writeFile(path.join(UPLOADS_DIR, planImage), surveyView3d(mesh));
        mesh.planImage = planImage;
      } catch (err) {
        console.error('plan png', err.message);
      }
    }

    const suggested = mesh ? {
      roomType: mesh.suggestedRoom || 'altro',
      fixtures: mesh.fixtures || [],
      floorGuess: mesh.floorGuess || '',
      wallGuess: mesh.wallGuess || '',
      colors: mesh.mtlColors || [],
      note: mesh.note || '',
      layoutLock: mesh.layoutLock || '',
      openings: mesh.openings || [],
      planImage,
      textureRefs
    } : null;

    res.json({
      success: true,
      data: {
        analysis,
        mesh,
        suggested,
        textureRefs,
        planImage,
        planUrl: plan2dName ? `/api/renders/media/${plan2dName}` : null,
        viewUrl: planImage ? `/api/renders/media/${planImage}` : null,
        sourceImage: hqName,
        sourceModel: modelFile ? modelFile.filename : null
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/generate-render', async (req, res, next) => {
  try {
    const { clientId, analysis, style, lighting, colors, sourceImage, modelBrief, roomType, floorFinish, wallFinish, fixtures, textureRefs, layoutLock, planImage } = req.body;
    if (!analysis) {
      return res.status(400).json({ success: false, error: 'Manca l\'analisi del file' });
    }

    const client = await ensureClient(req.adminId, clientId);
    const refs = [];
    const pushRef = async (name) => {
      if (!name) return;
      const p = path.join(UPLOADS_DIR, path.basename(name));
      try {
        await fs.access(p);
        refs.push(p);
      } catch {}
    };
    await pushRef(sourceImage);
    if (!sourceImage) await pushRef(planImage);
    const extraRefs = Array.isArray(textureRefs) ? textureRefs : [];
    for (const t of extraRefs.slice(0, 2)) {
      await pushRef(typeof t === 'string' ? t : t.filename);
    }

    const room = String(roomType || '').trim();
    const floor = String(floorFinish || '').trim();
    const wall = String(wallFinish || '').trim();
    const fx = Array.isArray(fixtures) ? fixtures.filter(Boolean).join(', ') : String(fixtures || '');
    const isBath = /bagno|bath/i.test(room + ' ' + String(analysis).slice(0, 400));
    const lock = String(layoutLock || '').trim() || (String(analysis).match(/PIANTA VINCOLANTE[\s\S]{0,2500}/) || [''])[0];
    const fromPhoto = Boolean(sourceImage);
    const cladding = String(analysis).match(/RIVESTIMENTI[\s\S]{0,700}/i)?.[0]
      || String(analysis).match(/Pavimento[:\s][\s\S]{0,400}/i)?.[0]
      || '';
    const prompt = fromPhoto
      ? `Photorealistic restyle of the FIRST image (SketchUp screenshot, possibly upscaled). This image is the ONLY layout.
Keep camera, walls, window, door/openings, and every fixture in the same place and same count.
Do not add objects. Do not swap WC and bidet. A round/oval wall disc is a MIRROR, not a sink.
Keep tub glass only as in the photo (half-screen stays half). Keep hydromassage jets if visible.
No toilet-paper holders, bottles, plants unless they are in the first image.

CLADDING — copy from the first image, wall by wall:
- Floor material stays on the floor only.
- Tiled walls stay tiled with the same look; painted walls stay painted.
- Do not make all walls the same plaster. Do not paint over tiles. Do not put the floor texture on the walls.
${cladding ? `Survey of finishes:\n${cladding}\n` : ''}
FLOOR (user): ${floor || '(keep from photo)'}
WALLS (user): ${wall || '(keep from photo, per wall)'}
${lock ? `Components:\n${lock}\n` : ''}
${fx ? 'Named objects: ' + fx : ''}
${modelBrief || ''}
If extra reference images follow, they are MATERIAL SAMPLES only (floor/wall textures), not a new layout.
Style: ${style || 'contemporary Italian interior'}. Photoreal, no SketchUp axes, no watermark, no people.`
      : `Turn the first colored 3D massing into a photoreal room. Keep blocks in place.
FLOOR: ${floor || ''}
WALLS: ${wall || ''}
${lock ? `Survey:\n${lock}\n` : ''}
${modelBrief || ''}
Style: ${style || 'contemporary Italian interior'}. Photoreal, no text, no people.`;

    const item = await generateInteriorImage(prompt, refs);
    const savedPhoto = await saveGeneratedImage(item, 'render');

    const render = await Render.create({
      clientId: client._id,
      adminId: req.adminId,
      title: `Render AI - ${new Date().toLocaleDateString('it-IT')}`,
      description: 'Render da rilievo foto/modello 3D',
      imageUrl: savedPhoto.imageUrl,
      imageFile: savedPhoto.imageName,
      gridFileId: savedPhoto.gridFileId,
      style: style || 'contemporaneo',
      lighting: lighting || 'mista',
      colors: colors ? String(colors).split(',').map((c) => c.trim()).filter(Boolean) : [],
      renderType: 'dalle'
    });

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: savedPhoto.imageUrl,
        title: render.title,
        createdAt: render.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
});

async function localRenderPath(render) {
  if (!render?.imageFile) return null;
  const disk = path.join(UPLOADS_DIR, path.basename(render.imageFile));
  try {
    await fs.access(disk);
    return disk;
  } catch {}
  try {
    const buf = await readGridByName(render.imageFile);
    if (!buf) return null;
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.writeFile(disk, buf);
    return disk;
  } catch {
    return null;
  }
}

router.post('/correct-render', async (req, res, next) => {
  try {
    const notes = String(req.body?.notes || '').trim();
    const renderId = req.body?.renderId;
    if (!notes) {
      return res.status(400).json({ success: false, error: 'Scrivi cosa correggere (una cosa alla volta).' });
    }
    if (!renderId) {
      return res.status(400).json({ success: false, error: 'Manca il render da correggere' });
    }
    const prev = await Render.findOne({ _id: renderId, adminId: req.adminId });
    if (!prev) return res.status(404).json({ success: false, error: 'Render non trovato' });
    const src = await localRenderPath(prev);
    if (!src) return res.status(404).json({ success: false, error: 'File del render non disponibile' });

    const prompt = `This is the CURRENT finished render. Apply ONLY the user's corrections. Keep camera, room layout, and everything not mentioned.
User corrections (Italian): ${notes}
Typical reminders: a wall opening is not a door leaf; keep basins centered as already composed unless told otherwise; add cladding only where asked.
Do not redesign. Photoreal, no text, no people, no watermark.`;

    const item = await generateInteriorImage(prompt, [src]);
    const saved = await saveGeneratedImage(item, 'fix');
    const client = prev.clientId
      ? await Client.findOne({ _id: prev.clientId, adminId: req.adminId })
      : await ensureClient(req.adminId, req.body?.clientId);

    const render = await Render.create({
      clientId: client._id,
      adminId: req.adminId,
      title: `Correzione — ${notes.slice(0, 48)}`,
      description: notes,
      imageUrl: saved.imageUrl,
      imageFile: saved.imageName,
      gridFileId: saved.gridFileId,
      style: prev.style,
      lighting: prev.lighting,
      colors: prev.colors,
      renderType: 'dalle'
    });

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: saved.imageUrl,
        title: render.title,
        createdAt: render.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
});

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {}
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

async function ensureClient(adminId, clientId) {
  if (clientId) {
    const found = await Client.findOne({ _id: clientId, adminId });
    if (found) return found;
  }
  const existing = await Client.findOne({ adminId, name: 'Studio / prove' });
  if (existing) return existing;
  return Client.create({
    adminId,
    name: 'Studio / prove',
    email: `studio-${String(adminId).slice(-6)}@local`,
    projectType: 'residential'
  });
}

router.post('/configure-environment', optionalMultipart, async (req, res, next) => {
  const uploaded = [];
  try {
    const body = req.body || {};
    const requestedClient = String(body.clientId || '').trim();
    const roomType = String(body.roomType || body.room || 'salotto').trim() || 'salotto';
    const client = await ensureClient(req.adminId, requestedClient);
    const clientId = String(client._id);

    const styles = parseList(body.styles);
    const colors = parseList(body.colors);
    const colorNotes = (body.customColor || '').trim();
    if (colorNotes) colors.push(colorNotes);
    const floorFinish = body.floorFinish || 'parquet rovere naturale';
    const wallFinish = body.wallFinish || 'pittura liscia';
    const lighting = body.lighting || 'mista';
    const budget = body.budget || 'medio';
    const size = body.size || 'medio';
    const sqm = (body.sqm || '').trim();
    const brief = (body.brief || '').trim();
    const fixtures = parseList(body.fixtures);
    if ((roomType === 'bagno' || roomType === 'bathroom') && fixtures.length === 0) {
      fixtures.push('sanitari contemporanei', 'doccia o vasca', 'lavabo', 'rubinetteria');
    }
    if (roomType === 'wellness' && fixtures.length === 0) {
      fixtures.push('sauna', 'zona relax', 'doccia emozionale');
    }
    if (roomType === 'palestra' && fixtures.length === 0) {
      fixtures.push('attrezzi home gym', 'pavimento in gomma', 'specchi');
    }
    if (['terrazzo', 'giardino', 'piscina', 'patio'].includes(roomType) && fixtures.length === 0) {
      fixtures.push('arredo outdoor', 'piante', 'illuminazione esterna calda');
    }

    const ROOM_SCENE = {
      salotto: 'photorealistic interior living room in Italy',
      cucina: 'photorealistic interior kitchen in Italy',
      bagno: 'photorealistic interior bathroom in Italy',
      camera: 'photorealistic interior bedroom in Italy',
      ufficio: 'photorealistic home office interior in Italy',
      ufficio_open: 'photorealistic contemporary open-plan office interior in Italy, no people',
      sala_riunioni: 'photorealistic meeting room interior in Italy, no people',
      sala_attesa: 'photorealistic waiting lounge interior in Italy, no people',
      reception: 'photorealistic reception desk lobby interior in Italy, no people',
      coworking: 'photorealistic coworking studio interior in Italy, no people',
      ingresso: 'photorealistic residential entrance hall in Italy',
      corridoio: 'photorealistic residential corridor interior in Italy',
      cabina: 'photorealistic walk-in closet interior in Italy',
      lavanderia: 'photorealistic laundry room interior in Italy',
      taverna: 'photorealistic basement tavern lounge interior in Italy',
      ristorante: 'photorealistic restaurant dining room interior in Italy, no people',
      lobby: 'photorealistic boutique hotel lobby interior in Italy, no people',
      wellness: 'photorealistic private home spa and wellness suite in Italy, humid stone and warm wood, no people',
      palestra: 'photorealistic luxury home gym interior in Italy, no people',
      terrazzo: 'photorealistic rooftop or apartment terrace exterior in Italy, daylight, no people',
      giardino: 'photorealistic residential garden landscape in Italy, no people',
      piscina: 'photorealistic private villa swimming pool exterior in Italy, no people',
      patio: 'photorealistic patio courtyard exterior in Italy, no people',
      altro: 'photorealistic designed residential space in Italy'
    };
    const scene = ROOM_SCENE[roomType] || `photorealistic designed ${roomType} in Italy`;
    const outdoor = ['terrazzo', 'giardino', 'piscina', 'patio'].includes(roomType);
    const views = parseList(body.views);
    const viewKeys = views.length ? views : ['frontale'];

    const floorFile = req.files?.floorTexture?.[0];
    const wallFile = req.files?.wallTexture?.[0];
    const planFile = req.files?.planImage?.[0];
    const modelFileCfg = req.files?.model?.[0];
    const mtlFileCfg = req.files?.mtl?.[0];
    if (floorFile) uploaded.push(floorFile.path);
    if (wallFile) uploaded.push(wallFile.path);
    if (planFile) uploaded.push(planFile.path);
    if (modelFileCfg) uploaded.push(modelFileCfg.path);
    if (mtlFileCfg) uploaded.push(mtlFileCfg.path);
    if (modelFileCfg) {
      const extCfg = path.extname(modelFileCfg.originalname || '').toLowerCase();
      let objTxt = '';
      let mtlTxt = mtlFileCfg ? await fs.readFile(mtlFileCfg.path, 'utf8') : '';
      if (extCfg === '.zip') {
        const entries = await unzipEntries(await fs.readFile(modelFileCfg.path));
        const objN = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.obj') && !n.toLowerCase().includes('__macosx'));
        const mtlN = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.mtl') && !n.toLowerCase().includes('__macosx'));
        if (objN) objTxt = entries[objN].toString('utf8');
        if (mtlN) mtlTxt = entries[mtlN].toString('utf8');
      } else if (extCfg === '.obj') {
        objTxt = await fs.readFile(modelFileCfg.path, 'utf8');
      }
      if (objTxt) {
      const parsed = parseObjSummary(objTxt, mtlTxt, body.doorHint || body.brief);
      body.modelLayout = JSON.stringify({
        suggestedRoom: parsed.suggestedRoom,
        note: parsed.note,
        fixtures: parsed.fixtures,
        layoutLock: parsed.layoutLock,
        openings: parsed.openings,
        placed: (parsed.placed || []).slice(0, 12),
        objects: (parsed.objects || []).slice(0, 25),
        proportions: parsed.proportions
      });
      if ((!body.roomType || body.roomType === 'salotto') && parsed.suggestedRoom && parsed.suggestedRoom !== 'altro') {
        // keep user's explicit room; only fill if they left default AND mesh is confident
      }
      if (parsed.suggestedRoom === 'bagno' && !fixtures.length) {
        fixtures.push(...(parsed.fixtures.length ? parsed.fixtures : ['sanitari contemporanei', 'lavabo', 'doccia o vasca']));
      }
      body.layoutLock = parsed.layoutLock;
      try {
        const planPath = path.join(UPLOADS_DIR, `view3d-${Date.now()}.png`);
        await fs.writeFile(planPath, surveyView3d(parsed));
        uploaded.unshift(planPath);
      } catch (err) {
        console.error('plan png cfg', err.message);
      }
      }
    }

    const stylesText = styles.join(', ') || 'moderno';
    const colorsText = colors.join(', ') || 'neutri caldi';
    const fixturesText = fixtures.join(', ');
    const viewsOut = [];

    for (const key of viewKeys.slice(0, 4)) {
      const camera = VIEW_PROMPTS[key] || VIEW_PROMPTS.frontale;
      const isBath = roomType === 'bagno' || roomType === 'bathroom';
      const prompt = `${scene}.
Style: ${stylesText}
Palette (names, RAL or hex): ${colorsText}
FLOOR ONLY — do not put this finish on walls: ${floorFinish}${floorFile ? ' — match the catalog floor photo' : ''}
WALLS ONLY — do not put this finish on the floor: ${wallFinish}${wallFile ? ' — match the catalog wall photo' : ''}
CRITICAL MATERIAL SEPARATION: floor and walls must look different. Never use the same texture/colour on both.
${isBath ? 'THIS IS A BATHROOM: toilet/bidet, basin, shower or tub, bathroom taps. FORBIDDEN: bed, pillows, bedroom furniture.' : ''}
${fixturesText ? `Elements that MUST appear: ${fixturesText}` : ''}
${brief ? `User layout brief (follow closely): ${brief}` : ''}
${sqm ? `Exact area: ${sqm} square meters.` : `Size class: ${size}`}
${planFile ? 'A floor-plan image is provided: respect room shape and openings.' : ''}
${body.layoutLock ? `LOCKED SURVEY from the 3D model — do not move anything, only restyle materials:\n${body.layoutLock}` : (body.modelLayout ? `OBJ geometry: ${String(body.modelLayout).slice(0, 900)}` : '')}
Lighting: ${lighting}
Budget: ${budget}
Camera: ${camera}
Same furniture layout and materials across views. No text, no watermark, no logos.`;

      const item = await generateInteriorImage(prompt, uploaded);
      const saved = await saveGeneratedImage(item, `config-${roomType}-${key}`);
      const doc = await Render.create({
        ...(clientId ? { clientId } : {}),
        adminId: req.adminId,
        title: `${roomType} — ${key}`,
        description: brief || `${roomType} - ${stylesText} - ${floorFinish} / ${wallFinish}`,
        imageUrl: saved.imageUrl,
        imageFile: saved.imageName,
        gridFileId: saved.gridFileId,
        room: roomType,
        style: stylesText,
        colors,
        materials: [floorFinish, wallFinish, ...fixtures],
        lighting,
        renderType: 'config',
        metadata: { roomType, size, sqm, budget, view: key, brief }
      });
      viewsOut.push({ view: key, renderId: doc._id, ...saved });
    }

    const first = viewsOut[0];
    const render = first;

    res.json({
      success: true,
      data: {
        renderId: first.renderId,
        renderUrl: first.imageUrl,
        views: viewsOut.map((v) => ({
          view: v.view,
          renderId: v.renderId,
          renderUrl: v.imageUrl
        })),
        roomType,
        size,
        budget,
        description: brief || `${roomType} — ${stylesText}`
      }
    });
  } catch (error) {
    next(error);
  } finally {
    await Promise.all(uploaded.map((p) => fs.unlink(p).catch(() => {})));
  }
});

router.get('/configurations/:clientId', async (req, res, next) => {
  try {
    const client = await Client.findOne({ _id: req.params.clientId, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    const configurations = await Render.find({
      clientId: req.params.clientId,
      renderType: 'config'
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: configurations });
  } catch (error) {
    next(error);
  }
});

router.post('/bulk-delete', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Nessun render selezionato' });
    const docs = await Render.find({ _id: { $in: ids }, adminId: req.adminId });
    for (const render of docs) {
      if (render.imageFile) await fs.unlink(path.join(UPLOADS_DIR, render.imageFile)).catch(() => {});
      if (render.imageFile) {
        try {
          const bucket = gridBucket();
          const files = await bucket.find({ filename: render.imageFile }).toArray();
          for (const f of files) await bucket.delete(f._id);
        } catch {}
      }
    }
    await Render.deleteMany({ _id: { $in: docs.map((d) => d._id) }, adminId: req.adminId });
    res.json({ success: true, deleted: docs.length });
  } catch (error) {
    next(error);
  }
});

router.post('/bulk-zip', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Nessun render selezionato' });
    const docs = await Render.find({ _id: { $in: ids }, adminId: req.adminId });
    const files = [];
    for (const render of docs) {
      if (!render.imageFile) continue;
      let buf;
      try {
        buf = await fs.readFile(path.join(UPLOADS_DIR, render.imageFile));
      } catch {
        buf = await readGridByName(render.imageFile);
      }
      if (buf) files.push({ name: `${(render.title || 'render').replace(/[^\w\-]+/g, '_')}-${String(render._id).slice(-6)}.png`, data: buf });
    }
    if (!files.length) return res.status(404).json({ success: false, error: 'Nessun file disponibile' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="renders-archivio.zip"');
    res.send(buildZip(files));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const render = await Render.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
    if (!render) return res.status(404).json({ success: false, error: 'Render non trovato' });
    if (render.imageFile) {
      await fs.unlink(path.join(UPLOADS_DIR, render.imageFile)).catch(() => {});
    }
    res.json({ success: true, message: 'Render cancellato' });
  } catch (error) {
    next(error);
  }
});

export default router;
