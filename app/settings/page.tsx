import { grantsBookUpdatedAt, GRANTS_BOOK_URL } from "@/lib/grants-book";

export default function SettingsPage() {
  const kaspiConfigured = Boolean(process.env.KASPI_API_KEY);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const baseUrl = process.env.KASPI_API_BASE_URL ?? "https://kaspi.kz/shop/api/v2";

  return (
    <>
      <header className="header">
        <div><div className="eyebrow">ИНТЕГРАЦИИ</div><h1>Настройки</h1><p className="muted">Статус Kaspi API, GRANTS BOOK и базы данных</p></div>
      </header>

      <section className="settings-grid integrations-three">
        <article className="panel integration-card">
          <div className="integration-head"><div className="integration-logo">K</div><div><h2>Kaspi Магазин</h2><p className="muted">API заказов и товаров</p></div></div>
          <div className={`connection-status ${kaspiConfigured ? "connected" : "disconnected"}`}><span />{kaspiConfigured ? "API-токен подключён" : "Нужен Kaspi API-токен"}</div>
          <dl className="settings-list"><div><dt>API URL</dt><dd>{baseUrl}</dd></div><div><dt>Секрет</dt><dd>KASPI_API_KEY</dd></div></dl>
        </article>

        <article className="panel integration-card">
          <div className="integration-head"><div className="integration-logo sheet-logo">G</div><div><h2>GRANTS BOOK</h2><p className="muted">Прибыль и товарный прайс</p></div></div>
          <div className="connection-status connected"><span />Облачный файл найден и связан</div>
          <dl className="settings-list"><div><dt>Последний снимок</dt><dd>{grantsBookUpdatedAt}</dd></div><div><dt>Листы</dt><dd>Прайс KASPI · KASPI_ПРОДАЖИ</dd></div></dl>
          <a className="button secondary settings-link" href={GRANTS_BOOK_URL} target="_blank" rel="noreferrer">Открыть таблицу ↗</a>
        </article>

        <article className="panel integration-card">
          <div className="integration-head"><div className="integration-logo db-logo">DB</div><div><h2>PostgreSQL</h2><p className="muted">Заказы, товары, расходы и сканирования</p></div></div>
          <div className={`connection-status ${databaseConfigured ? "connected" : "disconnected"}`}><span />{databaseConfigured ? "База подключена" : "База пока не подключена"}</div>
          <dl className="settings-list"><div><dt>Переменная</dt><dd>DATABASE_URL</dd></div><div><dt>ORM</dt><dd>Prisma</dd></div></dl>
        </article>
      </section>

      <div className="panel next-step-card">
        <h2>Kaspi API-токен</h2>
        <p>Код уже читает токен только из серверного секрета <code>KASPI_API_KEY</code>. Сам токен нельзя сохранять в публичном GitHub. В текущем GRANTS BOOK найден служебный ключ синхронизации, но это не подтверждённый <code>X-Auth-Token</code> Kaspi, поэтому я намеренно его не использую как API-токен.</p>
      </div>
    </>
  );
}
