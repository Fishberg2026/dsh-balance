/**
 * Balance pill.
 *
 * Renders the DeepSeek Platform wallet balance on the composer dock line,
 * to the right of the context meter. Hovering shows this session's estimated
 * spend through the same `Tooltip` the context meter uses for its own hover
 * label, so both read identically: the estimate multiplies the session's
 * provider-reported tokens by the official per-million-token prices, which the
 * host half refreshes once a day. Clicking opens the Platform top-up page as an
 * in-app overlay through the Desktop `dshPlatform` bridge, falling back to the
 * system browser when the bridge is unavailable.
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-pill',
  factory(require) {
    const React = require('react');
    const { Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const NS = 'balancePill';
    const PRICES_ENDPOINT = '/balance-pill/prices';
    const PRICES_TTL_MS = 6 * 60 * 60_000;
    const REFRESH_MS = 60_000;
    const STYLE_TAG_ID = 'dsh-balance-pill/styles.css';
    const TOP_UP_PAGE = 'top-up';
    /** Official peak windows in UTC hours: [from, to) Mon-Fri. */
    const PEAK_WINDOWS = [[1, 4], [6, 10]];
    /** Usage pill from dsh-client-ui-chat renders `stats.cacheHit` next to us. */
    const USAGE_NAMESPACE = 'chat';
    const USAGE_CACHE_HIT_KEY = 'stats.cacheHit';
    const CACHE_HIT_SHORT = '{percent}%';

    const MESSAGES = {
      zh: {
        topUp: '充值',
        reading: '正在读取余额',
        back: '返回',
        retry: '重试',
        unavailable: '余额不可用',
        sessionCost: '本会话估算',
        estimateReading: '正在读取官方价格',
        estimateUnavailable: '价格不可用',
      },
      en: {
        topUp: 'Top up',
        reading: 'Reading balance',
        back: 'Back',
        retry: 'Retry',
        unavailable: 'Balance unavailable',
        sessionCost: 'Session estimate',
        estimateReading: 'Reading official prices',
        estimateUnavailable: 'Prices unavailable',
      },
    };

    const CSS = [
      /* Trigger metrics are copied from the context meter's own trigger so the
         dock line keeps one type scale and one hover tint. The dock renders its
         slot entries before the built-in context meter, so the pill asks the
         flex row to reorder itself to the far right. */
      '.dsh-balance-pill{flex:none;order:1;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;',
      'border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);',
      'font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer}',
      '.dsh-balance-pill[data-phase=failed]{color:var(--dsw-alias-label-tertiary)}',
      '@media (hover:hover){.dsh-balance-pill:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}}',
      '.dsh-balance-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
      'justify-content:center;background:var(--dsw-alias-bg-mask-1,oklch(0 0 0 / 35%));',
      'backdrop-filter:var(--dsw-mask-blur,blur(2px))}',
      '.dsh-balance-overlay__panel{z-index:1;display:flex;flex-direction:column;width:800px;',
      'max-width:calc(100vw - 48px);height:min(800px,calc(100vh - 2 * max(24px,var(--dsh-frame-overlay-top,24px))));',
      'border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#111));',
      'color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-elevation-prominent,0 12px 32px oklch(0 0 0 / 40%));',
      'overflow:hidden}',
      '.dsh-balance-overlay__header{display:flex;align-items:center;gap:8px;flex:none;height:48px;padding:6px 16px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l1,oklch(1 0 0 / 8%))}',
      '.dsh-balance-overlay__back{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;',
      'border-radius:var(--dsw-radius-sm);background:0 0;',
      'color:var(--dsw-alias-label-secondary,inherit);font-family:inherit;font-size:14px;cursor:pointer}',
      '.dsh-balance-overlay__back:hover{background:var(--dsw-alias-interactive-bg-hover,oklch(1 0 0 / 8%))}',
      '.dsh-balance-overlay__title{font-size:14px;opacity:.65}',
      '.dsh-balance-overlay__viewport{position:relative;flex:1;min-height:0;background:transparent}',
      '.dsh-balance-overlay__status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'font-size:13px;opacity:.6;pointer-events:none}',
    ].join('');

    function symbolOf(currency) {
      if (currency === 'USD') return '$';
      return '¥';
    }

    /**
     * Strip the words around the cache-hit percentage the usage pill shows to
     * our right: `缓存命中 98%` / `Cache hit 98%` become `98%`. Every language is
     * rewritten, so switching the interface language keeps the short form.
     */
    function shortenCacheHitLabel(locale) {
      if (!locale || typeof locale !== 'object') return;
      if (locale.__dshBalancePillCacheHit === true) return;
      let rewritten = false;
      let blocked = false;
      const dictionaries = locale.dicts?.get?.(USAGE_NAMESPACE);
      if (dictionaries && typeof dictionaries.values === 'function') {
        for (const dict of dictionaries.values()) {
          if (!dict || typeof dict !== 'object') continue;
          if (typeof dict[USAGE_CACHE_HIT_KEY] !== 'string') continue;
          if (dict[USAGE_CACHE_HIT_KEY] === CACHE_HIT_SHORT) continue;
          try {
            dict[USAGE_CACHE_HIT_KEY] = CACHE_HIT_SHORT;
            if (dict[USAGE_CACHE_HIT_KEY] === CACHE_HIT_SHORT) rewritten = true;
            else blocked = true;
          } catch {
            blocked = true;
          }
        }
      }
      if (blocked || !dictionaries) {
        const translate = locale.translate;
        if (typeof translate === 'function' && translate.__dshBalancePill !== true) {
          const short = (ns, key, params) => {
            if (ns === USAGE_NAMESPACE && key === USAGE_CACHE_HIT_KEY) {
              const percent = params?.percent;
              return percent === undefined || percent === null ? '' : `${percent}%`;
            }
            return translate.call(locale, ns, key, params);
          };
          short.__dshBalancePill = true;
          try {
            locale.translate = short;
            rewritten = true;
          } catch {
            /* keep the packaged wording */
          }
        }
      }
      if (rewritten) {
        try {
          Object.defineProperty(locale, '__dshBalancePillCacheHit', {
            value: true,
            configurable: true,
            enumerable: false,
            writable: true,
          });
        } catch {
          /* the retry loop stops once the dictionaries carry the short form */
        }
        try {
          locale.publish?.(locale.getSnapshot?.().active ?? 'en', false);
        } catch {
          /* the next render picks the short form up anyway */
        }
      }
    }

    function walletOf(payload) {
      if (!payload) return null;
      const wallets = Array.isArray(payload)
        ? payload
        : payload.status === 'ready' && Array.isArray(payload.value)
          ? payload.value
          : [];
      if (wallets.length === 0) return null;
      return wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0];
    }

    function formatWallet(wallet) {
      if (!wallet) return '';
      const raw = typeof wallet.balance === 'string' ? wallet.balance.trim() : String(wallet.balance ?? '');
      if (raw === '') return '';
      const amount = Number(raw);
      const text = Number.isFinite(amount) ? (Math.round(amount * 10) / 10).toFixed(1) : raw;
      return `${symbolOf(wallet.currency)}${text}`;
    }

    function clientMetadata(ctx) {
      const boot = typeof globalThis.__DSH_BOOT__ === 'object' && globalThis.__DSH_BOOT__ !== null
        ? globalThis.__DSH_BOOT__
        : undefined;
      const version = boot && boot.release && typeof boot.release.version === 'string' ? boot.release.version : '';
      return {
        version: version !== '' ? version : '0.0.0',
        locale: ctx.locale.getLocale().active,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
    }

    function createStore(ctx) {
      let state = { phase: 'idle', wallet: null, topUpUrl: null, overlay: false };
      const listeners = new Set();
      const publish = (patch) => {
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
      };
      let inflight = null;

      const load = () => {
        if (inflight) return inflight;
        inflight = (async () => {
          try {
            const meta = clientMetadata(ctx);
            const [balance, account] = await Promise.all([
              ctx.remote.account.getBalance(meta),
              ctx.remote.account.getState(),
            ]);
            const wallet = balance && balance.ok ? walletOf(balance.value) : null;
            const topUpUrl = account && account.ok && account.value && account.value.links
              ? account.value.links.topUpUrl
              : state.topUpUrl;
            publish({ phase: balance && balance.ok ? 'ready' : 'failed', wallet, topUpUrl });
          } catch {
            publish({ phase: 'failed' });
          } finally {
            inflight = null;
          }
        })();
        return inflight;
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getSnapshot() {
          return state;
        },
        load,
        setOverlay(open) {
          if (state.overlay !== open) publish({ overlay: open });
        },
        refresh() {
          inflight = null;
          return load();
        },
      };
    }

    function openExternal(url) {
      if (typeof url !== 'string' || url === '') return;
      globalThis.open(url, '_blank', 'noopener,noreferrer');
    }

    /** Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday. */
    function isPeakTime(date) {
      const day = date.getUTCDay();
      if (day === 0 || day === 6) return false;
      const hour = date.getUTCHours();
      return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to);
    }

    /** Unknown model ids fall back to the Flash tier the deployment mostly runs. */
    function priceEntry(models, modelId) {
      if (!models || typeof models !== 'object') return null;
      if (typeof modelId === 'string' && models[modelId]) return models[modelId];
      if (typeof modelId === 'string' && /pro/i.test(modelId)) return models['deepseek-v4-pro'] ?? null;
      return models['deepseek-flash'] ?? null;
    }

    function tokenTotals(usage) {
      if (!usage || typeof usage !== 'object') return null;
      // The projection may arrive as { totals, last } or already flattened.
      const buckets = usage.totals && typeof usage.totals === 'object' ? usage.totals : usage;
      const pick = (key) => (typeof buckets[key] === 'number' && Number.isFinite(buckets[key]) ? buckets[key] : 0);
      return {
        cacheRead: pick('cacheReadTokens'),
        cacheMiss: pick('uncachedInputTokens') + pick('cacheWriteTokens'),
        output: pick('outputTokens'),
      };
    }

    /** Estimated USD spend: each token bucket times its official price. */
    function estimateCost(usage, priceState, modelId, now) {
      const totals = tokenTotals(usage);
      if (totals === null) return null;
      const model = priceEntry(priceState?.data?.models, modelId);
      if (model === null) return null;
      const band = isPeakTime(now) ? 'peak' : 'offPeak';
      const cost = (
        totals.cacheRead * (model.cacheHit?.[band] ?? 0)
        + totals.cacheMiss * (model.cacheMiss?.[band] ?? 0)
        + totals.output * (model.output?.[band] ?? 0)
      ) / 1_000_000;
      return Number.isFinite(cost) ? cost : null;
    }

    function formatUsd(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '—';
      /* One decimal, like the wallet figure next to it; a spend too small to
         survive that rounding is reported as a floor instead of "$0.0". */
      if (number > 0 && number < 0.05) return '<$0.1';
      return `$${number.toFixed(1)}`;
    }

    /**
     * Official prices are fetched by the host half (the docs origin sends no
     * CORS headers) and cached here for a working day.
     */
    function createPriceStore() {
      let state = { phase: 'idle', data: null, code: null };
      let at = 0;
      let inflight = null;
      const listeners = new Set();
      const publish = (patch) => {
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
      };

      const load = (force = false) => {
        if (!force && state.phase === 'ready' && Date.now() - at < PRICES_TTL_MS) return Promise.resolve(state.data);
        if (inflight !== null) return inflight;
        if (state.phase !== 'ready') publish({ phase: 'loading' });
        inflight = (async () => {
          try {
            const response = await fetch(PRICES_ENDPOINT, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || body === null || body.ok !== true) {
              publish({ phase: 'failed', code: body && typeof body.code === 'string' ? body.code : 'http_' + response.status });
              return null;
            }
            at = Date.now();
            publish({ phase: 'ready', data: body.data, code: null });
            return body.data;
          } catch {
            publish({ phase: 'failed', code: 'network' });
            return null;
          } finally {
            inflight = null;
          }
        })();
        return inflight;
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getSnapshot() {
          return state;
        },
        load,
      };
    }

    function BalancePill(props) {
      const { store, prices, bridge, t, useProjection } = props;
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const priceState = React.useSyncExternalStore(prices.subscribe, prices.getSnapshot, prices.getSnapshot);
      const readsProjections = typeof useProjection === 'function';
      const tokenUsage = readsProjections ? useProjection('tokenUsage') : undefined;
      const modelSelection = readsProjections ? useProjection('modelSelection') : undefined;

      React.useEffect(() => {
        let cancelled = false;
        const run = () => {
          if (!cancelled) store.load().catch(() => {});
        };
        run();
        const timer = setInterval(run, REFRESH_MS);
        const onFocus = () => run();
        globalThis.addEventListener('focus', onFocus);
        return () => {
          cancelled = true;
          clearInterval(timer);
          globalThis.removeEventListener('focus', onFocus);
        };
      }, [store]);

      /* The price feed is what the hover label reads, so it loads with the pill
         instead of waiting for a pointer to arrive. */
      React.useEffect(() => {
        prices.load().catch(() => {});
      }, [prices]);

      const onClick = (event) => {
        event.preventDefault();
        const snapshot = store.getSnapshot();
        if (typeof bridge?.open === 'function') {
          store.setOverlay(true);
          if (snapshot.topUpUrl === null) store.load().catch(() => {});
          return;
        }
        if (typeof snapshot.topUpUrl === 'string' && snapshot.topUpUrl !== '') {
          openExternal(snapshot.topUpUrl);
          return;
        }
        store.refresh().catch(() => {});
      };

      const modelId = modelSelection && typeof modelSelection === 'object'
        ? (modelSelection.next ?? modelSelection.current)?.model
        : undefined;
      const cost = estimateCost(tokenUsage, priceState, modelId, new Date());
      let estimate;
      if (cost === null) {
        estimate = t(priceState.phase === 'failed' ? 'estimateUnavailable' : 'estimateReading');
      } else {
        const figure = formatUsd(cost);
        /* A "<$0.1" floor is already approximate, so it carries no tilde. */
        estimate = figure.startsWith('<') ? figure : `~${figure}`;
      }
      const hint = `${t('sessionCost')} ${estimate}`;

      const text = state.wallet ? formatWallet(state.wallet) : '—';
      const title = state.wallet || state.topUpUrl ? t('topUp') : t(state.phase === 'failed' ? 'retry' : 'reading');

      const trigger = h('button', {
        type: 'button',
        className: 'dsh-balance-pill',
        'data-phase': state.phase,
        'data-dsh-balance-pill': '',
        'aria-label': `${title} · ${hint}`,
        'aria-description': hint,
        onClick,
      }, text);

      /* The context meter shows its hover text through this exact component, so
         reusing it keeps the label's surface, type scale and placement
         identical instead of approximating them with our own panel. */
      if (typeof Tooltip !== 'function') return trigger;
      return h(Tooltip, { label: hint, side: 'top', delayMs: 200, portal: true }, trigger);
    }

    function BalanceTopUpOverlay(props) {
      const { store, bridge, t } = props;
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const [phase, setPhase] = React.useState('loading');
      const viewportRef = React.useRef(null);
      const backRef = React.useRef(null);
      const open = state.overlay === true && typeof bridge?.open === 'function';

      React.useEffect(() => {
        if (!open) {
          setPhase('loading');
          return undefined;
        }
        const element = viewportRef.current;
        if (element === null) return undefined;
        let disposed = false;
        let observer;

        const bounds = () => {
          const rect = element.getBoundingClientRect();
          const clamp = (value, min) => Math.min(100000, Math.max(min, Math.round(value)));
          return {
            x: clamp(rect.x, 0),
            y: clamp(rect.y, 0),
            width: clamp(rect.width, 1),
            height: clamp(rect.height, 1),
          };
        };

        const fallbackToBrowser = () => {
          openExternal(store.getSnapshot().topUpUrl);
          store.setOverlay(false);
        };

        setPhase('loading');
        Promise.resolve(bridge.open(TOP_UP_PAGE, bounds())).then(
          () => {
            if (disposed) return;
            setPhase('ready');
            observer = new ResizeObserver(() => {
              Promise.resolve(bridge.setBounds(bounds())).catch(() => {});
            });
            observer.observe(element);
          },
          () => {
            if (!disposed) fallbackToBrowser();
          },
        );

        return () => {
          disposed = true;
          if (observer !== undefined) observer.disconnect();
          Promise.resolve(bridge.close()).catch(() => {});
          store.refresh().catch(() => {});
        };
      }, [open, bridge, store]);

      React.useEffect(() => {
        if (!open) return undefined;
        const previousFocus = document.activeElement;
        backRef.current?.focus();
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          store.setOverlay(false);
        };
        globalThis.addEventListener('keydown', onKeyDown, true);
        return () => {
          globalThis.removeEventListener('keydown', onKeyDown, true);
          if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
      }, [open, store]);

      if (!open) return null;

      return h('div', {
        className: 'dsh-balance-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('topUp'),
        onClick: (event) => {
          if (event.target === event.currentTarget) store.setOverlay(false);
        },
      },
      h('div', { className: 'dsh-balance-overlay__panel' },
        h('header', { className: 'dsh-balance-overlay__header', 'data-window-drag': true },
          h('button', {
            type: 'button',
            ref: backRef,
            className: 'dsh-balance-overlay__back',
            onClick: () => store.setOverlay(false),
          }, `‹ ${t('back')}`),
          h('span', { className: 'dsh-balance-overlay__title' }, t('topUp')),
        ),
        h('div', { className: 'dsh-balance-overlay__viewport', ref: viewportRef },
          phase === 'loading' ? h('div', { className: 'dsh-balance-overlay__status' }, t('reading')) : null,
        ),
      ));
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account', 'remoteAccess'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const selector = `style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`;
          if (document.querySelector(selector) !== null) return () => {};
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-balance-pill';
          tag.dataset.pluginCss = STYLE_TAG_ID;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'balance-pill: styles');

        for (const [locale, dict] of Object.entries(MESSAGES)) {
          ctx.effect(() => {
            try {
              return ctx.locale.register(NS, locale, dict);
            } catch {
              return () => {};
            }
          }, `balance-pill: locale ${locale}`);
        }

        const store = createStore(ctx);
        const prices = createPriceStore();
        const bridge = globalThis.dshPlatform;

        ctx.effect(() => {
          shortenCacheHitLabel(ctx.locale);
          const timers = [0, 250, 1_000, 3_000].map((delay) => setTimeout(() => {
            shortenCacheHitLabel(ctx.locale);
          }, delay));
          return () => {
            for (const timer of timers) clearTimeout(timer);
          };
        }, 'balance-pill: shorten cache hit label');

        ctx.remoteAccess.whenAccess('account/getBalance', () => ctx.slots.inject(
          'conversation.composer.dock',
          () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'balance-pill',
            order: 100,
            label: 'Balance',
            locale: NS,
            inject: () => ({
              store,
              prices,
              bridge,
            }),
          }, BalancePill),
        ));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'balance-pill-top-up',
          locale: NS,
          inject: () => ({ store, bridge }),
        }, BalanceTopUpOverlay));
      },
    };
  },
});
