import { pathToFileURL } from 'node:url';
import { BusinessStore } from '../config/businessStore.js';
import { AuthStore } from './authStore.js';

/**
 * CLI helper for the platform administrator to bootstrap the first `platform_admin`
 * or `business_owner` account securely in SQLite using `crypto.scrypt`.
 *
 * Usage:
 *   node src/auth/seedAdmin.js <email> <password> [role] [business_id]
 *
 * Examples:
 *   node src/auth/seedAdmin.js admin@nexora.ai StrongPass123! platform_admin
 *   node src/auth/seedAdmin.js owner@nexora-coffee.sa StrongPass123! business_owner nexora-coffee-sa
 */
export function seedUserAccount({
  email,
  password,
  role = 'platform_admin',
  businessId = null,
  dbPath = undefined,
}) {
  const businessStore = new BusinessStore();
  const authStore = new AuthStore({
    ...(dbPath ? { dbPath } : {}),
    businessStore,
  });

  try {
    const user = authStore.createUser({
      email,
      password,
      role,
      business_id: businessId,
    });
    return user;
  } finally {
    authStore.close();
  }
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const [, , email, password, role = 'platform_admin', businessId = null] =
    process.argv;

  if (!email || !password) {
    console.error(
      'Usage: node src/auth/seedAdmin.js <email> <password> [platform_admin|business_owner] [business_id]'
    );
    process.exit(1);
  }

  try {
    const created = seedUserAccount({ email, password, role, businessId });
    console.log('Successfully created user account:', created);
  } catch (err) {
    console.error(`[Seed Error] ${err.message}`);
    process.exit(1);
  }
}

