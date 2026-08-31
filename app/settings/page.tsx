export default function SettingsPage() {
  const kaspiConfigured = Boolean(process.env.KASPI_API_KEY);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const baseUrl = process.env.KASPI_API_BASE_URL ?? "https://kaspi.kz/shop/api/v2";

  return (
    <>
      <header className="header">
        <div><div className="eyebrow">ИНТЕГРАЦИИ</div><h1>Настройки</h1><p className="muted">Статус подключения Kaspi и базы данных</p></div>
      </header>

      <section className="settings-grid">
        <article className="panel integration-card">
          <div className="integration-head"><div className="integration-logo">K</div><div><h2>Kaspi Магазин</h2><p className="muted">API заказов и товаров</p></div></div>
          <div className={`connection-status ${kaspiConfigured ? "connected" : "disconnected"}`}><span />{kaspiConfigured ? "API-ключ подключён" : "API-ключ пока не добавлен"}</div>
          <dl className="settings-list"><div><dt>API URL</dt><dd>{baseUrl}</dd></div><div><dt>Переменная</dt><dd>KASPI_API_KEY</dd></div></dl>
        </article>

        <article className="panel integration-card">
          <div className="integration-head"><div className="integration-logo db-logo">DB</div><div><h2>PostgreSQL</h2><p className="muted">Заказы, товары, расходы и история сканирований</p></div></div>
          <div className={`connection-status ${databaseConfigured ? "connected" : "disconnected"}`}><span />{databaseConfigured ? "База подключена" : "База пока не подключена"}</div>
          <dl className="settings-list"><div><dt>Переменная</dt><dd>DATABASE_URL</dd></div><div><dt>ORM</dt><dd>Prisma</dd></div></dl>
        </article>
      </section>

      <div className="panel next-step-card">
        <h2>Что нужно для реальных данных</h2>
        <p>Добавить секрет <code>KASPI_API_KEY</code> в переменные окружения Vercel. Сам ключ в GitHub не сохраняется. После этого серверный маршрут <code>/api/kaspi/orders</code> сможет получать реальные заказы.</p>
      </div>
    </>
  );
}
