import jwt from 'jsonwebtoken';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET mancante o troppo corto (min 16 caratteri)');
    }
    return 'dev-only-insecure-secret-change-me';
  }
  return secret;
}

export const authenticate = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ success: false, error: 'Token mancante' });
    }
    const decoded = jwt.verify(token, getJwtSecret());
    req.adminId = decoded.id;
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token non valido' });
  }
};

export const generateToken = (adminId) => {
  return jwt.sign({ id: adminId }, getJwtSecret(), { expiresIn: '30d' });
};
