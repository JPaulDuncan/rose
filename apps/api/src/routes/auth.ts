import { Router } from 'express';
import argon2 from 'argon2';
import cookieParser from 'cookie-parser';
import { LoginRequest, RegisterRequest, type PublicUser } from '@rose/shared';
import { User, type UserDoc } from '@rose/db';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { env } from '../lib/env.js';
import { seedSystemInstructionsForUser } from '../services/instructions.js';

export const authRouter: Router = Router();
authRouter.use(cookieParser());

function toPublic(u: UserDoc): PublicUser {
  return {
    id: u._id.toString(),
    email: u.email,
    displayName: u.displayName,
    settings: {
      defaultGenerationModel: u.settings?.defaultGenerationModel ?? 'llama3.1:8b-instruct',
      defaultEmbeddingModel: u.settings?.defaultEmbeddingModel ?? 'nomic-embed-text',
      theme: (u.settings?.theme as 'light' | 'dark' | 'system') ?? 'system',
    },
    createdAt: (u as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

function setRefreshCookie(res: import('express').Response, token: string) {
  res.cookie('rose_refresh', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

authRouter.post('/register', authLimiter, validateBody(RegisterRequest), async (req, res) => {
  if (!env.ENABLE_REGISTRATION) {
    res.status(403).json({ error: 'forbidden', message: 'Registration is disabled' });
    return;
  }
  const { email, password, displayName } = req.body as typeof RegisterRequest._type;
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    res.status(409).json({ error: 'conflict', message: 'Email already registered' });
    return;
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await User.create({ email: email.toLowerCase(), passwordHash, displayName });
  await seedSystemInstructionsForUser(user._id);
  const access = signAccessToken(user._id.toString());
  const refresh = signRefreshToken(user._id.toString());
  setRefreshCookie(res, refresh);
  res.json({ user: toPublic(user), accessToken: access });
});

authRouter.post('/login', authLimiter, validateBody(LoginRequest), async (req, res) => {
  const { email, password } = req.body as typeof LoginRequest._type;
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
    return;
  }
  const ok = await argon2.verify(user.passwordHash, password);
  if (!ok) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid credentials' });
    return;
  }
  const access = signAccessToken(user._id.toString());
  const refresh = signRefreshToken(user._id.toString());
  setRefreshCookie(res, refresh);
  res.json({ user: toPublic(user), accessToken: access });
});

authRouter.post('/refresh', async (req, res) => {
  const token = (req.cookies as Record<string, string>)?.rose_refresh;
  if (!token) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing refresh token' });
    return;
  }
  try {
    const { sub } = verifyRefreshToken(token);
    const user = await User.findById(sub);
    if (!user) throw new Error('User not found');
    const access = signAccessToken(sub);
    const refresh = signRefreshToken(sub);
    setRefreshCookie(res, refresh);
    res.json({ user: toPublic(user), accessToken: access });
  } catch {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid refresh token' });
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('rose_refresh', { path: '/api/auth' });
  res.json({ ok: true });
});
