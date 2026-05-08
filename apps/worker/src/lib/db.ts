import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);
  // Disable Mongoose's per-model autoIndex now that the explicit
  // `syncAllIndexes()` migration runs at boot. Without this, every
  // model would call `ensureIndexes` on first use and double-create
  // the same indexes the migration just synced. With autoIndex off,
  // index management is a single, observable step at startup.
  mongoose.set('autoIndex', false);
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
}
