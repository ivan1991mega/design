import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

export const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, error: 'No token' });

    const decoded = jwt.verify(token, JWT_SECRET);
    req.adminId = decoded.id;
    req.admin = decoded;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

export const generateToken = (adminId) => {
  return jwt.sign({ id: adminId }, JWT_SECRET, { expiresIn: '30d' });
};

export const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Errore server';
  res.status(status).json({ success: false, error: message });
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
};
