import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const ClientSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, default: '', lowercase: true, trim: true },
  phone: String,
  address: {
    street: String,
    city: String,
    province: String,
    zipCode: String
  },
  company: String,
  vat: String,
  projectName: String,
  projectDescription: String,
  projectType: {
    type: String,
    enum: ['residential', 'commercial', 'hospitality', 'retail', 'other'],
    default: 'residential'
  },
  shareLink: { type: String, default: () => uuidv4(), unique: true },
  isPublished: { type: Boolean, default: false },
  rendersCount: { type: Number, default: 0 },
  notes: String,
  status: { type: String, enum: ['active', 'archived'], default: 'active' }
}, { timestamps: true });

export default mongoose.model('Client', ClientSchema);
