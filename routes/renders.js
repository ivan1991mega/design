import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import fetch from 'node-fetch';

import Render from '../models/Render.js';
import Client from '../models/Client.js';
import { authenticate } from '../middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(path.join(__dirname, '../uploads'), { recursive: true });
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo file non supportato'));
    }
  }
});

// Get renders for client
router.get('/client/:clientId', authenticate, async (req, res, next) => {
  try {
    const client = await Client.findOne({ _id: req.params.clientId, adminId: req.adminId });
    if (!client) {
      return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    }

    const renders = await Render.find({ clientId: req.params.clientId })
      .sort({ createdAt: -1 });

    res.json({ success: true, data: renders });
  } catch (error) {
    next(error);
  }
});

// Upload render
router.post('/upload', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    const { clientId, title, description } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File non caricato' });
    }

    const render = new Render({
      clientId,
      adminId: req.adminId,
      title: title || 'Render',
      description: description || '',
      imageUrl: `/uploads/${req.file.filename}`,
      imageFile: req.file.filename,
      renderType: 'image'
    });

    await render.save();
    res.json({ success: true, data: render });
  } catch (error) {
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
});

// Vision API - Analyze image
router.post('/analyze-image', authenticate, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Immagine non caricata' });
    }

    const imageBuffer = await fs.readFile(req.file.path);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    console.log('👁️ Calling Vision API (GPT-4O)...');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            },
            {
              type: 'text',
              text: `Analizza questa immagine di interior design in dettaglio. Identifica:
1. Tipo di stanza (salotto, camera, cucina, bagno, ufficio, etc.)
2. Stile principale (moderno, classico, rustico, minimalista, lusso, etc.)
3. Colori dominanti (scrivi i colori visti)
4. Materiali visibili (legno, marmo, vetro, tessuti, etc.)
5. Dimensioni stimate (piccola, media, grande)
6. Illuminazione presente
7. Descrizione generale della qualità e dello spazio

Rispondi in formato chiaro e professionale.`
            }
          ]
        }
      ]
    });

    const analysis = response.choices[0].message.content;

    await fs.unlink(req.file.path).catch(() => {});

    console.log('✅ Vision analysis complete');

    res.json({
      success: true,
      data: {
        analysis,
        imagePath: `/uploads/${path.basename(req.file.path)}`
      }
    });
  } catch (error) {
    console.error('❌ Vision API Error:', error);
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// DALL-E 3 - Generate render from analysis
router.post('/generate-render', authenticate, async (req, res, next) => {
  try {
    const { clientId, analysis, style, lighting, colors } = req.body;

    if (!clientId || !analysis) {
      return res.status(400).json({ success: false, error: 'Dati mancanti' });
    }

    const prompt = `Sei un designer di interni professionista. Basandoti sulla seguente analisi, crea un render fotorealistico di interior design di alta qualità:

ANALISI IMMAGINE: ${analysis}

PERSONALIZZAZIONE:
- Stile: ${style || 'contemporaneo'}
- Illuminazione: ${lighting || 'naturale e artificiale'}
- Colori: ${colors || 'neutri'}

Crea un rendering iperrealistico in stile fotografico, con dettagli ricchi, texture realistiche e illuminazione professionale.`;

    console.log('🎨 Calling DALL-E 3...');

    const dalleResponse = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'hd'
    });

    const renderUrl = dalleResponse.data[0].url;
    const imageResponse = await fetch(renderUrl);
    const imageBuffer = await imageResponse.buffer();
    const imageName = `render-${Date.now()}.jpg`;
    const imagePath = path.join('uploads', imageName);

    await fs.mkdir('uploads', { recursive: true });
    await fs.writeFile(imagePath, imageBuffer);

    console.log('✅ Render generated');

    const render = new Render({
      clientId,
      adminId: req.adminId,
      title: `Render AI - ${new Date().toLocaleDateString('it-IT')}`,
      description: `Render generato da immagine analizzata`,
      imageUrl: `/${imagePath}`,
      imageFile: imageName,
      style: style || 'contemporaneo',
      lighting: lighting || 'mista',
      colors: colors ? colors.split(',').map(c => c.trim()) : [],
      renderType: 'dalle'
    });

    await render.save();

    console.log(`✅ Saved: ${render._id}`);

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: `/${imagePath}`,
        title: render.title,
        createdAt: render.createdAt
      }
    });
  } catch (error) {
    console.error('❌ DALL-E Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Environment Configurator
router.post('/configure-environment', authenticate, async (req, res, next) => {
  try {
    const { clientId, roomType, size, budget, styles, colors, materials, lighting } = req.body;

    if (!clientId || !roomType || !size) {
      return res.status(400).json({ success: false, error: 'Campi obbligatori mancanti' });
    }

    console.log(`🎨 Configuratore: ${roomType}`);

    const stylesText = Array.isArray(styles) ? styles.join(', ') : styles || 'moderno';
    const colorsText = Array.isArray(colors) ? colors.join(', ') : colors || 'neutro';
    const materialsText = Array.isArray(materials) ? materials.join(', ') : materials || 'vari';

    const prompt = `Crea un rendering dettagliato e fotorealistico di una ${roomType}:
STILE: ${stylesText}
COLORI: ${colorsText}
MATERIALI: ${materialsText}
ILLUMINAZIONE: ${lighting || 'mista'}
BUDGET: ${budget}
DIMENSIONI: ${size}

Requisiti: qualità 4K fotorealistica, illuminazione professionale, texture realistiche, arredamento coerente con lo stile scelto.`;

    console.log('🎨 Calling DALL-E 3...');

    const dalleResponse = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'hd'
    });

    const renderUrl = dalleResponse.data[0].url;
    const imageResponse = await fetch(renderUrl);
    const imageBuffer = await imageResponse.buffer();
    const imageName = `config-${roomType}-${Date.now()}.jpg`;
    const imagePath = path.join('uploads', imageName);

    await fs.mkdir('uploads', { recursive: true });
    await fs.writeFile(imagePath, imageBuffer);

    console.log('✅ Render generated');

    const render = new Render({
      clientId,
      adminId: req.adminId,
      title: `Configurazione ${roomType}`,
      description: `${roomType} - ${stylesText}`,
      imageUrl: `/${imagePath}`,
      imageFile: imageName,
      room: roomType,
      style: stylesText,
      colors: Array.isArray(colors) ? colors : [colors],
      materials: Array.isArray(materials) ? materials : [materials],
      lighting: lighting || 'mista',
      renderType: 'config',
      metadata: {
        roomType,
        size,
        budget,
        styles,
        colors,
        materials,
        lighting
      }
    });

    await render.save();

    console.log(`✅ Saved: ${render._id}`);

    res.json({
      success: true,
      data: {
        renderId: render._id,
        renderUrl: `/${imagePath}`,
        roomType,
        size,
        budget,
        description: `${roomType} in stile ${stylesText}`,
        createdAt: new Date()
      }
    });
  } catch (error) {
    console.error('❌ Configuratore Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get configurations
router.get('/configurations/:clientId', authenticate, async (req, res, next) => {
  try {
    const client = await Client.findOne({ _id: req.params.clientId, adminId: req.adminId });
    if (!client) {
      return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    }

    const configurations = await Render.find({
      clientId: req.params.clientId,
      renderType: 'config'
    }).sort({ createdAt: -1 });

    res.json({ success: true, data: configurations });
  } catch (error) {
    next(error);
  }
});

// Delete render
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const render = await Render.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });

    if (!render) {
      return res.status(404).json({ success: false, error: 'Render non trovato' });
    }

    if (render.imageFile) {
      await fs.unlink(path.join('uploads', render.imageFile)).catch(() => {});
    }

    res.json({ success: true, message: 'Render cancellato' });
  } catch (error) {
    next(error);
  }
});

export default router;
