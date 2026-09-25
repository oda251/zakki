export const FILE_RETENTIONS = ["permanent", "1d", "7d", "30d"] as const;
export type FileRetention = (typeof FILE_RETENTIONS)[number];
export const PERMANENT_MAX_BYTES = 10 * 1024 ** 2;
