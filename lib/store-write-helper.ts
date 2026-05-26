/**
 * Store Write State Helper
 * ========================
 *
 * 把 router / keyStore / prefStore / customLanes 这类小 localStorage store 的
 * "quota 超限报错暴露"统一起来。各 store 内部各自维护独立的 writeError closure,
 * 不再静默吞 QuotaExceededError —— UI 层可以读 getXxxWriteError() 显示给用户。
 *
 * 为什么不抽进 plaza?
 *   plaza 有更复杂的逻辑(sanitize / migrate / pub-sub),它自己用 `let lastWriteError`
 *   实现得已经很好,改它没收益、风险大。这个 helper 只覆盖那 4 个简单 store。
 *
 * 设计:
 *   - 用 closure 给每个 store 创建独立的状态(避免全局单例共享 error)
 *   - 失败:reportFailure(e, hint)  → 把 hint + Error 信息合并保存,并 console.error
 *   - 成功:reportSuccess()         → 清除上次错误,等于 store 自愈
 *   - 读取:lastError() / clearError()
 *
 *   console.error 在 dev 模式下保留诊断价值;prod 模式由 next.config 的
 *   `compiler.removeConsole` 剥掉(下个 P1-#6 步骤会加上)。
 */

export interface StoreWriteState {
  /** 读取最近一次写入失败的提示;null = 没失败过(或已 clear) */
  lastError(): string | null;
  /** 手动清空错误状态(例如用户点了"我知道了") */
  clearError(): void;
  /**
   * 报告一次写入失败。e 通常是 catch 到的 Error;hint 是 store 自己的人类可读上下文,
   * 例如"路由配置保存失败"。最终展示:`${hint} (${e.name}: ${e.message})`。
   */
  reportFailure(e: unknown, hint?: string): void;
  /** 写入成功:清除上次的错误 */
  reportSuccess(): void;
}

export function createWriteState(storeName: string): StoreWriteState {
  let lastError: string | null = null;
  return {
    lastError() {
      return lastError;
    },
    clearError() {
      lastError = null;
    },
    reportFailure(e: unknown, hint?: string) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      lastError = hint ? `${hint}(${msg})` : msg;
      // dev 模式下输出供诊断;prod 由 removeConsole 剥除
      if (typeof console !== 'undefined') {
        console.error(`[store:${storeName}] write failed:`, e);
      }
    },
    reportSuccess() {
      lastError = null;
    },
  };
}
