import express from 'express';
import mongoose from 'mongoose';
import Client from '../models/Client.js';
import Render from '../models/Render.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    const query = { adminId: req.adminId };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { projectName: { $regex: search, $options: 'i' } }
      ];
    }

    const [clients, total] = await Promise.all([
      Client.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Client.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        clients,
        pagination: { total, pages: Math.ceil(total / limit) || 1, current: page }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, email, phone, address, company, projectName, projectType } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Nome cliente obbligatorio' });
    }

    const client = await Client.create({
      adminId: req.adminId,
      name: String(name).trim(),
      email: email || '',
      phone: phone || '',
      address: address || {},
      company: company || '',
      projectName: projectName || '',
      projectType: projectType || 'residential'
    });

    res.status(201).json({ success: true, data: client });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, error: 'ID non valido' });
    }
    const client = await Client.findOne({ _id: req.params.id, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    res.json({ success: true, data: client });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const forbidden = ['adminId', '_id'];
    const updates = { ...req.body };
    forbidden.forEach((k) => delete updates[k]);

    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, adminId: req.adminId },
      updates,
      { new: true, runValidators: true }
    );
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    res.json({ success: true, data: client });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const client = await Client.findOneAndDelete({ _id: req.params.id, adminId: req.adminId });
    if (!client) return res.status(404).json({ success: false, error: 'Cliente non trovato' });
    await Render.deleteMany({ clientId: req.params.id });
    res.json({ success: true, message: 'Cliente cancellato' });
  } catch (error) {
    next(error);
  }
});

export default router;
