// Downloads the surf and rain GIFs from the public GitHub repo into a cache in VS Code's global
// storage (laid out like the repo's media/gifs), and keeps that cache in step with the repo.
//
// One tree listing (with an ETag, so an unchanged repo costs nothing against GitHub's rate limit)
// says which files exist and their git blob shas; files that are missing or changed are fetched
// from raw.githubusercontent.com by a small priority queue:
//   0: a cat that just spawned (ensure / ensureCat)
//   1: the shared storm and every surf set
//   2: the rain sets (moved to 1 while a rain is on: boostRain)
// Each clip's length is worked out from the downloaded bytes and kept in the manifest, so spawns
// never read a GIF from disk.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { catPrefix, gifDurationFromBuffer, primeDuration, rainFiles, RAIN_DIR, resetGifCache, sceneFiles, surfFiles } from './gifs';

const OWNER = 'Matthew-Graves-Git';
const REPO = 'vsc_cat_extension';
const BRANCH = 'main';
const PREFIX = 'gifs/';
const TREE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${PREFIX}`;
const HEADERS = { 'User-Agent': 'cat-yoink' };
const WORKERS = 4;
const RETRIES = 2;
/** Leftover .part files older than this are from a download that died. */
const STALE_PART_MS = 60 * 60_000;

interface Manifest {
  etag?: string;
  /** The repo's GIFs (relative to media/gifs, "/" separated) at the last listing. */
  remote: Record<string, { sha: string; size: number }>;
  /** The cached GIFs: the blob sha they were downloaded at, and their length. */
  local: Record<string, { sha: string; ms: number }>;
}

interface Job {
  rel: string;
  prio: number;
  waiters: (() => void)[];
}

const log = (...a: unknown[]) => console.log('[cat-yoink gifs]', ...a);

/** Git's blob id for these bytes, as in the tree listing. */
function blobSha(b: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

const sceneSet = new Set(sceneFiles());
const basePrio = (rel: string) => (rel.startsWith(`${RAIN_DIR}/`) && !sceneSet.has(rel) ? 2 : 1);

export class GifSync {
  /** The cached gif folder: pass it to surfSet / rainSet / rainScene. */
  readonly dir: string;
  /** Downloads done / queued since the queue was last empty. */
  onProgress?: (done: number, total: number) => void;

  private readonly manifestFile: string;
  private manifest: Manifest;
  private readonly queue: Job[] = [];
  private readonly jobs = new Map<string, Job>();
  private running = 0;
  private done = 0;
  private total = 0;
  private rainBoost = false;
  private disposed = false;
  private readonly abort = new AbortController();
  private listed: Promise<void> | undefined;

  constructor(storageDir: string) {
    this.dir = path.join(storageDir, 'gifs');
    this.manifestFile = path.join(this.dir, 'manifest.json');
    this.manifest = this.readManifest();
    for (const [rel, e] of Object.entries(this.manifest.local)) {
      primeDuration(this.file(rel), e.ms);
    }
  }

  /** Lists the repo, tidies the cache, and starts the background prefetch. */
  start(): Promise<void> {
    this.listed ??= this.list().catch((err) => log('listing failed; using the cache as it is:', String(err)));
    return this.listed;
  }

  /** Fetches `rels` (relative to the gif folder) ahead of everything else; resolves once they are done or failed. */
  async ensure(rels: string[]): Promise<void> {
    await this.start();
    await Promise.all(rels.filter((rel) => this.needs(rel)).map((rel) => this.enqueue(rel, 0)));
  }

  /**
   * Fetches the clips `word`'s cat needs for `kind` ahead of everything else. Resolves true if any
   * of them was missing and has now been downloaded.
   */
  async ensureCat(kind: 'surf' | 'rain', word: string): Promise<boolean> {
    await this.start();
    const w = word.toLowerCase();
    const first = Object.keys(this.manifest.remote).find((rel) => catPrefix(kind, rel)?.toLowerCase() === w);
    const prefix = first && catPrefix(kind, first);
    if (!prefix) {
      return false; // no GIFs for this cat in the repo
    }
    const rels = kind === 'surf' ? surfFiles(prefix) : rainFiles(prefix);
    const missing = rels.filter((rel) => this.needs(rel));
    if (!missing.length) {
      return false;
    }
    await this.ensure(missing);
    return missing.every((rel) => !this.needs(rel));
  }

  /** A cat rain is on: its clips are next after the surf sets, not last. */
  boostRain(): void {
    if (this.rainBoost) {
      return;
    }
    this.rainBoost = true;
    for (const j of this.queue) {
      if (j.prio === 2) {
        j.prio = 1;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const j of this.queue.splice(0)) {
      j.waiters.forEach((w) => w());
    }
  }

  // ---------- listing ----------

  private async list(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const headers: Record<string, string> = { ...HEADERS, Accept: 'application/vnd.github+json' };
    if (this.manifest.etag && Object.keys(this.manifest.remote).length) {
      headers['If-None-Match'] = this.manifest.etag;
    }
    let listedOk = false;
    try {
      const res = await fetch(TREE_URL, { headers, signal: this.abort.signal });
      if (res.status === 304) {
        log('repo unchanged since the last listing');
        listedOk = true;
      } else if (res.ok) {
        const body = (await res.json()) as { tree?: { path: string; type: string; sha: string; size?: number }[]; truncated?: boolean };
        const remote: Manifest['remote'] = {};
        for (const t of body.tree ?? []) {
          if (t.type === 'blob' && t.path.startsWith(PREFIX) && /\.gif$/i.test(t.path)) {
            remote[t.path.slice(PREFIX.length)] = { sha: t.sha, size: t.size ?? -1 };
          }
        }
        this.manifest.remote = remote;
        this.manifest.etag = res.headers.get('etag') ?? undefined;
        listedOk = !body.truncated;
        this.saveManifest();
      } else {
        log(`listing failed: HTTP ${res.status}`);
      }
    } catch (err) {
      if (this.disposed) {
        return;
      }
      log('listing failed (offline?):', String(err));
    }
    if (this.disposed) {
      return;
    }
    if (listedOk) {
      this.tidy();
    }
    const want = Object.keys(this.manifest.remote).filter((rel) => this.needs(rel));
    want.sort((a, b) => basePrio(a) - basePrio(b));
    for (const rel of want) {
      void this.enqueue(rel, this.rainBoost ? 1 : basePrio(rel));
    }
    if (want.length) {
      log(`${want.length} GIFs to download`);
    }
  }

  /**
   * Adopts GIFs already on disk that the manifest doesn't know (another window wrote them, or the
   * manifest was lost), and deletes ones the repo no longer has and dead .part files.
   */
  private tidy(): void {
    const remote = this.manifest.remote;
    const walk = (sub: string) => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(path.join(this.dir, sub), { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        const rel = sub ? `${sub}/${d.name}` : d.name;
        const abs = this.file(rel);
        if (d.isDirectory()) {
          walk(rel);
        } else if (d.name.endsWith('.part')) {
          try {
            if (Date.now() - fs.statSync(abs).mtimeMs > STALE_PART_MS) {
              fs.unlinkSync(abs);
            }
          } catch {
            // being written, or already gone
          }
        } else if (/\.gif$/i.test(d.name)) {
          if (!remote[rel]) {
            this.remove(rel);
          } else if (this.manifest.local[rel]?.sha !== remote[rel].sha) {
            this.adopt(rel);
          }
        }
      }
    };
    walk('');
    for (const rel of Object.keys(this.manifest.local)) {
      if (!remote[rel] || !fs.existsSync(this.file(rel))) {
        delete this.manifest.local[rel];
      }
    }
    this.saveManifest();
  }

  /** Records a file on disk as cached if its bytes match the repo's. */
  private adopt(rel: string): void {
    try {
      const b = fs.readFileSync(this.file(rel));
      if (blobSha(b) === this.manifest.remote[rel].sha) {
        const ms = gifDurationFromBuffer(b);
        this.manifest.local[rel] = { sha: this.manifest.remote[rel].sha, ms };
        primeDuration(this.file(rel), ms);
      }
    } catch {
      // unreadable: it is downloaded again
    }
  }

  private remove(rel: string): void {
    try {
      fs.unlinkSync(this.file(rel));
    } catch {
      // in use or gone
    }
    delete this.manifest.local[rel];
    primeDuration(this.file(rel), 0);
    resetGifCache();
  }

  // ---------- queue ----------

  private needs(rel: string): boolean {
    const r = this.manifest.remote[rel];
    return !!r && (this.manifest.local[rel]?.sha !== r.sha || !fs.existsSync(this.file(rel)));
  }

  /** Queues `rel` (or raises its priority if it is queued already); resolves when it is done or failed. */
  private enqueue(rel: string, prio: number): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let job = this.jobs.get(rel);
      if (job) {
        job.prio = Math.min(job.prio, prio);
      } else {
        job = { rel, prio, waiters: [] };
        this.jobs.set(rel, job);
        this.queue.push(job);
        this.total++;
      }
      job.waiters.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    while (!this.disposed && this.running < WORKERS && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].prio < this.queue[best].prio) {
          best = i;
        }
      }
      const [job] = this.queue.splice(best, 1);
      this.running++;
      void this.download(job.rel).finally(() => {
        this.running--;
        this.jobs.delete(job.rel);
        this.done++;
        job.waiters.forEach((w) => w());
        this.progress();
        this.pump();
      });
    }
  }

  private progress(): void {
    if (this.disposed) {
      return;
    }
    const idle = !this.running && !this.queue.length;
    this.onProgress?.(idle ? this.total : this.done, this.total);
    if (idle) {
      if (this.total) {
        log(`downloads finished (${this.total})`);
      }
      this.done = this.total = 0;
    }
  }

  private async download(rel: string): Promise<void> {
    const r = this.manifest.remote[rel];
    if (!r) {
      return;
    }
    const url = RAW_URL + rel.split('/').map(encodeURIComponent).join('/');
    for (let attempt = 0; attempt <= RETRIES && !this.disposed; attempt++) {
      if (attempt) {
        await new Promise((res) => setTimeout(res, 1_000 * 2 ** attempt));
      }
      try {
        const res = await fetch(url, { headers: HEADERS, signal: this.abort.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const b = Buffer.from(await res.arrayBuffer());
        if (blobSha(b) !== r.sha) {
          throw new Error('content does not match the repo listing');
        }
        const abs = this.file(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const part = `${abs}.${process.pid}.part`;
        fs.writeFileSync(part, b);
        try {
          fs.renameSync(part, abs);
        } catch (err) {
          fs.rmSync(part, { force: true });
          throw err;
        }
        const ms = gifDurationFromBuffer(b);
        this.manifest.local[rel] = { sha: r.sha, ms };
        primeDuration(abs, ms);
        resetGifCache();
        this.saveManifest();
        return;
      } catch (err) {
        if (this.disposed) {
          return;
        }
        log(`download of ${rel} failed (try ${attempt + 1}/${RETRIES + 1}):`, String(err));
      }
    }
  }

  // ---------- manifest ----------

  private file(rel: string): string {
    return path.join(this.dir, ...rel.split('/'));
  }

  private readManifest(): Manifest {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8')) as Partial<Manifest>;
      return { etag: m.etag, remote: m.remote ?? {}, local: m.local ?? {} };
    } catch {
      return { remote: {}, local: {} };
    }
  }

  /** Writes the manifest, keeping files another VS Code window cached meanwhile. */
  private saveManifest(): void {
    try {
      const disk = this.readManifest();
      for (const [rel, e] of Object.entries(disk.local)) {
        const r = this.manifest.remote[rel];
        if (!this.manifest.local[rel] && r && r.sha === e.sha && fs.existsSync(this.file(rel))) {
          this.manifest.local[rel] = e;
          primeDuration(this.file(rel), e.ms);
        }
      }
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.manifestFile}.${process.pid}.part`;
      fs.writeFileSync(tmp, JSON.stringify(this.manifest));
      fs.renameSync(tmp, this.manifestFile);
    } catch (err) {
      log('could not save the manifest:', String(err));
    }
  }
}
