import express from 'express';
import Admin from '../models/Admin.js';
import Client from '../models/Client.js';
import Render from '../models/Render.js';
import { authenticate, generateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username e password obbligatori' });
    }

    const admin = await Admin.findOne({ username }).select('+password');
    if (!admin) {
      return res.status(401).json({ success: false, error: 'Credenziali non valide' });
    }

    const isValid = await admin.comparePassword(password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Credenziali non valide' });
    }

    admin.lastLogin = new Date();
    await admin.save();

    const token = generateToken(admin._id);
    res.json({
      success: true,
      data: {
        token,
        admin: {
          _id: admin._id,
          username: admin.username,
          email: admin.email,
          firstName: admin.firstName,
          companyName: admin.companyName
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/profile', authenticate, async (req, res, next) => {
  try {
    const admin = await Admin.findById(req.adminId);
    if (!admin) return res.status(404).json({ success: false, error: 'Admin non trovato' });
    res.json({ success: true, data: admin });
  } catch (error) {
    next(error);
  }
});

router.get('/stats', authenticate, async (req, res, next) => {
  try {
    const [totalClients, totalRenders, aiRenders, activeClients] = await Promise.all([
      Client.countDocuments({ adminId: req.adminId }),
      Render.countDocuments({ adminId: req.adminId }),
      Render.countDocuments({ adminId: req.adminId, renderType: 'dalle' }),
      Client.countDocuments({ adminId: req.adminId, status: 'active' })
    ]);

    res.json({
      success: true,
      data: { totalClients, totalRenders, aiRenders, activeClients }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
