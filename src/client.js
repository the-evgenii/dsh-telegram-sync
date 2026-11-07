window.__ModuleLoader__.load({
  id: 'dsh-telegram-sync',
  factory(require) {
    const React = require('react');
    const { Button, Switch, SettingsValueField, SettingsSecretField, CommandText } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const secrets = new Set(['gatewayToken', 'relayAdminToken', 'botToken', 'macGatewayToken', 'vpsGatewayToken']);
    const defaults = { gatewayEnabled: true, manageRelay: false, ownerId: 0,
      exclusiveBotConfirmed: false, macGatewayId: 'local', vpsGatewayId: 'server',
      silentMessages: true, questions: true, completion: true, mentions: true };
    const errors = {
      'relay-admin-unavailable': 'Сервер недоступен или ещё не обновлён для страницы настроек.',
      'relay-admin-unauthorized': 'Неверный ключ администратора relay. Это отдельный ключ, не токен Mac/VPS.',
      'admin-incomplete': 'Укажите адрес сервера и ключ администратора relay.',
      'gateway-incomplete': 'Для подключения нужны адрес сервера, ID машины и её токен.',
      'gateway-start-failed': 'Подключение не запустилось. Проверьте поля и состояние плагина.',
      'gateway-check-failed': 'Проверка машины не прошла: проверьте URL, ID и токен.',
      'gateway-credentials': 'Ключи Mac/VPS должны быть разными и не короче 32 символов.',
      'bot-verification-failed': 'Не удалось проверить бота. Проверьте токен, режим тем в BotFather и отсутствие другого обработчика.',
      'owner-change-requires-new-relay': 'Для смены владельца нужен отдельный новый relay: существующие темы принадлежат прежнему пользователю.',
      'bot-change-requires-new-relay': 'Нельзя перенести существующие темы другому боту. Используйте отдельный relay.',
      'settings-busy': 'Сервер применяет предыдущие настройки. Повторите после завершения.',
      'owner-id': 'Telegram ID должен быть целым положительным числом.',
      'connection-invalid': 'Проверьте настройки. Для удалённого сервера нужен HTTPS; HTTP разрешён только через localhost.',
      'relay-settings-rejected': 'Сервер отклонил настройки; действующая конфигурация сохранена.',
    };
    function buildMutations(dirty) {
      return Object.entries(dirty).filter(([key, value]) => !secrets.has(key) || value !== '')
        .map(([key, value]) => ({ op: 'set', path: ['settings', key], value }));
    }
    function apply(ctx) {
      async function rpc(method) {
        const result = await ctx.connection.rpc.call('/api', `telegramSync/${method}`, { args: { request: {} } });
        if (!result.ok) throw new Error('Не удалось выполнить действие. Требуется подключение владельца Harness.');
        return result.value;
      }
      function SettingsPage() {
        const form = ctx.configForms.get('telegram-conversation-sync');
        return form ? h(SettingsForm, { form }) : h('p', null, 'Включите Telegram Sync в списке плагинов и обновите страницу.');
      }
      function SettingsForm({ form }) {
        const snapshot = React.useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot());
        const [dirty, setDirty] = React.useState({});
        const [status, setStatus] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [message, setMessage] = React.useState('');
        const [showSecrets, setShowSecrets] = React.useState(false);
        React.useEffect(() => {
          let mounted = true;
          rpc('status').then(value => value.adminTokenConfigured ? rpc('check') : value)
            .then(value => { if (mounted) setStatus(value); }).catch(() => {});
          return () => { mounted = false; };
        }, []);
        if (snapshot.status === 'loading') return h('p', null, 'Загрузка настроек Telegram Sync…');
        if (snapshot.status === 'unavailable') return h('p', { role: 'alert' }, 'Настройки плагина недоступны. Включите Telegram Sync в списке плагинов и обновите страницу.');
        const persisted = snapshot.value?.settings ?? {};
        const value = key => {
          if (Object.hasOwn(dirty, key)) return dirty[key];
          if (secrets.has(key)) return '';
          if (key === 'ownerId' && !persisted[key] && status?.relay?.ownerId) return status.relay.ownerId;
          if (typeof persisted[key] === 'boolean') return persisted[key];
          return persisted[key] || status?.[key] || defaults[key] || '';
        };
        const update = (key, next) => setDirty(previous => ({ ...previous, [key]: next }));
        const noteStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', margin: '8px 0' };
        const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '12px 0',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)' };
        function field(key, label, type = 'text', help = '') {
          const onEdit = text => update(key, type === 'number' ? Number(text) : text);
          const shared = { key, id: `telegram-sync-${key}`, label, hint: help,
            text: String(value(key)), disabled: busy || !snapshot.writable, onEdit };
          if (secrets.has(key) && !showSecrets) {
            const configured = key === 'gatewayToken' ? status?.gatewayTokenConfigured
              : key === 'relayAdminToken' ? status?.adminTokenConfigured
              : key === 'botToken' ? status?.relay?.botTokenConfigured
              : status?.relay?.gateways?.some(gateway => gateway.id === value(key === 'macGatewayToken' ? 'macGatewayId' : 'vpsGatewayId'));
            return h(SettingsSecretField, { ...shared, configured: Boolean(configured),
              stateLabel: configured ? 'Ключ сохранён. Пустое поле сохраняет его.' : 'Пустое поле сохраняет существующий ключ.' });
          }
          return h(SettingsValueField, { ...shared, numeric: type === 'number', overridden: false, invalid: false,
            overriddenLabel: 'Изменено', resetLabel: 'Сбросить', invalidLabel: 'Проверьте значение', onReset: () => {},
            placeholder: secrets.has(key) ? 'Пусто — сохранить существующий ключ' : '' });
        }
        function toggle(key, label) {
          return h('div', { key, 'data-setting': key, style: rowStyle },
            h('span', null, label),
            h(Switch, { checked: Boolean(value(key)), disabled: busy || !snapshot.writable, label,
              onChange: next => update(key, next) }));
        }
        function section(title, children) {
          return h('section', { style: { marginTop: 24 } },
            h('h3', { style: { margin: '0 0 4px', fontSize: 14, lineHeight: '20px', fontWeight: 500 } }, title), children);
        }
        function generate(machine) {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
          update(`${machine}GatewayToken`, token);
          if (value('gatewayId') === value(`${machine}GatewayId`)) update('gatewayToken', token);
          setMessage('Ключ создан. Сохраните его для второй машины до применения: после сохранения секрет будет скрыт.');
          setShowSecrets(true);
        }
        async function perform(save) {
          setBusy(true); setMessage('');
          try {
            if (save) {
              const ops = buildMutations(dirty);
              if (ops.length && !await form.mutate(ops, snapshot.revision)) throw new Error('Настройки изменились или сохранение отклонено. Проверьте поля и повторите.');
            }
            const next = await rpc(save ? 'apply' : 'check');
            setStatus(next);
            if (next.error) setMessage(errors[next.error] ?? 'Не удалось применить настройки.');
            else {
              if (save) { setDirty({}); setShowSecrets(false); }
              setMessage(save ? 'Настройки сохранены и применены.' : next.relay?.ready ? 'Сервер доступен, relay настроен.' : 'Сервер доступен; настройте Telegram и ключи машин.');
            }
          } catch (error) { setMessage(error.message); }
          finally { setBusy(false); }
        }
        return h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '20px' } },
          h('h2', { style: { margin: '0 0 8px', fontSize: 16, lineHeight: '24px', fontWeight: 600 } }, 'Telegram Sync'),
          h('p', { style: noteStyle }, 'Один Telegram-бот для Mac и VPS. Все изменения сохраняются в профиле Harness; серверные настройки применяются к relay по отдельному ключу администратора.'),
          status ? h('p', { role: 'status' }, status.gatewayRunning ? 'Шлюз этой машины запущен.' : 'Шлюз этой машины не запущен.',
            status.error ? ` ${errors[status.error] ?? 'Проверьте настройки.'}` : '') : null,
          !snapshot.writable ? h('p', { role: 'alert' }, 'Настройки доступны для изменения только владельцу Harness.') : null,
          section('Подключение этой машины', [
            toggle('gatewayEnabled', 'Подключать эту машину к Telegram'),
            field('relayUrl', 'Адрес relay', 'url', 'HTTPS для удалённого сервера или http://127.0.0.1:порт через SSH-туннель.'),
            field('gatewayId', 'ID этой машины', 'text', 'Обычно local для Mac и server для VPS. ID должен совпадать с каналом на relay.'),
            field('gatewayToken', 'Ключ этой машины'),
            field('newSessionCwd', 'Рабочий каталог новых диалогов', 'text', 'Абсолютный путь на этой машине. Проекты между Mac и VPS не копируются.'),
            field('statePath', 'Путь базы шлюза', 'text', 'Пусто — стандартный каталог Harness. Не меняйте базу действующего шлюза без переноса состояния.'),
          ]),
          section('Telegram и центральный сервер', [
            toggle('manageRelay', 'Применять настройки Telegram к серверу с этой страницы'),
            field('relayAdminToken', 'Ключ администратора relay', 'text', 'Получается при --init на сервере. Не совпадает с токеном бота или ключом Mac/VPS.'),
            field('ownerId', 'Telegram ID владельца (ownerId)', 'number', 'Числовой ID пользователя, не @username и не ID канала. Только этот пользователь управляет ботом.'),
            field('botToken', 'Токен Telegram-бота', 'text', 'Токен от BotFather. В BotFather должен быть включён режим тем в личном чате.'),
            toggle('exclusiveBotConfirmed', 'Другие обработчики этого бота остановлены; бот используется только этим relay'),
            h('p', { key: 'identity-warning', style: noteStyle }, 'Существующие темы нельзя передать другому владельцу или другому боту. Для такой смены нужен отдельный relay без прежней истории.'),
          ]),
          section('Каналы Mac и VPS на сервере', ['mac', 'vps'].map(machine => h('div', { key: machine, style: { marginBottom: 18 } },
            field(`${machine}GatewayId`, machine === 'mac' ? 'ID канала Mac' : 'ID канала VPS'),
            field(`${machine}GatewayToken`, machine === 'mac' ? 'Ключ канала Mac' : 'Ключ канала VPS'),
            h(Button, { variant: 'outline', size: 'sm', disabled: busy || !snapshot.writable, onClick: () => generate(machine) }, 'Сгенерировать ключ'),
            h('p', { style: noteStyle }, 'Этот же ID и ключ укажите в разделе подключения на соответствующей машине. Существующие каналы не удаляются.'),
          ))),
          section('Уведомления', [toggle('silentMessages', 'Обычная переписка без звука'), toggle('questions', 'Звук вопросов и подтверждений'),
            toggle('completion', 'Звук итогового ответа'), toggle('mentions', 'Звук упоминаний владельца')]),
          h('div', { style: rowStyle }, h('span', null, 'Показывать вводимые секреты'),
            h(Switch, { label: 'Показывать вводимые секреты', checked: showSecrets, onChange: setShowSecrets })),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 16 } },
            h(Button, { variant: 'primary', size: 'sm', disabled: busy || !snapshot.writable, onClick: () => perform(true) }, busy ? 'Подождите…' : 'Сохранить и применить'),
            h(Button, { variant: 'outline', size: 'sm', disabled: busy || !snapshot.writable, onClick: () => perform(false) }, 'Проверить сохранённое подключение')),
          message ? h('p', { role: 'status', style: { whiteSpace: 'pre-wrap' } }, message) : null,
          h('p', { style: noteStyle }, 'Изменение подключения переподключает шлюз и отменяет незавершённые подтверждения, не выдавая разрешений. Пустые секретные поля сохраняют прежние ключи.'),
          h('details', null, h('summary', null, 'Как подготовить сервер'),
            h('p', null, 'Установите Node.js 22.19+ и пакет. Один раз создайте защищённую конфигурацию:'),
            h(CommandText, { label: 'Команда подготовки relay', text: 'node bin/relay.mjs --init /absolute/private/relay.config.json' }),
            h('p', null, 'Команда выдаст ключ администратора. Запустите relay с созданным файлом и настройте HTTPS или SSH-туннель. Затем заполните эту страницу и включите применение к серверу. В установленном relay ключ администратора можно передать через DSH_SYNC_ADMIN_TOKEN без изменения ownerId и токенов бота.')),
        );
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'telegram-sync', order: 80,
        label: () => 'Telegram Sync' }, SettingsPage));
    }
    return { inject: ['slots', 'configForms', 'connection'], apply, buildMutations };
  },
});
