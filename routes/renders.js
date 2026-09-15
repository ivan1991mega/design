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
const MODEL_EXT = ['.obj', '.mtl', '.stl', '.gltf', '.glb', '.dae', '.zip', '.txt'];
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
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (IMAGE_MIME.includes(mime) || MODEL_EXT.includes(ext) || MODEL_MIME.includes(mime) || mime.startsWith('model/')) {
      cb(null, true);
    } else cb(new Error('Formato non supportato. Usa JPG/PNG, OBJ, MTL o uno ZIP con OBJ+MTL.'));
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
  if (/(toilet|vaso|bidet|doccia|shower|lavabo|vasca|sanitari|cassetta|sospesi|\bwc\b)/.test(t)) return 'bathroom-fixture';
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

function parseObjSummary(text, mtlText) {
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
    ...openings.filter((a) => a.type === 'porta').map((a) => `PORTA ${a.name}: ${toHuman(a.width)} × h ${toHuman(a.height)} a X=${toHuman(a.fromX)} Z=${toHuman(a.fromZ)} sulla ${a.rel}. Fissa.`),
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
    note: [bathNote, mapNote, layoutLock ? 'Aperture e orientamento bloccati sul modello.' : ''].filter(Boolean).join(' ')
  };
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
      return res.status(400).json({ success: false, error: 'Carica una foto, un OBJ (o ZIP con OBJ+MTL), oppure incolla i nomi dei componenti SketchUp' });
    }

    const ext = modelFile ? path.extname(modelFile.originalname || '').toLowerCase() : '';
    if (ext === '.skp') {
      return res.status(400).json({ success: false, error: 'Il file .skp di SketchUp non è leggibile. Esporta in OBJ (File → Esporta → Oggetto 3D) oppure metti OBJ+MTL in uno ZIP.' });
    }

    let mesh = null;
    let mtlText = mtlUpload ? await fs.readFile(mtlUpload.path, 'utf8') : '';

    let zipMaps = [];
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
        const seen = names.map((n) => n.split('/').pop()).filter(Boolean).slice(0, 12).join(', ') || 'vuoto';
        return res.status(400).json({
          success: false,
          error: `Nello ZIP non c’è un file .obj (trovato: ${seen}). Zippa OBJ+MTL+cartella jpg, anche se sono in una sottocartella.`
        });
      }
      if (mtlName) mtlText = entries[mtlName].toString('utf8');
      mesh = parseObjSummary(entries[objName].toString('utf8'), mtlText);
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
    } else if (modelFile && (ext === '.obj' || ext === '.txt' || ext === '')) {
      const text = await fs.readFile(modelFile.path, 'utf8');
      if (looksLikeObj(text) || ext === '.obj') mesh = parseObjSummary(text, mtlText);
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
    if (imageFile) {
      const imageBuffer = await fs.readFile(imageFile.path);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = imageFile.mimetype || 'image/jpeg';
      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1600,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
              {
                type: 'text',
                text: `Sei un architetto. Analizza QUESTO spazio come base vincolante per un render fotorealistico.
Non inventare una planimetria diversa.
Elenca in italiano:
1. Tipo di ambiente e destinazione
2. Geometria: pianta percepita, rapporti LxPxH, aperture (porte/finestre) e dove stanno
3. Layout fisso: muri, pilastri, scale, soffitto, eventuali volumi che NON si devono spostare
4. Arredi visibili e posizione relativa (destra/sinistra/centro/fondo)
5. Materiali e finiture già presenti da rispettare o sostituire
6. Luce: direzione, temperatura, ombre
7. Cosa è un vincolo strutturale e cosa è modificabile
8. Istruzioni precise per un motore di render: stessa inquadratura, stesse proporzioni, stesso punto di fuga
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

    const analysis = [
      mesh?.layoutLock ? `PIANTA E APERTURE BLOCCATE\n${mesh.layoutLock}\n` : '',
      modelBrief ? `DIRETTIVE UTENTE SUL 3D\n${modelBrief}\n` : '',
      vision,
      mesh ? `\n\nDATI MODELLO 3D\n${JSON.stringify({ ...mesh, objects: (mesh.objects || []).slice(0, 20) }, null, 2)}` : ''
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

    const suggested = mesh ? {
      roomType: mesh.suggestedRoom || 'altro',
      fixtures: mesh.fixtures || [],
      floorGuess: mesh.floorGuess || '',
      wallGuess: mesh.wallGuess || '',
      colors: mesh.mtlColors || [],
      note: mesh.note || '',
      layoutLock: mesh.layoutLock || '',
      openings: mesh.openings || [],
      textureRefs
    } : null;

    res.json({
      success: true,
      data: {
        analysis,
        mesh,
        suggested,
        textureRefs,
        sourceImage: imageFile ? imageFile.filename : null,
        sourceModel: modelFile ? modelFile.filename : null
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/generate-render', async (req, res, next) => {
  try {
    const { clientId, analysis, style, lighting, colors, sourceImage, modelBrief, roomType, floorFinish, wallFinish, fixtures, textureRefs, layoutLock } = req.body;
    if (!analysis) {
      return res.status(400).json({ success: false, error: 'Manca l\'analisi del file' });
    }

    const client = await ensureClient(req.adminId, clientId);
    const refs = [];
    if (sourceImage) {
      const p = path.join(UPLOADS_DIR, path.basename(sourceImage));
      try {
        await fs.access(p);
        refs.push(p);
      } catch {}
    }
    const extraRefs = Array.isArray(textureRefs) ? textureRefs : [];
    for (const t of extraRefs.slice(0, 4)) {
      const name = typeof t === 'string' ? t : t.filename;
      if (!name) continue;
      const p = path.join(UPLOADS_DIR, path.basename(name));
      try {
        await fs.access(p);
        refs.push(p);
      } catch {}
    }

    const room = String(roomType || '').trim();
    const floor = String(floorFinish || '').trim();
    const wall = String(wallFinish || '').trim();
    const fx = Array.isArray(fixtures) ? fixtures.filter(Boolean).join(', ') : String(fixtures || '');
    const isBath = /bagno|bath/i.test(room + ' ' + String(analysis).slice(0, 400));
    const lock = String(layoutLock || '').trim() || (String(analysis).match(/PIANTA VINCOLANTE[\s\S]{0,2500}/) || [''])[0];
    const prompt = `Photorealistic architectural photograph reconstructing an EXISTING surveyed room. Layout is LAW.
${lock ? `LOCKED SURVEY (do not change positions):\n${lock}\n` : ''}
You may change materials, colours, lighting quality. You may NOT move doors, windows, sanitary, furniture, or rotate/mirror the plan.
ROOM TYPE: ${room || 'see analysis'}${isBath ? '. THIS IS A BATHROOM, never a bedroom. Forbidden: bed, pillows, duvet, nightstands. Keep toilet/bidet, basins, shower exactly on the listed walls.' : ''}
FLOOR (floor plane only): ${floor || '(distinct from walls)'}
WALLS (vertical only): ${wall || '(distinct from floor)'}
CRITICAL: floor ≠ walls. ${fx ? 'Fixtures stay where listed: ' + fx : ''}
User directives (materials/mood only unless they contradict the survey): ${modelBrief || 'none'}
Style: ${style || 'contemporary Italian interior'}
Lighting: ${lighting || 'mixed natural and artificial'}
Palette: ${colors || 'as specified in floor/walls'}
${extraRefs.length ? 'Catalog texture photos: apply the floor image only on the floor, wall image only on walls.' : ''}
Camera looks toward the window if one exists; openings stay on the surveyed walls. No extra windows, no rearranged furniture. No text, no watermark, no people.`;

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
      const parsed = parseObjSummary(objTxt, mtlTxt);
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
