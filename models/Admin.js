import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';

const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, minlength: 3, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6, select: false },
  firstName: String,
  companyName: String,
  totalClients: { type: Number, default: 0 },
  lastLogin: Date
}, { timestamps: true });

AdminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcryptjs.genSalt(10);
  this.password = await bcryptjs.hash(this.password, salt);
  next();
});

AdminSchema.methods.comparePassword = async function (password) {
  return bcryptjs.compare(password, this.password);
};

export default mongoose.model('Admin', AdminSchema);
