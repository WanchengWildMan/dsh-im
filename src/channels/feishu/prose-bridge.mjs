/**
 * 飞书「结构化表述」卡片。
 *
 * 把 prose 插件（@wodouyao/dsh-prose）的改写结果渲染成飞书交互卡片，并给出
 * 挂在答案卡尾部的动作行。与 prose 彻底解耦：本模块只认 ProseRecord 的字段
 * （text / turns / model / effort），不认识 cordis、不发起任何网络请求，
 * bridge 负责取数与投递——prose 缺席时整个文件不会被引用。
 *
 * 卡片分三态：生成中占位、终稿（正文 + 追问输入框）、失败提示。
 */

import { t } from '../shared/i18n.mjs';
import { button, markdown } from './feishu-cards.mjs';

/** 卡片回调动作值：从答案卡发起一次改写。 */
export const PROSE_ACTION = 'prose';
/** 卡片回调动作值：对已生成的表述追问。 */
export const PROSE_ASK_ACTION = 'prose_ask';
/** 卡片回调动作值：放弃旧结果重新生成。 */
export const PROSE_REGEN_ACTION = 'prose_regen';

/** 追问输入框的字段名，回调从 form_value[name] 取值。 */
export const PROSE_QUESTION_FIELD = 'prose_question';

/**
 * 卡片正文的字符上限。
 *
 * 飞书卡片内容接近 30KB 会解析失败（230099），而 JSON 转义会显著放大中文，
 * 这里按字符数保守封顶，超出部分截断并给出提示，而不是整张卡片发不出去。
 */
export const PROSE_CARD_MAX_CHARS = 12_000;

const TRUNCATION_NOTICE = '…（内容过长，已截断）';

/** 截断超长正文，保证卡片始终能发出去。 */
function clampText(text) {
  const value = String(text ?? '');
  return value.length <= PROSE_CARD_MAX_CHARS
    ? value
    : `${value.slice(0, PROSE_CARD_MAX_CHARS)}\n\n${t(TRUNCATION_NOTICE)}`;
}

/** 卡片说明行：由哪个模型、哪个思考档位改写。 */
function modelLine(record) {
  const model = String(record?.model ?? '').trim();
  const effort = String(record?.effort ?? '').trim();
  if (!model) return t('结构化表述');
  return effort
    ? t('由 {model} 改写 · 档位 {effort}', { model, effort })
    : t('由 {model} 改写', { model });
}

/** 组装一张 cardschema 2.0 卡片。 */
function cardWith(headerText, elements, summary) {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, summary: { content: String(summary ?? headerText) } },
    header: { title: { tag: 'plain_text', content: String(headerText) }, template: 'indigo' },
    body: { elements },
  });
}

/**
 * 答案卡尾部的动作行：一个「结构化表述」按钮。
 *
 * 由 feishu-channel 在终稿后用 cardElement.create 追加到卡片末尾，因此这里
 * 返回的是可直接追加的组件数组。
 * @returns 卡片组件数组（放入 cardElement.create 的 elements JSON）
 */
export function proseActionRow() {
  return [button(t('✨ 结构化表述'), PROSE_ACTION)];
}

/** 生成中的占位卡片。 */
export function prosePendingCard() {
  return cardWith(t('✨ 结构化表述'), [
    { tag: 'div', text: markdown(t('⏳ 正在结构化这条回答…')) },
  ], t('正在生成结构化表述'));
}

/** 失败卡片：把可展示的错误交给读者，不留白屏。 */
export function proseFailureCard(message) {
  return cardWith(t('✨ 结构化表述'), [
    { tag: 'div', text: markdown(t('⚠️ 生成失败：{reason}', { reason: String(message ?? '') })) },
  ], t('结构化表述生成失败'));
}

/**
 * 终稿卡片：说明行 + 正文 + 追问轮次 + 追问输入框 + 重新生成。
 *
 * `proseKey` 是这条改写挂载的助手消息 id，随卡片回调原样带回，追问与重新生成
 * 据此定位同一条记录——服务重启后卡片依然可用。
 * @param record - prose 服务返回的改写记录
 * @param proseKey - 回调寻址用的消息 id
 * @param options.busy - 追问进行中：输入框与按钮置灰语义（提交键文案改为进行中）
 */
export function proseCard(record, proseKey, { busy = false } = {}) {
  const elements = [
    { tag: 'div', text: markdown(modelLine(record)) },
    { tag: 'hr' },
    { tag: 'div', text: markdown(clampText(record?.text)) },
  ];
  for (const turn of record?.turns ?? []) {
    const answer = clampText(turn.answer);
    elements.push(
      { tag: 'hr' },
      { tag: 'div', text: markdown(`**❓ ${String(turn.question ?? '')}**`) },
      { tag: 'div', text: markdown(answer === '' ? t('（未产出内容）') : answer) },
    );
  }
  elements.push(
    { tag: 'hr' },
    {
      tag: 'form',
      name: 'prose_ask_form',
      elements: [
        {
          tag: 'input',
          name: PROSE_QUESTION_FIELD,
          placeholder: { tag: 'plain_text', content: t('继续追问这条表述…') },
        },
        {
          tag: 'button',
          name: 'prose_ask_submit',
          text: { tag: 'plain_text', content: busy ? t('追问中…') : t('追问') },
          type: 'primary',
          width: 'fill',
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { action: PROSE_ASK_ACTION, proseKey } }],
        },
      ],
    },
    button(t('🔄 重新生成'), { action: PROSE_REGEN_ACTION, proseKey }),
  );
  return cardWith(t('✨ 结构化表述'), elements, t('结构化表述'));
}
