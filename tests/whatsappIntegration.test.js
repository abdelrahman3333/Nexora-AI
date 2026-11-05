import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppClient } from '../src/whatsapp/whatsappClient.js';
import { WhatsAppWebhookHandler } from '../src/whatsapp/webhookHandler.js';
import { createApiServer } from '../src/api/server.js';
import { AuthStore } from '../src/auth/authStore.js';
import { BusinessStore } from '../src/config/businessStore.js';

describe('Meta WhatsApp Cloud API Integration', () => {
  describe('WhatsAppClient', () => {
    it('dispatches outbound text messages with correct headers and payload format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          messaging_product: 'whatsapp',
          contacts: [{ input: '966500000000', wa_id: '966500000000' }],
          messages: [{ id: 'wamid.HBgLMTIzNDU2' }],
        }),
      });

      const client = new WhatsAppClient({
        accessToken: 'EAAG_test_mock_whatsapp_token',
        phoneNumberId: '100012345678901',
        fetchFn: mockFetch,
      });

      const result = await client.sendTextMessage({
        to: '+966 50 000 0000',
        text: 'أهلاً بك في متجر نيكسورا للقهوة المختصة!',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('wamid.HBgLMTIzNDU2');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v21.0/100012345678901/messages');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer EAAG_test_mock_whatsapp_token');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('966500000000');
      expect(body.text.body).toBe('أهلاً بك في متجر نيكسورا للقهوة المختصة!');
    });

    it('rejects missing recipient, empty text, or unconfigured tokens with safe errors', async () => {
      const client = new WhatsAppClient({
        accessToken: '',
        phoneNumberId: '',
      });

      await expect(
        client.sendTextMessage({ to: '', text: 'Hello' })
      ).rejects.toThrow(/Recipient phone number/);

      await expect(
        client.sendTextMessage({ to: '966500000000', text: '' })
      ).rejects.toThrow(/Message text cannot be empty/);

      await expect(
        client.sendTextMessage({ to: '966500000000', text: 'Hello' })
      ).rejects.toThrow(/WHATSAPP_ACCESS_TOKEN is missing/);
    });

    it('handles Meta Graph API error responses cleanly without crashing', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: 'Recipient phone number not in allowed test list',
            type: 'OAuthException',
            code: 131030,
            fbtrace_id: 'Az9Xk123',
          },
        }),
      });

      const client = new WhatsAppClient({
        accessToken: 'EAAG_test_token',
        phoneNumberId: '100012345678901',
        fetchFn: mockFetch,
      });

      await expect(
        client.sendTextMessage({
          to: '966500000000',
          text: 'Test',
        })
      ).rejects.toThrow(/WhatsApp API Error \[131030\]/);
    });

    it('sends read receipts via markMessageAsRead safely', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      const client = new WhatsAppClient({
        accessToken: 'EAAG_test_token',
        phoneNumberId: '100012345678901',
        fetchFn: mockFetch,
      });

      const result = await client.markMessageAsRead({
        messageId: 'wamid.HBgL123',
      });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.status).toBe('read');
      expect(body.message_id).toBe('wamid.HBgL123');
    });
  });

  describe('WhatsAppWebhookHandler', () => {
    it('verifies Meta challenge when verify token matches (GET)', () => {
      const handler = new WhatsAppWebhookHandler({
        verifyToken: 'my_nexora_secret_verify_token_123',
        supportService: {},
        whatsappClient: {},
      });

      const success = handler.verifyChallenge({
        mode: 'subscribe',
        token: 'my_nexora_secret_verify_token_123',
        challenge: '1155998844',
      });
      expect(success.valid).toBe(true);
      expect(success.challenge).toBe('1155998844');
      expect(success.status).toBe(200);

      const fail = handler.verifyChallenge({
        mode: 'subscribe',
        token: 'wrong_token',
        challenge: '1155998844',
      });
      expect(fail.valid).toBe(false);
      expect(fail.status).toBe(403);
    });

    it('defensively handles tokens with quotes or accidental WHATSAPP_VERIFY_TOKEN= prefixes', () => {
      const handlerWithPrefix = new WhatsAppWebhookHandler({
        verifyToken: 'WHATSAPP_VERIFY_TOKEN="my_clean_token_999"',
        supportService: {},
        whatsappClient: {},
      });

      const res = handlerWithPrefix.verifyChallenge({
        mode: 'subscribe',
        token: 'my_clean_token_999',
        challenge: '776655',
      });
      expect(res.valid).toBe(true);
      expect(res.challenge).toBe('776655');
    });

    it('verifies HMAC-SHA256 signature accurately using Meta App Secret', () => {
      const appSecret = 'test_meta_app_secret_9988';
      const handler = new WhatsAppWebhookHandler({
        appSecret,
        supportService: {},
        whatsappClient: {},
      });

      const rawPayload = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
      const correctHash = crypto.createHmac('sha256', appSecret).update(rawPayload).digest('hex');
      const validHeader = `sha256=${correctHash}`;

      expect(handler.verifySignature(rawPayload, validHeader)).toBe(true);
      expect(handler.verifySignature(rawPayload, 'sha256=invalid_tampered_hash')).toBe(false);
      expect(handler.verifySignature(rawPayload, '')).toBe(false);
      expect(handler.verifySignature(rawPayload, undefined)).toBe(false);
    });

    it('deduplicates retransmitted messages with the same messageId', () => {
      const handler = new WhatsAppWebhookHandler({
        supportService: {},
        whatsappClient: {},
      });

      expect(handler.isDuplicate('wamid.msg_1001')).toBe(false);
      expect(handler.isDuplicate('wamid.msg_1001')).toBe(true);
      expect(handler.isDuplicate('wamid.msg_1002')).toBe(false);
    });

    it('processes incoming customer message, generates Gemini reply, and dispatches via client', async () => {
      const mockSupportService = {
        generateResponse: vi.fn().mockResolvedValue('قهوتنا الإثيوبية متوفرة بسعر 65 ريال مع شحن مجاني!'),
        defaultBusinessId: 'nexora-coffee-sa',
      };

      const mockClient = {
        isConfigured: () => true,
        sendTextMessage: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.out_123' }),
        markMessageAsRead: vi.fn().mockResolvedValue({ success: true }),
      };

      const handler = new WhatsAppWebhookHandler({
        verifyToken: 'token_123',
        supportService: mockSupportService,
        whatsappClient: mockClient,
      });

      const webhookPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_1001',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550201122',
                    phone_number_id: 'PHONE_ID_999',
                  },
                  contacts: [{ profile: { name: 'فهد' }, wa_id: '966512345678' }],
                  messages: [
                    {
                      from: '966512345678',
                      id: 'wamid.test_in_001',
                      timestamp: '1730001122',
                      type: 'text',
                      text: { body: 'عندكم بن إثيوبي؟' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const result = await handler.handleWebhookPayload(webhookPayload);
      expect(result.status).toBe('ok');
      expect(result.processedMessages).toBe(1);

      // Wait a tick for async _processIncomingMessage to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockSupportService.generateResponse).toHaveBeenCalledWith({
        businessId: 'nexora-coffee-sa',
        botId: 'whatsapp',
        userId: '966512345678',
        message: 'عندكم بن إثيوبي؟',
        platform: 'whatsapp',
      });

      expect(mockClient.sendTextMessage).toHaveBeenCalledWith({
        to: '966512345678',
        text: 'قهوتنا الإثيوبية متوفرة بسعر 65 ريال مع شحن مجاني!',
        phoneNumberId: 'PHONE_ID_999',
      });
    });

    it('ignores status-only delivery webhooks without invoking AI generation', async () => {
      const mockSupportService = {
        generateResponse: vi.fn(),
      };

      const handler = new WhatsAppWebhookHandler({
        supportService: mockSupportService,
        whatsappClient: {},
      });

      const statusPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA_1001',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: 'PHONE_ID_999' },
                  statuses: [
                    {
                      id: 'wamid.out_123',
                      status: 'delivered',
                      timestamp: '1730001150',
                      recipient_id: '966512345678',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const result = await handler.handleWebhookPayload(statusPayload);
      expect(result.status).toBe('ok');
      expect(result.processedMessages).toBe(0);
      expect(mockSupportService.generateResponse).not.toHaveBeenCalled();
    });
  });

  describe('REST API Server Webhook Endpoints (/api/webhooks/whatsapp)', () => {
    let server;
    let baseUrl;
    let authStore;
    let businessStore;

    const startTestServer = async (handler = null) => {
      authStore = new AuthStore({ dbPath: ':memory:' });
      businessStore = new BusinessStore();

      server = createApiServer({
        authStore,
        businessStore,
        whatsappWebhookHandler: handler,
      });

      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
    };

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (authStore) {
        authStore.close();
      }
    });

    it('returns challenge string on valid GET verification handshake and never returns HTML', async () => {
      const handler = new WhatsAppWebhookHandler({
        verifyToken: 'secret_meta_verify_token_55',
        supportService: {},
        whatsappClient: {},
      });

      await startTestServer(handler);

      // Test standard /api/webhooks/whatsapp
      const res = await fetch(
        `${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret_meta_verify_token_55&hub.challenge=challenge_token_8899`
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength('challenge_token_8899')));
      const text = await res.text();
      expect(text).toBe('challenge_token_8899');
      expect(text).not.toContain('<!DOCTYPE html>');
      expect(text).not.toContain('<html');

      // Test HEAD request (Meta sometimes preflights with HEAD)
      const resHead = await fetch(
        `${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret_meta_verify_token_55&hub.challenge=challenge_token_8899`,
        { method: 'HEAD' }
      );
      expect(resHead.status).toBe(200);
      expect(resHead.headers.get('content-type')).toContain('text/plain');
      expect(resHead.headers.get('content-length')).toBe(String(Buffer.byteLength('challenge_token_8899')));

      // Test alternative /webhooks/whatsapp (ensures static SPA catch-all does NOT intercept)
      const resAlt = await fetch(
        `${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret_meta_verify_token_55&hub.challenge=challenge_token_alt_77`
      );
      expect(resAlt.status).toBe(200);
      expect(resAlt.headers.get('content-type')).toContain('text/plain');
      const textAlt = await resAlt.text();
      expect(textAlt).toBe('challenge_token_alt_77');
      expect(textAlt).not.toContain('<!DOCTYPE html>');
    });

    it('returns 403 text on invalid verify token in GET verification and never returns HTML', async () => {
      const handler = new WhatsAppWebhookHandler({
        verifyToken: 'secret_meta_verify_token_55',
        supportService: {},
        whatsappClient: {},
      });

      await startTestServer(handler);

      const res = await fetch(
        `${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=1234`
      );

      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('Forbidden');
      expect(text).not.toContain('<!DOCTYPE html>');
    });

    it('returns 401 on POST request when HMAC signature verification fails', async () => {
      const handler = new WhatsAppWebhookHandler({
        appSecret: 'correct_secret',
        supportService: {},
        whatsappClient: {},
      });

      await startTestServer(handler);

      const res = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': 'sha256=forged_or_invalid_signature',
        },
        body: JSON.stringify({ object: 'whatsapp_business_account' }),
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('INVALID_SIGNATURE');
    });

    it('accepts POST request with valid signature and responds with 200 { status: "ok" }', async () => {
      const appSecret = 'test_secret_for_post';
      const handler = new WhatsAppWebhookHandler({
        appSecret,
        supportService: {
          generateResponse: vi.fn().mockResolvedValue('رد تجريبي'),
          defaultBusinessId: 'nexora-coffee-sa',
        },
        whatsappClient: {
          isConfigured: () => false,
        },
      });

      await startTestServer(handler);

      const bodyObj = { object: 'whatsapp_business_account', entry: [] };
      const rawBody = Buffer.from(JSON.stringify(bodyObj));
      const sig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

      const res = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': sig,
        },
        body: rawBody,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
    });
  });
});
