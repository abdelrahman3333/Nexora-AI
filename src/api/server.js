import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter } from '../middleware/rateLimiter.js';
import { UsageStore } from '../analytics/usageStore.js';
import { RateLimitError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

export const SESSION_COOKIE_NAME = 'nexora_session';
const MAX_BODY_BYTES = 64 * 1024; // 64 KB max JSON payload

/**
 * Parses HTTP request `Cookie` header into a plain key-value object.
 *
 * @param {string | undefined} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
  const cookies = Object.create(null);
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return cookies;
  }

  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Builds a Set-Cookie header string for the `nexora_session` cookie.
 *
 * @param {string} sessionId
 * @param {object} options
 * @param {number} options.maxAgeSeconds
 * @param {boolean} options.isProduction
 * @returns {string}
 */
export function serializeSessionCookie(
  sessionId,
  { maxAgeSeconds = 86400, isProduction = false } = {}
) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];

  if (isProduction) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

/**
 * Constant-time comparison for CSRF tokens.
 *
 * @param {string} headerToken
 * @param {string} sessionCsrfToken
 * @returns {boolean}
 */
function verifyCsrfToken(headerToken, sessionCsrfToken) {
  if (
    typeof headerToken !== 'string' ||
    typeof sessionCsrfToken !== 'string' ||
    !headerToken ||
    !sessionCsrfToken
  ) {
    return false;
  }

  const bufA = Buffer.from(headerToken);
  const bufB = Buffer.from(sessionCsrfToken);
  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Reads and parses a JSON request body safely with a strict size limit.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(
          new ValidationError(
            'Request payload is too large.',
            'PAYLOAD_TOO_LARGE'
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('Invalid JSON payload.', 'INVALID_JSON'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';",
});

/**
 * Sends a structured JSON HTTP response with security headers.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serves static files from the `public/` directory for the web dashboard.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {boolean} True if file was served or handled
 */
function serveStaticFile(req, res, pathname) {
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  // Security: Prevent directory traversal or accessing hidden/dotfiles - return 404 immediately
  const baseFilename = path.basename(relativePath);
  if (!filePath.startsWith(PUBLIC_DIR) || baseFilename.startsWith('.')) {
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    });
    res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'File not found.' }));
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(content);
    return true;
  }

  // SPA fallback only for valid clean client routes (e.g. /overview, /products)
  if (!pathname.startsWith('/api/') && !path.extname(pathname) && req.method === 'GET') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...SECURITY_HEADERS,
      });
      res.end(content);
      return true;
    }
  }

  // For unknown static asset paths with extensions (e.g. /missing.png)
  if (path.extname(pathname)) {
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    });
    res.end(JSON.stringify({ error: 'NOT_FOUND', message: 'File not found.' }));
    return true;
  }

  return false;
}

/**
 * Creates the Nexora AI Phase 1 Web Dashboard Authentication & REST API Server.
 *
 * @param {object} options
 * @param {import('../auth/authStore.js').AuthStore} options.authStore
 * @param {import('../config/businessStore.js').BusinessStore} options.businessStore
 * @param {RateLimiter} [options.loginRateLimiter]
 * @param {boolean} [options.isProduction=false]
 * @param {import('pino').Logger} [options.log]
 */
export function createApiServer({
  authStore,
  businessStore,
  botRegistry = null,
  usageStore = null,
  loginRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 5 }),
  isProduction = process.env.NODE_ENV === 'production',
  log = logger,
}) {
  if (!authStore || !businessStore) {
    throw new Error('createApiServer requires authStore and businessStore');
  }

  const resolvedUsageStore =
    usageStore || (authStore?.db ? new UsageStore({ db: authStore.db, log }) : null);

  const requestHandler = async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const urlObj = new URL(req.url || '/', 'http://localhost');
    const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';

    // Static frontend assets routing
    if (!pathname.startsWith('/api/') && pathname !== '/api' && (method === 'GET' || method === 'HEAD')) {
      if (serveStaticFile(req, res, pathname)) {
        return;
      }
    }

    try {
      // --- Public Registration Explicitly Disabled ---
      if (
        pathname === '/api/auth/register' ||
        pathname === '/api/auth/signup'
      ) {
        return sendJson(res, 403, {
          error: 'PUBLIC_REGISTRATION_DISABLED',
          message:
            'Public registration is disabled. Accounts must be provisioned by the platform administrator.',
        });
      }

      // --- 1. POST /api/auth/login ---
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const clientIp =
          req.socket?.remoteAddress || 'unknown-ip';
        const emailKey =
          typeof body?.email === 'string'
            ? body.email.trim().toLowerCase()
            : 'unknown-email';

        try {
          loginRateLimiter.consume('auth_login', `${clientIp}:${emailKey}`);
        } catch (err) {
          if (err instanceof RateLimitError) {
            return sendJson(res, 429, {
              error: 'RATE_LIMIT_EXCEEDED',
              message: `Too many login attempts. Please wait ${err.retryAfterSeconds} seconds and try again.`,
              retryAfterSeconds: err.retryAfterSeconds,
            });
          }
          throw err;
        }

        try {
          const session = authStore.authenticateAndCreateSession(
            body?.email,
            body?.password
          );

          const maxAgeSeconds = Math.max(
            1,
            Math.floor((session.expiresAt - Date.now()) / 1000)
          );
          const cookieHeader = serializeSessionCookie(session.sessionId, {
            maxAgeSeconds,
            isProduction,
          });

          return sendJson(
            res,
            200,
            {
              user: session.user,
              csrfToken: session.csrfToken,
              expiresAt: session.expiresAt,
            },
            { 'Set-Cookie': cookieHeader }
          );
        } catch (err) {
          if (err instanceof ValidationError) {
            const status = err.code === 'ACCOUNT_DISABLED' ? 403 : 401;
            return sendJson(res, status, {
              error: err.code,
              message: err.message,
            });
          }
          throw err;
        }
      }

      // --- Authenticate Session from HttpOnly Cookie for all protected routes ---
      const cookies = parseCookies(req.headers.cookie);
      const sessionId = cookies[SESSION_COOKIE_NAME];
      const session = sessionId ? authStore.getValidSession(sessionId) : null;

      if (!session) {
        return sendJson(res, 401, {
          error: 'UNAUTHORIZED',
          message: 'Authentication required. Please log in.',
        });
      }

      // --- Enforce CSRF Token on all state-changing requests (POST, PUT, PATCH, DELETE) ---
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const csrfHeader = req.headers['x-csrf-token'];
        const csrfValid = verifyCsrfToken(
          Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader,
          session.csrfToken
        );

        if (!csrfValid) {
          return sendJson(res, 403, {
            error: 'INVALID_CSRF_TOKEN',
            message: 'Invalid or missing X-CSRF-Token header.',
          });
        }
      }

      // --- 2. GET /api/auth/me ---
      if (method === 'GET' && pathname === '/api/auth/me') {
        return sendJson(res, 200, {
          user: session.user,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
        });
      }

      // --- 3. POST /api/auth/logout ---
      if (method === 'POST' && pathname === '/api/auth/logout') {
        authStore.deleteSession(session.sessionId);
        const clearCookie = serializeSessionCookie('', {
          maxAgeSeconds: 0,
          isProduction,
        });
        return sendJson(
          res,
          200,
          { message: 'Logged out successfully.' },
          { 'Set-Cookie': clearCookie }
        );
      }

      // =========================================================================
      // BUSINESS OWNER ROUTES (/api/my-business...)
      // Strict Rule: business_id is derived EXCLUSIVELY from session.user.business_id
      // =========================================================================
      if (pathname === '/api/my-business' || pathname.startsWith('/api/my-business/')) {
        if (session.user.role !== 'business_owner' || !session.user.business_id) {
          return sendJson(res, 403, {
            error: 'FORBIDDEN_BUSINESS_OWNER_ONLY',
            message:
              'Only a business_owner account associated with a store can access /api/my-business endpoints.',
          });
        }

        // Security Guard: If a malicious client attempts to pass another business_id in query or body
        const queryBizId = urlObj.searchParams.get('business_id') || urlObj.searchParams.get('businessId');
        const ownerBusinessId = session.user.business_id;

        if (queryBizId && queryBizId !== ownerBusinessId) {
          return sendJson(res, 403, {
            error: 'CROSS_BUSINESS_ACCESS_DENIED',
            message: 'You are not authorized to access or modify another business.',
          });
        }

        const actor = {
          role: session.user.role,
          business_id: ownerBusinessId,
        };

        // GET /api/my-business
        if (method === 'GET' && pathname === '/api/my-business') {
          const business = businessStore.getBusiness(ownerBusinessId);
          return sendJson(res, 200, { business });
        }

        // PUT /api/my-business
        if (method === 'PUT' && pathname === '/api/my-business') {
          const body = await readJsonBody(req);
          if (
            (body.business_id && body.business_id !== ownerBusinessId) ||
            (body.businessId && body.businessId !== ownerBusinessId)
          ) {
            return sendJson(res, 403, {
              error: 'CROSS_BUSINESS_ACCESS_DENIED',
              message: 'Cannot change or target another business_id.',
            });
          }

          const updated = businessStore.updateBusinessSettings(
            ownerBusinessId,
            body,
            { actor }
          );
          return sendJson(res, 200, { business: updated });
        }

        // GET /api/my-business/bot
        if (method === 'GET' && pathname === '/api/my-business/bot') {
          if (!botRegistry) {
            return sendJson(res, 200, { bot: null, message: 'Bot registry not configured' });
          }
          const allBots = botRegistry.listBots();
          const matched = allBots.find((b) => b.business_id === ownerBusinessId);
          if (!matched) {
            return sendJson(res, 200, { bot: null });
          }
          return sendJson(res, 200, {
            bot: {
              bot_id: matched.bot_id,
              business_id: matched.business_id,
              bot_username: matched.bot_username,
              status: matched.status,
              hasTokenConfigured: matched.hasTokenConfigured,
            },
          });
        }

        // GET /api/my-business/usage — Total requests, tokens, 429s, and estimated cost
        if (method === 'GET' && pathname === '/api/my-business/usage') {
          if (!resolvedUsageStore) {
            return sendJson(res, 200, { summary: null, message: 'Usage store not available' });
          }
          const startDate = urlObj.searchParams.get('startDate');
          const endDate = urlObj.searchParams.get('endDate');
          const summary = resolvedUsageStore.getUsageSummary(ownerBusinessId, {
            startDate,
            endDate,
          });
          return sendJson(res, 200, { summary });
        }

        // GET /api/my-business/usage/daily — Daily usage timeseries
        if (method === 'GET' && pathname === '/api/my-business/usage/daily') {
          if (!resolvedUsageStore) {
            return sendJson(res, 200, { daily: [] });
          }
          const startDate = urlObj.searchParams.get('startDate');
          const endDate = urlObj.searchParams.get('endDate');
          const limit = urlObj.searchParams.get('limit');
          const daily = resolvedUsageStore.getDailyUsage(ownerBusinessId, {
            startDate,
            endDate,
            limit: limit ? Number(limit) : 30,
          });
          return sendJson(res, 200, { daily });
        }

        // GET /api/my-business/usage/models — Usage grouped by model
        if (method === 'GET' && pathname === '/api/my-business/usage/models') {
          if (!resolvedUsageStore) {
            return sendJson(res, 200, { models: [] });
          }
          const startDate = urlObj.searchParams.get('startDate');
          const endDate = urlObj.searchParams.get('endDate');
          const models = resolvedUsageStore.getUsageByModel(ownerBusinessId, {
            startDate,
            endDate,
          });
          return sendJson(res, 200, { models });
        }

        // GET /api/my-business/products
        if (method === 'GET' && pathname === '/api/my-business/products') {
          const business = businessStore.getBusiness(ownerBusinessId);
          return sendJson(res, 200, { products: business.products });
        }

        // POST /api/my-business/products
        if (method === 'POST' && pathname === '/api/my-business/products') {
          const body = await readJsonBody(req);
          if (body.business_id && body.business_id !== ownerBusinessId) {
            return sendJson(res, 403, {
              error: 'CROSS_BUSINESS_ACCESS_DENIED',
              message: 'Cannot create products for another business.',
            });
          }
          const created = businessStore.addProduct(ownerBusinessId, body, {
            actor,
          });
          return sendJson(res, 201, { product: created });
        }

        // PUT or DELETE /api/my-business/products/:productId
        const productMatch = pathname.match(
          /^\/api\/my-business\/products\/([^/]+)$/
        );
        if (productMatch) {
          const productId = decodeURIComponent(productMatch[1]);

          if (method === 'PUT') {
            const body = await readJsonBody(req);
            const updated = businessStore.updateProduct(
              ownerBusinessId,
              productId,
              body,
              { actor }
            );
            return sendJson(res, 200, { product: updated });
          }

          if (method === 'DELETE') {
            const deleted = businessStore.deleteProduct(
              ownerBusinessId,
              productId,
              { actor }
            );
            return sendJson(res, 200, { deleted });
          }
        }

        // GET /api/my-business/offers
        if (method === 'GET' && pathname === '/api/my-business/offers') {
          const business = businessStore.getBusiness(ownerBusinessId);
          return sendJson(res, 200, { offers: business.offers });
        }

        // POST /api/my-business/offers
        if (method === 'POST' && pathname === '/api/my-business/offers') {
          const body = await readJsonBody(req);
          const created = businessStore.addOffer(ownerBusinessId, body, {
            actor,
          });
          return sendJson(res, 201, { offer: created });
        }

        // PUT or DELETE /api/my-business/offers/:offerId
        const offerMatch = pathname.match(
          /^\/api\/my-business\/offers\/([^/]+)$/
        );
        if (offerMatch) {
          const offerId = decodeURIComponent(offerMatch[1]);

          if (method === 'PUT') {
            const body = await readJsonBody(req);
            const updated = businessStore.updateOffer(
              ownerBusinessId,
              offerId,
              body,
              { actor }
            );
            return sendJson(res, 200, { offer: updated });
          }

          if (method === 'DELETE') {
            const deleted = businessStore.deleteOffer(
              ownerBusinessId,
              offerId,
              { actor }
            );
            return sendJson(res, 200, { deleted });
          }
        }
      }

      // =========================================================================
      // PLATFORM ADMIN ROUTES (/api/admin...)
      // Strict Rule: Restricted exclusively to platform_admin
      // =========================================================================
      if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
        if (session.user.role !== 'platform_admin') {
          return sendJson(res, 403, {
            error: 'FORBIDDEN_ADMIN_ONLY',
            message: 'Access denied. Platform administrator privileges required.',
          });
        }

        const adminActor = { role: 'platform_admin' };

        // GET /api/admin/businesses
        if (method === 'GET' && pathname === '/api/admin/businesses') {
          return sendJson(res, 200, {
            businesses: businessStore.listBusinesses(),
          });
        }

        // GET /api/admin/users
        if (method === 'GET' && pathname === '/api/admin/users') {
          return sendJson(res, 200, {
            users: authStore.listUsers({ actor: adminActor }),
          });
        }

        // POST /api/admin/users — Create business_owner or platform_admin account
        if (method === 'POST' && pathname === '/api/admin/users') {
          const body = await readJsonBody(req);
          const createdUser = authStore.createUser(
            {
              email: body.email,
              password: body.password,
              role: body.role || 'business_owner',
              business_id: body.business_id,
              is_active:
                typeof body.is_active === 'boolean' ? body.is_active : true,
            },
            { actor: adminActor }
          );
          return sendJson(res, 201, { user: createdUser });
        }

        // PUT /api/admin/users/:userId/business — Assign owner to a business
        const assignMatch = pathname.match(
          /^\/api\/admin\/users\/([^/]+)\/business$/
        );
        if (assignMatch && (method === 'PUT' || method === 'PATCH')) {
          const targetUserId = decodeURIComponent(assignMatch[1]);
          const body = await readJsonBody(req);
          const updatedUser = authStore.assignOwnerToBusiness(
            targetUserId,
            body.business_id,
            { actor: adminActor }
          );
          return sendJson(res, 200, { user: updatedUser });
        }

        // PUT /api/admin/users/:userId/status — Enable or disable user account
        const statusMatch = pathname.match(
          /^\/api\/admin\/users\/([^/]+)\/status$/
        );
        if (statusMatch && (method === 'PUT' || method === 'PATCH')) {
          const targetUserId = decodeURIComponent(statusMatch[1]);
          const body = await readJsonBody(req);
          if (typeof body.is_active !== 'boolean') {
            throw new ValidationError(
              'is_active (boolean) is required',
              'INVALID_STATUS'
            );
          }
          const updatedUser = authStore.setUserStatus(
            targetUserId,
            body.is_active,
            { actor: adminActor }
          );
          return sendJson(res, 200, { user: updatedUser });
        }
      }

      return sendJson(res, 404, {
        error: 'NOT_FOUND',
        message: `Route ${method} ${pathname} not found.`,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        const statusMap = {
          PRODUCT_NOT_FOUND: 404,
          OFFER_NOT_FOUND: 404,
          USER_NOT_FOUND: 404,
          UNKNOWN_BUSINESS_ID: 404,
          FORBIDDEN_ADMIN_ONLY: 403,
          UNAUTHORIZED_BUSINESS_ACCESS: 403,
          DUPLICATE_EMAIL: 409,
          DUPLICATE_PRODUCT_ID: 409,
          DUPLICATE_OFFER_ID: 409,
        };
        const statusCode = statusMap[err.code] || 400;
        return sendJson(res, statusCode, {
          error: err.code,
          message: err.message,
        });
      }

      log.error({ method, pathname, err }, 'Unhandled error in REST API');
      return sendJson(res, 500, {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred.',
      });
    }
  };

  const server = http.createServer(requestHandler);
  return server;
}

