import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ uri: env.MONGO_URI.replace(/\/\/.*@/, '//***@') }, 'mongo connected');
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
