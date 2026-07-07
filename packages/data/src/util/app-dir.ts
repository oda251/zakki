/**
 * XDG ディレクトリ配下に作るアプリ用サブディレクトリ名の SSOT（issue #56）。
 * 例: `<dataHome>/zakki/zakki.sqlite`（db/connect.ts）、`<configHome>/zakki/keyfile`
 * （crypto/keyfile.ts）、`<configHome>/zakki/identity.json`（identity/local.ts）、
 * anco/zenz の既定パス（backend/anco/engine.ts）。
 *
 * util/paths.ts（homedir 依存）から分離し、定数だけを使う DB アダプタ等が
 * node:os へ到達しないようにしている（issue #29）。
 */
export const APP_DIR = "zakki";
