import type { FileDoc } from "@zakki/web/client/db/database.ts";
import type { GraphNode } from "@zakki/web/shared/api-types.ts";

const RETENTION_LABELS: Record<FileDoc["retention"], string> = {
  permanent: "無期限",
  "1d": "1日",
  "7d": "7日",
  "30d": "30日",
};

const RETENTION_DAYS: Record<Exclude<FileDoc["retention"], "permanent">, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  txt: "text/plain",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export function fileLabel(file: FileDoc): string {
  return file.extension === "" ? file.name : `${file.name}.${file.extension}`;
}

export function retentionLabel(retention: FileDoc["retention"]): string {
  return RETENTION_LABELS[retention];
}

export function isFileExpired(file: FileDoc, now: number): boolean {
  if (file.retention === "permanent") return false;
  const expiresAt = Date.parse(file.updatedAt) + RETENTION_DAYS[file.retention] * 86_400_000;
  return now >= expiresAt;
}

export function graphNodeLabel(node: GraphNode, files: ReadonlyMap<string, FileDoc>): string {
  if (node.kind !== "blob") return node.content;
  if (node.fileId === null || node.fileId === undefined) return "ファイル";
  const file = files.get(node.fileId);
  return file === undefined ? "ファイル" : fileLabel(file);
}

export function mimeTypeForFile(file: FileDoc): string {
  return MIME_TYPES[file.extension.toLowerCase()] ?? "application/octet-stream";
}
