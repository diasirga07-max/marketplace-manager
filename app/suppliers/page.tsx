import { supplierNeeds } from "@/lib/finance";

export default function SuppliersPage() {
  const rows = supplierNeeds();
  const suppliers = ["WB Алматы", "Курдай"] as const;

  return (
    <>
      <header className="header">
        <div><div className="eyebrow">ЗАКУПКА</div><h1>Сортировка поставщикам</h1><p className="muted">Система автоматически собирает потребность из новых заказов и заказов на сборке</p></div>
      </header>

      <section className="supplier-summary">
        {suppliers.map((supplier) => {
          const supplierRows = rows.filter((row) => row.product.supplier === supplier);
          const needed = supplierRows.reduce((sum, row) => sum + row.needed, 0);
          const shortage = supplierRows.reduce((sum, row) => sum + row.shortage, 0);
          return (
            <article className="card" key={supplier}>
              <span className="muted">Поставщик</span>
              <b>{supplier}</b>
              <div className="supplier-stats"><span>Нужно <strong>{needed} шт.</strong></span><span>Докупить <strong className={shortage ? "negative" : "positive"}>{shortage} шт.</strong></span></div>
            </article>
          );
        })}
      </section>

      <div className="panel table-panel">
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Товар</th><th>SKU</th><th>Поставщик</th><th>Нужно по заказам</th><th>Есть на складе</th><th>Докупить</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.productId}>
                  <td><strong>{row.product.emoji} {row.product.name}</strong></td>
                  <td className="muted">{row.product.sku}</td>
                  <td><span className="badge">{row.product.supplier}</span></td>
                  <td>{row.needed}</td>
                  <td>{row.product.stock}</td>
                  <td><strong className={row.shortage ? "negative" : "positive"}>{row.shortage}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="page-note">Логика уже готова: после подключения Kaspi список будет строиться по реальным активным заказам.</p>
    </>
  );
}
