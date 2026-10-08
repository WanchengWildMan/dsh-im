import test from 'node:test';
import assert from 'node:assert/strict';
import { VerifiedFeishuChannel } from '../../../src/channels/feishu/feishu-channel.mjs';
import {
  PROSE_ASK_ACTION,
  PROSE_CARD_MAX_CHARS,
  PROSE_QUESTION_FIELD,
  PROSE_REGEN_ACTION,
  proseActionRow,
  proseCard,
  proseFailureCard,
  prosePendingCard,
} from '../../../src/channels/feishu/prose-bridge.mjs';

/** 收集卡片里所有按钮（含 column_set 包装）。 */
function buttons(card) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button') found.push(node);
    for (const value of Object.values(node)) walk(value);
  };
  walk(card.body?.elements ?? []);
  return found;
}

function record(overrides = {}) {
  return {
    messageId: 'msg-1',
    sessionId: 'session-1',
    model: 'moonton/deepseek-v4',
    effort: 'high',
    text: '## 结论\n\n先给结论。',
    turns: [],
    ...overrides,
  };
}

test('the answer-card action row offers exactly one structured-expression button', () => {
  const row = proseActionRow();
  const card = { body: { elements: row } };
  assert.deepEqual(buttons(card).map((button) => button.behaviors[0].value), [
    { action: 'prose' },
  ]);
});

test('the pending card tells the reader generation started without any action', () => {
  const card = JSON.parse(prosePendingCard());
  assert.deepEqual(buttons(card), []);
  assert.match(JSON.stringify(card.body.elements), /正在结构化/);
});

test('the failure card carries the reason instead of leaving the reader with a blank card', () => {
  const card = JSON.parse(proseFailureCard('模型调用失败：400'));
  assert.match(JSON.stringify(card.body.elements), /400/);
});

test('the final card renders the model line, the rewritten text and a follow-up form', () => {
  const card = JSON.parse(proseCard(record(), 'msg-1'));
  const rendered = JSON.stringify(card.body.elements);
  assert.equal(card.header.title.content, '✨ 结构化表述');
  assert.match(rendered, /moonton\/deepseek-v4/);
  assert.match(rendered, /high/);
  assert.match(rendered, /先给结论/);
  const form = card.body.elements.find((element) => element.tag === 'form');
  assert.ok(form);
  assert.equal(form.elements[0].name, PROSE_QUESTION_FIELD);
  assert.deepEqual(form.elements[1].behaviors[0].value, { action: PROSE_ASK_ACTION, proseKey: 'msg-1' });
  assert.equal(form.elements[1].form_action_type, 'submit');
  assert.deepEqual(buttons(card).map((button) => button.behaviors[0].value), [
    { action: PROSE_ASK_ACTION, proseKey: 'msg-1' },
    { action: PROSE_REGEN_ACTION, proseKey: 'msg-1' },
  ]);
});

test('follow-up turns are appended to the same card so the question history stays visible', () => {
  const card = JSON.parse(proseCard(record({
    turns: [{ question: '为什么？', answer: '因为上游只认 none。' }],
  }), 'msg-1'));
  const rendered = JSON.stringify(card.body.elements);
  assert.match(rendered, /为什么？/);
  assert.match(rendered, /因为上游只认 none。/);
});

test('a follow-up with no output still says so rather than rendering an empty block', () => {
  const card = JSON.parse(proseCard(record({
    turns: [{ question: '空？', answer: '' }],
  }), 'msg-1'));
  assert.match(JSON.stringify(card.body.elements), /未产出内容/);
});

test('an oversized rewrite is clamped so the card itself can still be delivered', () => {
  const card = JSON.parse(proseCard(record({ text: 'x'.repeat(PROSE_CARD_MAX_CHARS + 500) }), 'msg-1'));
  const rendered = JSON.stringify(card.body.elements);
  assert.match(rendered, /已截断/);
  assert.ok(rendered.length < PROSE_CARD_MAX_CHARS * 2);
});

/** 只实现 stream() 用到的接口，并按调用顺序记录。 */
function fakeChannelClient() {
  const calls = { appends: [], updates: [], settings: [] };
  const client = {
    cardkit: { v1: {
      card: {
        create: async () => ({ code: 0, data: { card_id: 'card-test' } }),
        settings: async (request) => { calls.settings.push(request); return { code: 0 }; },
      },
      cardElement: {
        content: async (request) => { calls.updates.push(request); return { code: 0 }; },
        create: async (request) => { calls.appends.push(request); return { code: 0 }; },
      },
    } },
    im: { v1: {
      message: {
        reply: async () => ({ code: 0, data: { message_id: 'om-stream' } }),
        create: async () => ({ code: 0, data: { message_id: 'om-stream' } }),
      },
    } },
  };
  return { client, calls };
}

test('the footer action row is appended to the finished answer card', async () => {
  const { client, calls } = fakeChannelClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  await channel.stream('oc_chat', {
    markdown: async (controller) => { await controller.setContent('答案'); },
  }, { replyTo: 'om_user', footerElements: proseActionRow() });

  assert.equal(calls.appends.length, 1);
  assert.equal(calls.appends[0].path.card_id, 'card-test');
  assert.equal(calls.appends[0].data.type, 'append');
  const appended = JSON.parse(calls.appends[0].data.elements);
  assert.equal(appended[0].columns[0].elements[0].behaviors[0].value.action, 'prose');
  // 追加发生在封存之后，且与其它写操作共用严格递增的 sequence。
  assert.equal(calls.settings[0].data.sequence, 2);
  assert.equal(calls.appends[0].data.sequence, 3);
});

test('a channel without a footer writes exactly the cards it wrote before', async () => {
  const { client, calls } = fakeChannelClient();
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  await channel.stream('oc_chat', {
    markdown: async (controller) => { await controller.setContent('答案'); },
  }, { replyTo: 'om_user' });
  assert.equal(calls.appends.length, 0);
});

test('a failed footer append leaves the delivered answer intact', async () => {
  const { client, calls } = fakeChannelClient();
  client.cardkit.v1.cardElement.create = async () => { throw new Error('230099 parse json err'); };
  const channel = new VerifiedFeishuChannel({ client, initialText: '正在思考…' });
  const result = await channel.stream('oc_chat', {
    markdown: async (controller) => { await controller.setContent('答案'); },
  }, { replyTo: 'om_user', footerElements: proseActionRow() });
  assert.deepEqual(result.providerMessageIds, ['om-stream']);
  assert.equal(calls.updates.at(-1).data.content, '答案');
});
