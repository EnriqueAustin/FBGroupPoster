/**
 * Garbage collection for data/media.
 *
 * POST /api/media writes a fresh <timestamp>-<name> file on every upload and
 * nothing ever removed one, so re-saving an ad (which re-uploads its images)
 * left the old copies behind forever. The runner's failure screenshots in
 * data/media/diagnostics pile up the same way.
 *
 * The rule this module exists to enforce: an image ANY variant points at is
 * never a candidate — inactive variants included. Deactivating a variant is a
 * "not right now", not a "throw it away", and reactivating one whose images
 * had been swept would post a broken ad.
 *
 * Deliberately never accepts file names from a caller to delete. The routes
 * recompute the candidate list server-side at the moment of cleanup, and
 * deleteMediaFiles() re-checks every path is directly inside the media dir, so
 * a crafted request (or a bug here) cannot reach outside it.
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../domain/contracts.ts';

export interface MediaFile {
  /** mediaDir joined with the file name, in the same form mediaDir was given. */
  path: string;
  bytes: number;
}

export const DIAGNOSTICS_SUBDIR = 'diagnostics';
export const DEFAULT_DIAGNOSTICS_DAYS = 30;

/**
 * Uploads younger than this are left alone even when nothing references them.
 * The editor uploads an image the moment it is picked, but the variant that
 * points at it only exists once the ad is SAVED — a cleanup in that window
 * would delete the image out from under the unsaved form.
 */
export const DEFAULT_UPLOAD_GRACE_MS = 60 * 60_000;

/**
 * A comparable key for a stored image path.
 *
 * Variants hold whatever path the upload returned: `data\media\123-x.png` when
 * the server ran on Windows, `data/media/123-x.png` on POSIX, sometimes an
 * absolute path. Backslashes are folded to forward slashes first so a Windows
 * path stored in the DB still matches when the tool runs on POSIX (where
 * path.resolve would treat `\` as part of the file name). Upload names are
 * sanitised to [\w.-], so no real file name contains a backslash. Windows file
 * systems are case-insensitive, so keys are lower-cased there.
 */
export function mediaKey(p: string, baseDir: string = process.cwd()): string {
  const resolved = path.resolve(baseDir, p.replace(/\\/g, '/'));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Every image path any variant of any ad references — active or not. */
export function referencedImagePaths(store: Store): string[] {
  const out: string[] = [];
  // ads.list() with no filter returns inactive ads too, and variants() without
  // activeOnly returns inactive variants — both are needed, see the header.
  for (const ad of store.ads.list()) {
    for (const v of store.ads.variants(ad.id)) out.push(...v.imagePaths);
  }
  return out;
}

/** Regular files directly in `dir`. Symlinks and subfolders are skipped, never followed. */
async function regularFiles(dir: string): Promise<Array<MediaFile & { mtimeMs: number; name: string }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    // No uploads yet means nothing to clean, not an error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<MediaFile & { mtimeMs: number; name: string }> = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    // lstat, not stat: a symlink in data/media pointing elsewhere must not be
    // treated as (or lead to) a file we own.
    const st = await lstat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    out.push({ path: full, bytes: st.size, mtimeMs: st.mtimeMs, name });
  }
  return out;
}

export interface FindUnusedOptions {
  mediaDir: string;
  /** Raw image paths from variants, in any of the stored forms. */
  referenced: Iterable<string>;
  /** What relative referenced paths are relative to. Defaults to the cwd. */
  baseDir?: string;
  now?: number;
  graceMs?: number;
}

/** Top-level files in the media dir that no variant references. */
export async function findUnusedMedia(opts: FindUnusedOptions): Promise<MediaFile[]> {
  const baseDir = opts.baseDir ?? process.cwd();
  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? DEFAULT_UPLOAD_GRACE_MS;
  const keep = new Set<string>();
  for (const p of opts.referenced) keep.add(mediaKey(p, baseDir));

  return (await regularFiles(opts.mediaDir))
    .filter((f) => !keep.has(mediaKey(f.path, baseDir)))
    .filter((f) => now - f.mtimeMs >= grace)
    .map(({ path: p, bytes }) => ({ path: p, bytes }));
}

export interface FindDiagnosticsOptions {
  mediaDir: string;
  olderThanDays?: number;
  now?: number;
}

/** Failure screenshots and notes in media/diagnostics older than N days. */
export async function findOldDiagnostics(opts: FindDiagnosticsOptions): Promise<MediaFile[]> {
  const days = opts.olderThanDays ?? DEFAULT_DIAGNOSTICS_DAYS;
  const cutoff = (opts.now ?? Date.now()) - days * 86_400_000;
  return (await regularFiles(path.join(opts.mediaDir, DIAGNOSTICS_SUBDIR)))
    .filter((f) => f.mtimeMs < cutoff)
    .map(({ path: p, bytes }) => ({ path: p, bytes }));
}

export interface DeleteResult {
  deleted: number;
  bytes: number;
  /** Paths that were refused (outside the media dir) or failed to unlink. */
  skipped: string[];
}

/**
 * Delete files that must sit DIRECTLY in the media dir or its diagnostics
 * folder. Anything else is skipped and reported, not deleted — the find*
 * functions never produce such a path, so seeing one means a bug upstream.
 */
export async function deleteMediaFiles(mediaDir: string, files: MediaFile[]): Promise<DeleteResult> {
  const root = path.resolve(mediaDir);
  const allowed = new Set([root, path.join(root, DIAGNOSTICS_SUBDIR)].map((d) => mediaKey(d)));
  const result: DeleteResult = { deleted: 0, bytes: 0, skipped: [] };
  for (const f of files) {
    const full = path.resolve(f.path);
    if (!allowed.has(mediaKey(path.dirname(full)))) { result.skipped.push(f.path); continue; }
    // Re-check at delete time: it must still be a plain file, not something
    // swapped for a symlink since the listing.
    const st = await lstat(full).catch(() => null);
    if (!st || !st.isFile()) { result.skipped.push(f.path); continue; }
    try {
      await unlink(full);
      result.deleted += 1;
      result.bytes += st.size;
    } catch {
      // Typically a file still open in an image viewer on Windows. Leave it
      // for next time rather than failing the whole sweep.
      result.skipped.push(f.path);
    }
  }
  return result;
}
