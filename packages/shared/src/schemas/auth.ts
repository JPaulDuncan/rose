import { z } from 'zod';

export const RegisterRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const PublicUser = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  settings: z
    .object({
      defaultGenerationModel: z.string().default('llama3.1:8b-instruct'),
      defaultEmbeddingModel: z.string().default('nomic-embed-text'),
      theme: z.enum(['light', 'dark', 'system']).default('system'),
    })
    .default({
      defaultGenerationModel: 'llama3.1:8b-instruct',
      defaultEmbeddingModel: 'nomic-embed-text',
      theme: 'system',
    }),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const AuthResponse = z.object({
  user: PublicUser,
  accessToken: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;
