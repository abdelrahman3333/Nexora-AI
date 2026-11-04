import crypto from 'node:crypto';
import { ValidationError } from '../utils/errors.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N = 2^14
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

/**
 * Validates that a password meets minimum security requirements.
 *
 * @param {unknown} password
 */
export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError(
      'Password must be at least 8 characters long.',
      'WEAK_PASSWORD'
    );
  }
  if (password.length > 128) {
    throw new ValidationError(
      'Password must not exceed 128 characters.',
      'INVALID_PASSWORD'
    );
  }
}

/**
 * Hashes a plaintext password using Node.js built-in `crypto.scryptSync` with a random 16-byte salt.
 * Format: `scrypt$<saltHex>$<derivedKeyHex>`
 *
 * @param {string} plainPassword
 * @returns {string}
 */
export function hashPassword(plainPassword) {
  validatePasswordStrength(plainPassword);
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });

  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plaintext password against a stored `crypto.scrypt` hash using constant-time comparison.
 *
 * @param {string} plainPassword
 * @param {string} storedHash
 * @returns {boolean}
 */
export function verifyPassword(plainPassword, storedHash) {
  if (
    typeof plainPassword !== 'string' ||
    typeof storedHash !== 'string' ||
    !plainPassword ||
    !storedHash
  ) {
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, salt, keyHex] = parts;
  if (!salt || !keyHex) {
    return false;
  }

  const storedBuffer = Buffer.from(keyHex, 'hex');
  if (storedBuffer.length !== SCRYPT_KEYLEN) {
    return false;
  }

  const derivedBuffer = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });

  return crypto.timingSafeEqual(storedBuffer, derivedBuffer);
}

