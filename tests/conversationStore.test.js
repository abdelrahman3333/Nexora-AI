import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/memory/conversationStore.js';

describe('ConversationStore — Isolation & History Limits', () => {
  it('isolates conversation history between different Telegram users', () => {
    const store = new ConversationStore({ maxMessages: 10 });

    store.appendMessage('tenant-sa', 'user-101', 'user', 'السلام عليكم، بكم المطحنة؟');
    store.appendMessage('tenant-sa', 'user-101', 'model', 'وعليكم السلام، حياك الله! سعرها 450 ر.س');

    store.appendMessage('tenant-sa', 'user-202', 'user', 'What are your working hours?');

    const user101History = store.getHistory('tenant-sa', 'user-101');
    const user202History = store.getHistory('tenant-sa', 'user-202');

    expect(user101History).toHaveLength(2);
    expect(user101History[0].text).toContain('بكم المطحنة');
    expect(user202History).toHaveLength(1);
    expect(user202History[0].text).toBe('What are your working hours?');
  });

  it('isolates conversations across different tenants and messaging platforms', () => {
    const store = new ConversationStore({ maxMessages: 10 });

    store.appendMessage('tenant-sa', 'user-1', 'user', 'رسالة تيليجرام', 'telegram');
    store.appendMessage('tenant-ae', 'user-1', 'user', 'رسالة متجر الإمارات', 'telegram');
    store.appendMessage('tenant-sa', 'user-1', 'user', 'رسالة واتساب', 'whatsapp');

    expect(store.getHistory('tenant-sa', 'user-1', 'telegram')[0].text).toBe('رسالة تيليجرام');
    expect(store.getHistory('tenant-ae', 'user-1', 'telegram')[0].text).toBe('رسالة متجر الإمارات');
    expect(store.getHistory('tenant-sa', 'user-1', 'whatsapp')[0].text).toBe('رسالة واتساب');
  });

  it('enforces the configurable sliding-window conversation history limit', () => {
    const store = new ConversationStore({ maxMessages: 4 });

    store.appendMessage('tenant-1', 'user-1', 'user', 'Message 1');
    store.appendMessage('tenant-1', 'user-1', 'model', 'Reply 1');
    store.appendMessage('tenant-1', 'user-1', 'user', 'Message 2');
    store.appendMessage('tenant-1', 'user-1', 'model', 'Reply 2');
    store.appendMessage('tenant-1', 'user-1', 'user', 'Message 3');
    store.appendMessage('tenant-1', 'user-1', 'model', 'Reply 3');

    const history = store.getHistory('tenant-1', 'user-1');
    expect(history).toHaveLength(4);
    expect(history.map((m) => m.text)).toEqual([
      'Message 2',
      'Reply 2',
      'Message 3',
      'Reply 3',
    ]);
  });

  it('allows a user conversation history to be reset without affecting other users', () => {
    const store = new ConversationStore({ maxMessages: 10 });

    store.appendMessage('tenant-1', 'user-A', 'user', 'Hello A');
    store.appendMessage('tenant-1', 'user-B', 'user', 'Hello B');

    store.clearHistory('tenant-1', 'user-A');

    expect(store.getHistory('tenant-1', 'user-A')).toEqual([]);
    expect(store.getHistory('tenant-1', 'user-B')).toHaveLength(1);
  });

  it('evicts expired conversations based on TTL', () => {
    const store = new ConversationStore({ maxMessages: 10, ttlMs: 50 });
    store.appendMessage('tenant-1', 'user-exp', 'user', 'Old message');

    // Manually backdate session timestamp
    const key = store._buildKey('tenant-1', 'user-exp', 'telegram');
    store.sessions.get(key).updatedAt = Date.now() - 1000;

    expect(store.getHistory('tenant-1', 'user-exp')).toEqual([]);
  });
});

