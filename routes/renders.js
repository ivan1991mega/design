import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI, { toFile } from 'openai';

import Render from '../models/Render.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const router = express.Router();

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

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo file non supportato (usa JPG, PNG o WebP)'));
  }
});

function imageModel() {
  return process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
}

async function saveGeneratedImage(result, prefix) {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const imageName = `${prefix}-${Date.now()}.png`;
  const dest = path.join(UPLOADS_DIR, imageName);

  if (result.b64_json) {
    await fs.writeFile(dest, Buffer.from(result.b64_json, 'base64'));
  } else if (result.url) {
    const imageResponse = await fetch(result.url);
    if (!imageResponse.ok) {
      throw new Error(`Download immagine fallito (${imageResponse.status})`);
    }
    await fs.writeFile(dest, Buffer.from(await imageResponse.arrayBuffer()));
  } else {
    throw new Error('Nessuna immagine restituita dal modello');
  }

  return { imageName, imageUrl: `/uploads/${imageName}` };
}

async function generateInteriorImage(prompt, refPaths = []) {
  const openai = getOpenAI();
  const model = imageModel();
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'medium';
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
      size: '1024x1024',
      quality
    });
  } else {
    const params = { model, prompt, n: 1, size: '1024x1024' };
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

const VIEW_PROMPTS = {
  frontale: 'eye-level camera facing the main wall, wide architectural photo',
  angolo: 'camera from the opposite corner, 3/4 view showing two walls and the floor',
  dettaglio: 'closer shot of floor, wall cladding and material junctions',
  laterale: 'side viewpoint along the room showing depth and furniture'
};

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

router.post('/analyze-image', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Immagine non caricata' });

    const imageBuffer = await fs.readFile(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` }
            },
            {
              type: 'text',
              text: `Analizza questa immagine di interior design in dettaglio. Identifica:
1. Tipo di stanza
2. Stile principale
3. Colori dominanti
4. Materiali visibili
5. Dimensioni stimate
6. Illuminazione
7. Descrizione generale

Rispondi in italiano, in formato chiaro e professionale.`
            }
          ]
        }
      ]
    });

    const analysis = response.choices?.[0]?.message?.content || '';
    await fs.unlink(req.file.path).catch(() => {});

    res.json({ success: true, data: { analysis } });
  } catch (error) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
});

router.post('/generate-render', async (req, res, next) => {
  try {
    const { clientId, analysis, style, lighting, colors } = req.body;
    if (!clientId || !analysis) {
      return res.status(400).json({ success: false, error: 'Dati mancanti (clientId, analysis)' });
    }

    const client = await Client.findOne({ _id: clientId, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });

    const prompt = `Professional photorealistic interior design render.
Analysis: ${String(analysis).slice(0, 1200)}
Style: ${style || 'contemporary'}
Lighting: ${lighting || 'natural and artificial'}
Colors: ${colors || 'neutral'}
High quality photography, realistic textures, professional lighting.`;

    const item = await generateInteriorImage(prompt);
    const { imageName, imageUrl } = await saveGeneratedImage(item, 'render');

    const render = await Render.create({
      clientId,
      adminId: req.adminId,
      title: `Render AI - ${new Date().toLocaleDateString('it-IT')}`,
      description: 'Render generato da immagine analizzata',
      imageUrl,
      imageFile: imageName,
      style: style || 'contemporaneo',
      lighting: lighting || 'mista',
      colors: colors ? String(colors).split(',').map((c) => c.trim()).filter(Boolean) : [],
      renderType: 'dalle'
    });

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: imageUrl,
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

router.post('/configure-environment', textureUpload, async (req, res, next) => {
  const uploaded = [];
  try {
    const body = req.body || {};
    const clientId = (body.clientId || '').trim();
    const roomType = (body.roomType || '').trim();
    if (!roomType) {
      return res.status(400).json({ success: false, error: 'Scegli il tipo di stanza' });
    }

    if (clientId) {
      const client = await Client.findOne({ _id: clientId, adminId: req.adminId });
      if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    }

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
      const prompt = `Photorealistic interior design photograph of a ${roomType} in Italy.
Style: ${stylesText}
Colors (interpret names like "grigio topo", "ottanio", RAL or hex if present): ${colorsText}
Floor: ${floorFinish}${floorFile ? ' — apply catalog floor texture from the floor reference photo' : ''}
Walls: ${wallFinish}${wallFile ? ' — apply catalog wall texture from the wall reference photo' : ''}
${fixturesText ? `Bathroom/kitchen fixtures to include: ${fixturesText}` : ''}
${brief ? `User layout brief (follow closely): ${brief}` : ''}
${sqm ? `Exact area: ${sqm} square meters. Respect realistic proportions.` : `Size class: ${size}`}
${planFile ? 'A floor-plan image is provided as reference: respect room shape, openings and circulation as much as possible.' : ''}
Lighting: ${lighting}
Budget level: ${budget}
Camera: ${camera}
Same furniture layout and materials across views. No text, no watermark, no logos.`;

      const item = await generateInteriorImage(prompt, uploaded);
      const saved = await saveGeneratedImage(item, `config-${roomType}-${key}`);
      viewsOut.push({ view: key, ...saved });
    }

    const first = viewsOut[0];
    const render = await Render.create({
      ...(clientId ? { clientId } : {}),
      adminId: req.adminId,
      title: `Configurazione ${roomType}`,
      description: brief || `${roomType} - ${stylesText} - ${floorFinish} / ${wallFinish}`,
      imageUrl: first.imageUrl,
      imageFile: first.imageName,
      room: roomType,
      style: stylesText,
      colors,
      materials: [floorFinish, wallFinish, ...fixtures],
      lighting,
      renderType: 'config',
      metadata: {
        roomType, size, sqm, budget, styles, colors, lighting,
        floorFinish, wallFinish, fixtures, brief,
        views: viewsOut.map((v) => ({ view: v.view, imageUrl: v.imageUrl }))
      }
    });

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: first.imageUrl,
        views: viewsOut.map((v) => ({ view: v.view, renderUrl: v.imageUrl })),
        roomType,
        size,
        budget,
        description: render.description,
        createdAt: render.createdAt
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
