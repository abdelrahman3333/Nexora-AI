import { describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../src/ai/geminiProvider.js';
import { buildSystemPrompt } from '../src/ai/promptBuilder.js';
import { loadBusinessKnowledge } from '../src/config/businessKnowledge.js';
import { ConversationStore } from '../src/memory/conversationStore.js';
import { RateLimiter } from '../src/middleware/rateLimiter.js';
import { SupportService } from '../src/services/supportService.js';

const mockBusinessConfig = {
  tenantId: 'nexora-sa-test',
  businessName: 'متجر نيكسورا الخليج',
  businessCountry: 'SA',
  businessCurrency: 'SAR',
  businessTimezone: 'Asia/Riyadh',
  defaultDialect: 'saudi',
  languagePreference: 'auto',
  businessTone: 'polite_professional_gulf',
};

const sampleKnowledge = loadBusinessKnowledge();

describe('GeminiProvider & SupportService (Mocked AI & Error Handling)', () => {
  it('builds a GCC system prompt that prioritizes Saudi dialect, forbids Egyptian Arabic, and enforces verified facts', () => {
    const prompt = buildSystemPrompt({
      businessConfig: mockBusinessConfig,
      knowledge: sampleKnowledge,
      detectedUserLanguage: 'ar',
    });

    expect(prompt).toContain('Saudi Arabic');
    expect(prompt).toContain('STRICTLY AVOID EGYPTIAN DIALECT');
    expect(prompt).toContain('DISCOVER THE CUSTOMER\'S NEEDS');
    expect(prompt).toContain('PROFESSIONAL SALES SKILLS');
    expect(prompt).toContain('450 ر.س (SAR)');
  });

  it('generates AI responses using mocked @google/genai client and preserves isolated history', async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'حياك الله طال عمرك! سعر مطحنة القهوة المختصة نيكسورا برو هو 450 ر.س وهي متوفرة حالياً.',
    });

    const mockClient = {
      models: {
        generateContent: mockGenerateContent,
      },
    };

    const aiProvider = new GeminiProvider({
      client: mockClient,
      model: 'gemini-2.5-flash',
    });

    const conversationStore = new ConversationStore({ maxMessages: 10 });
    const rateLimiter = new RateLimiter({ windowMs: 60000, maxRequests: 10 });

    const supportService = new SupportService({
      aiProvider,
      conversationStore,
      rateLimiter,
      businessConfig: mockBusinessConfig,
      knowledge: sampleKnowledge,
    });

    const response = await supportService.handleIncomingMessage({
      userId: 'tg-user-555',
      text: 'السلام عليكم، كم سعر مطحنة القهوة؟',
      messageId: 1001,
    });

    expect(response.isError).toBe(false);
    expect(response.language).toBe('ar');
    expect(response.text).toContain('450 ر.س');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    const history = conversationStore.getHistory(
      mockBusinessConfig.tenantId,
      'tg-user-555'
    );
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('model');
  });

  it('retries transient Gemini API failures and succeeds when a subsequent attempt passes', async () => {
    const transientError = new Error('503 Service Unavailable');
    transientError.status = 503;

    const mockGenerateContent = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({
        text: 'Welcome! Our working hours are Sunday to Thursday from 9:00 AM to 10:00 PM.',
      });

    const aiProvider = new GeminiProvider({
      client: { models: { generateContent: mockGenerateContent } },
      maxRetries: 2,
      baseRetryDelayMs: 10,
    });

    const reply = await aiProvider.generateReply({
      systemInstruction: 'Test system instruction',
      history: [],
      userMessage: 'What are your working hours?',
    });

    expect(reply).toContain('9:00 AM to 10:00 PM');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('handles permanent Gemini API errors or timeouts gracefully without leaking secrets or stack traces', async () => {
    const fatalError = new Error(
      'Invalid API key AIzaSySecretKeyShouldNeverBeLeaked123456'
    );
    fatalError.status = 401;

    const mockGenerateContent = vi.fn().mockRejectedValue(fatalError);

    const aiProvider = new GeminiProvider({
      client: { models: { generateContent: mockGenerateContent } },
      maxRetries: 1,
      baseRetryDelayMs: 5,
    });

    const supportService = new SupportService({
      aiProvider,
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessConfig: mockBusinessConfig,
      knowledge: sampleKnowledge,
    });

    const result = await supportService.handleIncomingMessage({
      userId: 'tg-user-999',
      text: 'هل يوجد توصيل للرياض؟',
      messageId: 2002,
    });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('AIzaSySecretKeyShouldNeverBeLeaked123456');
    expect(result.text).toContain('نعتذر منك');
  });

  it('prevents duplicate replies when the same Telegram messageId is received twice', async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'أهلاً بك، السعر 320 ر.س',
    });

    const supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: mockGenerateContent } },
      }),
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessConfig: mockBusinessConfig,
      knowledge: sampleKnowledge,
    });

    const first = await supportService.handleIncomingMessage({
      userId: 'user-dup',
      text: 'كم سعر الغلاية؟',
      messageId: 7777,
    });

    const second = await supportService.handleIncomingMessage({
      userId: 'user-dup',
      text: 'كم سعر الغلاية؟',
      messageId: 7777,
    });

    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('handles unsupported message types and conversation resets gracefully', () => {
    const supportService = new SupportService({
      aiProvider: new GeminiProvider({
        client: { models: { generateContent: vi.fn() } },
      }),
      conversationStore: new ConversationStore(),
      rateLimiter: new RateLimiter(),
      businessConfig: mockBusinessConfig,
      knowledge: sampleKnowledge,
    });

    const unsupportedAr = supportService.handleUnsupportedMessage({ language: 'ar' });
    expect(unsupportedAr.text).toContain('الرسائل النصية فقط');

    const unsupportedEn = supportService.handleUnsupportedMessage({ language: 'en' });
    expect(unsupportedEn.text).toContain('text messages only');

    const resetAr = supportService.resetConversation({
      userId: 'user-1',
      language: 'ar',
    });
    expect(resetAr.text).toContain('تم مسح سجل المحادثة');
  });
});

