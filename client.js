window.__ModuleLoader__.load({
  id: '@local/perplexity-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React
    const NS = 'perplexity-guard'

    const STRINGS = {
      zh: {
        nav: 'Perplexity',
        title: 'Perplexity 守護',
        intro: '請求送出前會補上 Opus 5.5、Sonnet 5.5、GPT-6.1 Sol 常見缺漏：Anthropic 的輸出上限、保留工具名、空 schema，以及這個 adapter 不接受的 stop。下面的修復會寫入 provider 設定，不會刪走其他模型，也不會改你自訂的 base URL。',
        live: '即時修復',
        on: '開啟',
        off: '關閉',
        findings: '設定檢查',
        clear: '這三個模型的必要設定都在。',
        models: '模型',
        missing: '未設定 Perplexity provider。',
        activity: '最近修復',
        emptyActivity: '這個程序還沒有改過請求。',
        repair: '修復設定',
        repairing: '修復中…',
        refresh: '重新檢查',
        repaired: '已寫入設定。下一個請求會用新設定。',
        unchanged: '沒有需要寫入的設定。',
        failed: '操作失敗：',
        loading: '讀取中…',
        idle: '長連線閒置',
        minutes: '分鐘',
      },
      en: {
        nav: 'Perplexity',
        title: 'Perplexity guard',
        intro: 'Before a request leaves, missing Opus 5.5, Sonnet 5.5, and GPT-6.1 Sol parameters are filled in: the Anthropic output cap, reserved tool names, empty schemas, and stop sequences this adapter rejects. Repair writes those provider settings. It does not remove other models or replace a custom base URL.',
        live: 'Live repair',
        on: 'On',
        off: 'Off',
        findings: 'Settings',
        clear: 'The required settings for these three models are present.',
        models: 'Models',
        missing: 'The Perplexity provider is not configured.',
        activity: 'Recent repairs',
        emptyActivity: 'No request has been rewritten in this process yet.',
        repair: 'Repair settings',
        repairing: 'Repairing…',
        refresh: 'Check again',
        repaired: 'Settings saved. The next request uses them.',
        unchanged: 'Nothing needed to be written.',
        failed: 'Could not complete that: ',
        loading: 'Loading…',
        idle: 'Stream idle',
        minutes: 'min',
      },
    }

    function Icon({ size = 16, active }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M12 3.2l7 3v5.2c0 4.4-2.9 7.6-7 8.6-4.1-1-7-4.2-7-8.6V6.2l7-3z' }),
      h('path', { d: 'M8.8 12.2l2.1 2.1 4.3-4.6' }))
    }

    function api(pathname, body) {
      return fetch(pathname, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then(async response => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `HTTP ${response.status}`)
        }
        return payload
      })
    }

    function formatTime(value) {
      if (!value) return ''
      try {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      } catch {
        return ''
      }
    }

    function Page({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      async function load() {
        const next = await api('/perplexity-guard/api/state')
        setState(next)
        setError('')
      }

      useEffect(() => {
        let stop = false
        load().catch(cause => {
          if (!stop) setError(cause instanceof Error ? cause.message : String(cause))
        })
        const timer = setInterval(() => {
          load().catch(() => undefined)
        }, 5000)
        return () => {
          stop = true
          clearInterval(timer)
        }
      }, [])

      async function repair() {
        setBusy(true)
        setNotice('')
        setError('')
        try {
          const result = await api('/perplexity-guard/api/repair', {})
          setNotice(result.changes?.length ? t('repaired') : t('unchanged'))
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const findings = state?.findings ?? []
      const models = state?.provider?.models ?? []
      const activity = state?.activity ?? []
      const idle = state?.provider?.streamIdleTimeoutMs

      return h('section', { className: 'pg-page' },
        h('style', null, CSS),
        h('header', { className: 'pg-head' },
          h('h1', { className: 'pg-title' }, t('title')),
          h('p', { className: 'pg-intro' }, t('intro'))),
        h('div', { className: 'pg-row' },
          h('span', { className: 'pg-pill' }, `${t('live')} · ${state?.enabled ? t('on') : t('off')}`),
          idle ? h('span', { className: 'pg-pill' }, `${t('idle')} · ${Math.round(idle / 60000)} ${t('minutes')}`) : null,
          h('span', { className: 'pg-spacer' }),
          h('button', { type: 'button', className: 'pg-btn', onClick: () => load().catch(cause => setError(String(cause.message ?? cause))) }, t('refresh')),
          h('button', {
            type: 'button',
            className: 'pg-btn primary',
            disabled: busy,
            onClick: () => void repair(),
          }, busy ? t('repairing') : t('repair'))),
        error ? h('p', { className: 'pg-error', role: 'alert' }, `${t('failed')}${error}`) : null,
        notice ? h('p', { className: 'pg-ok' }, notice) : null,
        h('h2', { className: 'pg-section' }, t('findings')),
        !state
          ? h('p', { className: 'pg-muted' }, t('loading'))
          : findings.length === 0
            ? h('p', { className: 'pg-ok' }, state.provider?.present ? t('clear') : t('missing'))
            : h('ul', { className: 'pg-list' }, findings.map(item => h('li', {
              key: `${item.code}:${item.detail}`,
              className: item.level === 'error' ? 'pg-item bad' : 'pg-item warn',
            }, `${item.code} · ${item.detail}`))),
        h('h2', { className: 'pg-section' }, t('models')),
        h('ul', { className: 'pg-list' }, models.map(model => h('li', { key: model.id, className: 'pg-item' },
          h('strong', null, model.name || model.id),
          h('span', { className: 'pg-meta' }, [
            model.id,
            model.maxTokens ? `max ${model.maxTokens}` : 'max —',
            model.contextWindow ? `ctx ${model.contextWindow}` : 'ctx —',
            model.reasoning?.length ? model.reasoning.join('/') : 'effort —',
          ].join(' · '))))),
        h('h2', { className: 'pg-section' }, t('activity')),
        activity.length === 0
          ? h('p', { className: 'pg-muted' }, t('emptyActivity'))
          : h('ul', { className: 'pg-list' }, activity.slice(0, 12).map(item => h('li', {
            key: `${item.at}:${item.kind}:${item.detail}`,
            className: 'pg-item',
          }, h('span', { className: 'pg-meta' }, `${formatTime(item.at)} · ${item.kind}`), item.detail))))
    }

    const CSS = `
      .pg-page { box-sizing: border-box; height: 100%; overflow: auto; padding: 28px 32px 48px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 14px; line-height: 1.5; }
      .pg-head { max-width: 760px; margin-bottom: 18px; }
      .pg-title { margin: 0 0 8px; font-size: 22px; font-weight: 640; letter-spacing: 0; }
      .pg-intro, .pg-muted { margin: 0; color: var(--dsw-alias-label-secondary); max-width: 68ch; }
      .pg-row { display: flex; align-items: center; gap: 8px; max-width: 760px; margin: 18px 0; }
      .pg-spacer { flex: 1; }
      .pg-pill, .pg-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 999px; padding: 6px 12px; font: inherit; }
      .pg-btn { cursor: pointer; }
      .pg-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      .pg-btn.primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-color: transparent; }
      .pg-btn:disabled { opacity: 0.6; cursor: default; }
      .pg-section { margin: 22px 0 8px; font-size: 13px; font-weight: 640; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .pg-list { list-style: none; margin: 0; padding: 0; max-width: 760px; display: grid; gap: 8px; }
      .pg-item { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 10px 12px; }
      .pg-item.bad { border-color: var(--dsw-alias-state-error-primary); }
      .pg-item.warn { border-color: var(--dsw-alias-state-warn-primary); }
      .pg-meta { display: block; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .pg-error { color: var(--dsw-alias-state-error-primary); }
      .pg-ok { color: var(--dsw-alias-state-success-primary); }
    `

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en }), 'perplexity-guard: dictionaries')
          t = ctx.locale.bind(NS)
        } catch {
          t = key => STRINGS.en[key] ?? STRINGS.zh[key] ?? key
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'perplexity-guard',
          order: 16,
          label: () => t('nav'),
          locale: NS,
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'perplexity-guard',
          locale: NS,
        }, () => h(Page, { t })))
      },
    }
  },
})
