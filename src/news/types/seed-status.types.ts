export type SeedStatus =
  | { status: 'idle' }
  | { status: 'running'; startedAt: Date }
  | { status: 'done'; startedAt: Date; finishedAt: Date; inserted: number }
  | { status: 'error'; startedAt: Date; error: string };
