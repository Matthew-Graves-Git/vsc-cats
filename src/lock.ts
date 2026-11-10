import * as fs from 'fs';
import * as path from 'path';

/** A PID-based lock so only one VS Code window drives the shared browser profile. */
export class OwnerLock {
  private file: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'owner.lock');
  }

  /** Returns true if this process now owns the lock. */
  acquire(): boolean {
    try {
      const existing = parseInt(fs.readFileSync(this.file, 'utf8'), 10);
      if (existing && existing !== process.pid && isAlive(existing)) {
        return false;
      }
    } catch {
      // no lock file yet
    }
    fs.writeFileSync(this.file, String(process.pid));
    return true;
  }

  /** True if another live process (another VS Code window) owns the lock. */
  isHeldByOther(): boolean {
    try {
      const existing = parseInt(fs.readFileSync(this.file, 'utf8'), 10);
      return !!existing && existing !== process.pid && isAlive(existing);
    } catch {
      return false;
    }
  }

  release(): void {
    try {
      const existing = parseInt(fs.readFileSync(this.file, 'utf8'), 10);
      if (existing === process.pid) {
        fs.unlinkSync(this.file);
      }
    } catch {
      // ignore
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}
