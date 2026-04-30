export type ApiError = {
  error: string;
  message: string;
  details?: unknown;
};

export type JobProgressEvent =
  | { type: 'queued'; jobId: string }
  | { type: 'started'; jobId: string }
  | { type: 'token'; jobId: string; token: string }
  | { type: 'log'; jobId: string; message: string }
  | { type: 'partial'; jobId: string; field: string; value: string }
  | { type: 'completed'; jobId: string; pageId?: string }
  | { type: 'failed'; jobId: string; error: string };

export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `page-${Date.now().toString(36)}`;
