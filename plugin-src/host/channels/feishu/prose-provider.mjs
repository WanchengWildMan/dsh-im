/**
 * 「结构化表述」能力的软依赖持有者。
 *
 * dsh-im 不硬依赖 @wodouyao/dsh-prose：prose 插件没装时，注入回调永不触发，
 * available() 恒为 false，答案卡不挂按钮、卡片回调不注册分支，其余功能零影响。
 * prose 后挂载或卸载都由这个持有者实时反映，无需重启机器人。
 *
 * 语言边界：prose 的 @Remote 只标记方法、不在进程内包装返回值，因此这里直接
 * 调用拿到的是 ProseRemoteResult（{ok:true,value} | {ok:false,error}），
 * 拆一层即可；飞书侧只依赖 record 的 text/turns/model/effort 字段。
 */

/** 从 prose 的业务结果里取记录，失败时折算成可展示的消息。 */
function unwrap(result) {
  if (result?.ok !== true) {
    return { ok: false, message: result?.error?.message ?? '结构化表述服务调用失败' };
  }
  return { ok: true, record: result.value };
}

/**
 * 组装 prose 调用面。
 * @param ctx - DSH Host 上下文；缺失或不可注入时返回一个恒不可用的持有者
 * @returns 冻结的调用面：available / generate / ask
 */
export function createProseProvider(ctx) {
  let service = null;
  if (typeof ctx?.inject === 'function') {
    // 软依赖：只声明、不进入静态 inject，prose 缺席时这个 fiber 一直挂起。
    ctx.inject(['wodouyaoProse'], (proseCtx) => {
      service = proseCtx.wodouyaoProse ?? null;
      return () => { service = null; };
    });
  }
  return Object.freeze({
    /** prose 插件是否已挂载：决定答案卡是否挂「结构化表述」按钮。 */
    available: () => service !== null,

    /**
     * 生成一次结构化表述。
     *
     * 只给会话 id 与 anchor：prose 自己定位会话最后一条助手消息，把结果挂在
     * 真实消息 id 上，浏览器端同一条消息下也能看到、能继续追问。
     * @param input.sessionId - 目标会话
     * @returns { ok, record } 或 { ok:false, message }
     */
    async generate({ sessionId }) {
      if (service === null) return { ok: false, message: '结构化表述插件未安装' };
      try {
        return unwrap(await service.prose({
          sessionId,
          anchor: 'last-assistant',
          sourceText: '',
          instruction: '',
        }));
      } catch (error) {
        return { ok: false, message: error?.message ?? String(error) };
      }
    },

    /**
     * 对已有表述继续追问；记录内的问答历史由 prose 维护。
     * @param input.sessionId - 目标会话
     * @param input.messageId - 记录键（生成时返回的 messageId）
     * @param input.question - 追问内容
     * @returns { ok, record } 或 { ok:false, message }
     */
    async ask({ sessionId, messageId, question }) {
      if (service === null) return { ok: false, message: '结构化表述插件未安装' };
      try {
        return unwrap(await service.askProse({ sessionId, messageId, question }));
      } catch (error) {
        return { ok: false, message: error?.message ?? String(error) };
      }
    },
  });
}
