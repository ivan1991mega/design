export const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Errore server';
  res.status(status).json({ success: false, error: message });
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({ success: false, error: 'Route non trovata' });
};
