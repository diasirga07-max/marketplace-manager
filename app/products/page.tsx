import { grantsBookCatalogStats, grantsBookTopProducts, grantsBookUpdatedAt, GRANTS_BOOK_URL } from "@/lib/grants-book";

const money = (value: number | null) => value === null ? "—" : `₸ ${Math.round(value).toLocaleString("ru-RU")}`;

export default function ProductsPage() {
  return (
    <>
      <header className="header">
        <div>
          <div className="eyebrow">ПРАЙС KASPI · GRANTS BOOK</div>
          <h1>Товары и прибыль</h1>
          <p className="muted">Данные из Прайс KASPI и ТОП продаж из KASPI_ПРОДАЖИ. Снимок обновлён {grantsBookUpdatedAt}.</p>
        </div>
        <a className="button link-button" href={GRANTS_BOOK_URL} target="_blank" rel="noreferrer">Открыть полный GRANTS BOOK ↗</a>
      </header>

      <section className="cards product-stats">
        <article className="card metric-card"><span className="muted">Строк в прайсе</span><b>{grantsBookCatalogStats.rowsInPriceSheet.toLocaleString("ru-RU")}</b><span className="metric-note">Лист Прайс KASPI</span></article>
        <article className="card metric-card"><span className="muted">Распознано товаров</span><b>{grantsBookCatalogStats.recognizedProducts.toLocaleString("ru-RU")}</b><span className="metric-note">SKU + название</span></article>
        <article className="card metric-card profit-card"><span className="muted">Есть расчёт прибыли</span><b>{grantsBookCatalogStats.productsWithProfit.toLocaleString("ru-RU")}</b><span className="positive">Готовы к аналитике</span></article>
        <article className="card metric-card"><span className="muted">Без прибыли в прайсе</span><b>{(grantsBookCatalogStats.recognizedProducts - grantsBookCatalogStats.productsWithProfit).toLocaleString("ru-RU")}</b><span className="metric-note">Нужно проверить формулы/сопоставление</span></article>
      </section>

      <div className="panel table-panel products-table-panel">
        <div className="table-head-inline">
          <div><h2>ТОП-20 продаваемых товаров</h2><p className="muted">Завершённые заказы; рейтинг взят из листа KASPI_ПРОДАЖИ</p></div>
          <span className="badge">GRANTS BOOK</span>
        </div>
        <div className="table-scroll">
          <table className="table products-table">
            <thead><tr><th>№</th><th>SKU</th><th>Товар</th><th>Продано</th><th>Прибыль / шт</th><th>Чистая прибыль</th><th>Статус</th></tr></thead>
            <tbody>
              {grantsBookTopProducts.map((product) => (
                <tr key={`${product.rank}-${product.sku}`}>
                  <td>{product.rank}</td>
                  <td><code className="sku-code">{product.sku}</code></td>
                  <td><strong>{product.name}</strong></td>
                  <td>{product.units} шт.</td>
                  <td>{money(product.unitProfit)}</td>
                  <td><strong>{money(product.profit)}</strong></td>
                  <td><span className={`status ${product.status === "Рассчитано" ? "status-success" : "status-danger"}`}>{product.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="page-note">На сайте показана оперативная сводка. Полный каталог из 5 858 распознанных товаров остаётся в GRANTS BOOK; далее подключим автоматический импорт каталога через серверный источник, чтобы поиск работал прямо здесь.</p>
    </>
  );
}
