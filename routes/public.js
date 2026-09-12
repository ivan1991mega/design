import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'OK',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

export default router;
