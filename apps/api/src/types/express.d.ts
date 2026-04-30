import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `requireAuth` middleware after JWT verification. */
    userId?: string;
  }
}

export {};
