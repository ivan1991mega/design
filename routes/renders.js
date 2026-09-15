import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';

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
const MODEL_EXT = ['.obj', '.mtl', '.stl', '.gltf', '.glb', '.dae'];

const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (IMAGE_MIME.includes(file.mimetype) || MODEL_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Formato non supportato. Usa JPG/PNG/WebP oppure OBJ/STL/glTF/GLB/DAE (da SketchUp esporta OBJ).'));
  }
});

const analyzeUpload = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'model', maxCount: 1 }
]);

function parseObjSummary(text) {
  const verts = [];
  const names = new Set();
  const mats = new Set();
  let faces = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      const x = Number(p[1]), y = Number(p[2]), z = Number(p[3]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) verts.push([x, y, z]);
    } else if (line.startsWith('f ')) faces += 1;
    else if (line.startsWith('o ') || line.startsWith('g ')) names.add(line.slice(2).trim());
    else if (line.startsWith('usemtl ')) mats.add(line.slice(7).trim());
  }
  if (!verts.length) return { format: 'obj', objects: [...names], materials: [...mats], faces, note: 'OBJ senza vertici leggibili' };
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of verts) {
    if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = [...size].sort((a, b) => b - a);
  const unitsGuess = axis[0] > 80 ? 'centimetri o millimetri' : axis[0] > 8 ? 'metri' : 'unità SketchUp';
  return {
    format: 'obj',
    vertices: verts.length,
    faces,
    objects: [...names].slice(0, 40),
    materials: [...mats].slice(0, 30),
    bbox: {
      width: Number(size[0].toFixed(3)),
      depth: Number(size[2].toFixed(3)),
      height: Number(size[1].toFixed(3))
    },
    unitsGuess,
    proportions: `ingombro ${size[0].toFixed(2)} x ${size[2].toFixed(2)} x h ${size[1].toFixed(2)}`
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
      images.push(await toFile(buf, path.basename(p), { type: 'image/png' }));
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
  { name: 'planImage', maxCount: 1 }
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
    const imageFile = req.files?.image?.[0] || (req.file?.mimetype?.startsWith('image/') ? req.file : null);
    const modelFile = req.files?.model?.[0] || (!imageFile ? req.file : null);
    if (!imageFile && !modelFile) {
      return res.status(400).json({ success: false, error: 'Carica una foto PNG/JPG e/o un modello OBJ/STL/glTF esportato da SketchUp' });
    }

    const ext = modelFile ? path.extname(modelFile.originalname || '').toLowerCase() : '';
    if (ext === '.skp') {
      return res.status(400).json({ success: false, error: 'Il file .skp di SketchUp non è leggibile. Esporta in OBJ (File → Esporta → Oggetto 3D) e ricarica.' });
    }

    let mesh = null;
    if (modelFile && ext === '.obj') {
      const text = await fs.readFile(modelFile.path, 'utf8');
      mesh = parseObjSummary(text);
    } else if (modelFile && ext === '.stl') {
      mesh = parseStlSummary(await fs.readFile(modelFile.path));
    } else if (modelFile && (ext === '.gltf' || ext === '.glb' || ext === '.dae')) {
      mesh = { format: ext.slice(1), file: modelFile.originalname, bytes: modelFile.size };
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
${mesh ? `Dati mesh allegata: ${JSON.stringify(mesh)} — usali per quote e oggetti nominati.` : ''}
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
          content: `Da questo modello 3D esportato da SketchUp/CAD ricostruisci in italiano una lettura architettonica vincolante per un render.
Mesh: ${JSON.stringify(mesh)}
Deduci destinazione d'uso dai nomi oggetti, proporzioni della bounding box, possibili muri/pavimento.
${modelBrief ? `DIRETTIVE DELL'UTENTE (prioritarie): ${modelBrief}` : ''}
Scrivi layout, quote relative, cosa non va inventato.`
        }]
      });
      vision = response.choices?.[0]?.message?.content || '';
    }

    const analysis = [
      modelBrief ? `DIRETTIVE UTENTE SUL 3D\n${modelBrief}\n` : '',
      vision,
      mesh ? `\n\nDATI MODELLO 3D\n${JSON.stringify(mesh, null, 2)}` : ''
    ].join('').trim();

    res.json({
      success: true,
      data: {
        analysis,
        mesh,
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
    const { clientId, analysis, style, lighting, colors, sourceImage, modelBrief } = req.body;
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

    const prompt = `Rebuild this exact space as a photorealistic architectural photograph.
Follow the survey/analysis as constraints. Do NOT change room shape, window/door positions, camera angle or furniture layout unless asked.
Analysis:
${String(analysis).slice(0, 2500)}
${modelBrief ? `User directives on the 3D/SketchUp file (highest priority): ${modelBrief}` : ''}
Requested style overlay: ${style || 'keep existing character'}
Lighting: ${lighting || 'keep existing light direction'}
Colors/materials overlay: ${colors || 'keep existing materials unless specified'}
Same proportions and vanishing points as the source. No text, no watermark, no people.`;

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
    if (floorFile) uploaded.push(floorFile.path);
    if (wallFile) uploaded.push(wallFile.path);
    if (planFile) uploaded.push(planFile.path);

    const stylesText = styles.join(', ') || 'moderno';
    const colorsText = colors.join(', ') || 'neutri caldi';
    const fixturesText = fixtures.join(', ');
    const viewsOut = [];

    for (const key of viewKeys.slice(0, 4)) {
      const camera = VIEW_PROMPTS[key] || VIEW_PROMPTS.frontale;
      const prompt = `${scene}.
Style: ${stylesText}
Colors (interpret names like "grigio topo", "ottanio", RAL or hex if present): ${colorsText}
${outdoor ? `Outdoor flooring / decking: ${floorFinish}` : `Floor: ${floorFinish}`}${floorFile ? ' — match the catalog floor/deck texture from the reference photo' : ''}
${outdoor ? `Vertical surfaces, walls or fences: ${wallFinish}` : `Walls: ${wallFinish}`}${wallFile ? ' — match the catalog wall texture from the reference photo' : ''}
${fixturesText ? `Elements to include: ${fixturesText}` : ''}
${brief ? `User layout brief (follow closely): ${brief}` : ''}
${sqm ? `Exact area: ${sqm} square meters. Respect realistic proportions.` : `Size class: ${size}`}
${planFile ? 'A floor-plan image is provided as reference: respect room shape, openings and circulation as much as possible.' : ''}
Lighting: ${lighting}
Budget level: ${budget}
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
