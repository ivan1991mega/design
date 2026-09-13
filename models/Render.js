import mongoose from 'mongoose';

const RenderSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  title: { type: String, required: true },
  description: String,
  imageUrl: { type: String, required: true },
  imageFile: String,
  room: String,
  style: String,
  materials: [String],
  colors: [String],
  lighting: String,
  renderType: { type: String, enum: ['image', 'dalle', 'config'], default: 'dalle' },
  displayOrder: { type: Number, default: 0 },
  isVisible: { type: Boolean, default: true },
  views: { type: Number, default: 0 },
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

RenderSchema.index({ clientId: 1, displayOrder: 1 });

export default mongoose.model('Render', RenderSchema);
