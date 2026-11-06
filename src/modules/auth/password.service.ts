import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core/config/config.service.js';
import { ARGON2_LIMITS } from '../../core/config/security-limits.js';

const argon2Async = promisify(argon2);

interface Argon2Params {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

/** Output and salt sizes in bytes: fixed by the algorithm's recommendations, not tunable. */
const TAG_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(
  password: string,
  salt: Buffer,
  params: Argon2Params,
): Promise<Buffer> {
  return argon2Async('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    memory: params.memoryKiB,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength: TAG_LENGTH,
  });
}

interface ParsedHash extends Argon2Params {
  salt: Buffer;
  tag: Buffer;
}

function parsePhc(stored: string): ParsedHash | undefined {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(
      stored,
    );
  if (!match) return undefined;
  const [, m, t, p, salt, tag] = match;
  const memoryKiB = Number(m);
  const passes = Number(t);
  const parallelism = Number(p);
  // Bounds stop a corrupted or hostile row from requesting gigabytes of memory.
  const { memoryKiB: mem, passes: pass, parallelism: lanes } = ARGON2_LIMITS;
  if (
    memoryKiB < Math.max(mem.min, 8 * parallelism) ||
    memoryKiB > mem.max ||
    passes < pass.min ||
    passes > pass.max ||
    parallelism < lanes.min ||
    parallelism > lanes.max
  ) {
    return undefined;
  }
  return {
    memoryKiB,
    passes,
    parallelism,
    salt: Buffer.from(salt as string, 'base64'),
    tag: Buffer.from(tag as string, 'base64'),
  };
}

/**
 * Password hashing with argon2id from Node's own crypto module (no native add-on to build).
 * Stored as a standard PHC string: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, so the
 * parameters travel with the hash and can be raised later without breaking old hashes.
 */
@Injectable()
export class PasswordService {
  private readonly params: Argon2Params;

  constructor(config: AppConfigService) {
    this.params = {
      memoryKiB: config.get('PASSWORD_HASH_MEMORY_KIB'),
      passes: config.get('PASSWORD_HASH_PASSES'),
      parallelism: config.get('PASSWORD_HASH_PARALLELISM'),
    };
  }

  /** A real hash of a random password, used to spend equal time when the account is unknown. */
  private dummyHash?: Promise<string>;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const tag = await derive(password, salt, this.params);
    const { memoryKiB, passes, parallelism } = this.params;
    return `$argon2id$v=19$m=${memoryKiB},t=${passes},p=${parallelism}$${salt.toString('base64')}$${tag.toString('base64')}`;
  }

  /** Never throws on a malformed stored hash: that is simply "does not match". */
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parsePhc(stored);
    if (!parsed) return false;
    const candidate = await derive(password, parsed.salt, parsed);
    return (
      candidate.length === parsed.tag.length &&
      timingSafeEqual(candidate, parsed.tag)
    );
  }

  /**
   * Burns the same CPU as a real verification. Call it when the account does not exist, so
   * response time does not reveal which emails are registered.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(password, await this.dummyHash);
    return false;
  }
}
