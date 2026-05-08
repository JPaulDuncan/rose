import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);
  // Index management is the worker's job (`syncAllIndexes()` at
  // worker boot). The API should not auto-create indexes — without
  // this disable, the API and worker race on first model use, both
  // hitting createIndex against the same collections. The result
  // is correct (Mongo dedups) but noisy.
  mongoose.set('autoIndex', false);
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ uri: env.MONGO_URI.replace(/\/\/.*@/, '//***@') }, 'mongo connected');
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
