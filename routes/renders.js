import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

import Render from '../models/Render.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/auth.js';

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

async function saveRemoteImage(url, prefix) {
  const imageResponse = await fetch(url);
  if (!imageResponse.ok) {
    throw new Error(`Download immagine DALL-E fallito (${imageResponse.status})`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const imageName = `${prefix}-${Date.now()}.png`;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, imageName), imageBuffer);
  return { imageName, imageUrl: `/uploads/${imageName}` };
}

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

    const openai = getOpenAI();
    const dalleResponse = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'hd'
    });

    const remoteUrl = dalleResponse.data?.[0]?.url;
    if (!remoteUrl) throw new Error('DALL-E non ha restituito un URL');

    const { imageName, imageUrl } = await saveRemoteImage(remoteUrl, 'render');

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

router.post('/configure-environment', async (req, res, next) => {
  try {
    const { clientId, roomType, size, budget, styles, colors, materials, lighting } = req.body;
    if (!clientId || !roomType || !size) {
      return res.status(400).json({ success: false, error: 'Campi obbligatori mancanti' });
    }

    const client = await Client.findOne({ _id: clientId, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });

    const stylesText = Array.isArray(styles) ? styles.join(', ') : styles || 'moderno';
    const colorsText = Array.isArray(colors) ? colors.join(', ') : colors || 'neutro';
    const materialsText = Array.isArray(materials) ? materials.join(', ') : materials || 'vari';

    const prompt = `Photorealistic interior render of a ${roomType}.
Style: ${stylesText}
Colors: ${colorsText}
Materials: ${materialsText}
Lighting: ${lighting || 'mixed'}
Budget: ${budget || 'medium'}
Size: ${size}
4K photorealistic quality, professional lighting, coherent furniture.`;

    const openai = getOpenAI();
    const dalleResponse = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'hd'
    });

    const remoteUrl = dalleResponse.data?.[0]?.url;
    if (!remoteUrl) throw new Error('DALL-E non ha restituito un URL');

    const { imageName, imageUrl } = await saveRemoteImage(remoteUrl, `config-${roomType}`);

    const render = await Render.create({
      clientId,
      adminId: req.adminId,
      title: `Configurazione ${roomType}`,
      description: `${roomType} - ${stylesText}`,
      imageUrl,
      imageFile: imageName,
      room: roomType,
      style: stylesText,
      colors: Array.isArray(colors) ? colors : colors ? [colors] : [],
      materials: Array.isArray(materials) ? materials : materials ? [materials] : [],
      lighting: lighting || 'mista',
      renderType: 'config',
      metadata: { roomType, size, budget, styles, colors, materials, lighting }
    });

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: imageUrl,
        roomType,
        size,
        budget,
        description: `${roomType} in stile ${stylesText}`,
        createdAt: render.createdAt
      }
    });
  } catch (error) {
    next(error);
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
