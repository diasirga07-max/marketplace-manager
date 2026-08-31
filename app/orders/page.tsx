"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KaspiLiveOrders } from "@/lib/kaspi-control";

const statuses = ["Все", "Предзаказ", "Упаковка", "Передача"];

export default function OrdersPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Все");
  const [data, setData] = useState<KaspiLiveOrders | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/kaspi/live-orders?t=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setData(payload);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить заказы Kaspi");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (data?.rows ?? []).filter((row) => {
      const matchesStatus = status === "Все" || row.stage === status;
      const haystack = `${row.orderCode} ${row.name} ${row.sku ?? ""} ${row.productCode ?? ""}`.toLowerCase();
      return matchesStatus && (!normalized || haystack.includes(normalized));
    });
  }, [data, query, status]);

  const updatedAt = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString("ru-RU", { timeZone: "Asia/Almaty", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <>
      <header className="header">
        <div>
          <div className="eyebrow">KASPI · LIVE</div>
          <h1>Активные заказы</h1>
          <p className="muted">Предзаказы, упаковка и передача. Обновление каждые 5 секунд · последнее: {updatedAt}</p>
        </div>
        <div className="order-count"><strong>{filtered.length}</strong><span>позиций найдено</span></div>
      </header>

      {data && (
        <section className="cards order-live-cards">
          <article className="card metric-card"><span className="muted">Всего</span><b>{data.counts.all}</b><span className="metric-note">активных позиций</span></article>
          <article className="card metric-card"><span className="muted">Предзаказ</span><b>{data.counts.preorder}</b><span className="metric-note">ожидают обработки</span></article>
          <article className="card metric-card"><span className="muted">Упаковка</span><b>{data.counts.packing}</b><span className="metric-note">на сборке</span></article>
          <article className="card metric-card"><span className="muted">Передача</span><b>{data.counts.transfer}</b><span className="metric-note">готовы к передаче</span></article>
        </section>
      )}

      <div className="panel filters orders-live-filters">
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по заказу, товару, SKU или коду Kaspi" />
        <select className="input select" value={status} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((value) => <option key={value}>{value}</option>)}
        </select>
        <button className="button secondary" type="button" onClick={() => void load()}>↻ Обновить</button>
      </div>

      {error && <div className="panel api-error"><strong>Kaspi API:</strong> {error}</div>}

      <div className="panel table-panel">
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Заказ</th><th>Товар</th><th>SKU / код</th><th>Этап</th><th>Количество</th></tr></thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr key={`${row.orderCode}-${row.sku ?? row.productCode ?? index}-${index}`}>
                  <td><strong>{row.orderCode}</strong></td>
                  <td>
                    <div className="live-product-cell">
                      {row.photo ? <img src={row.photo} alt="" loading="lazy" /> : <div className="live-product-placeholder">Фото</div>}
                      <strong>{row.name || "Без названия"}</strong>
                    </div>
                  </td>
                  <td><code className="sku-code">{row.sku || row.productCode || "—"}</code></td>
                  <td><span className={`status ${row.stage === "Передача" ? "status-success" : "status-info"}`}>{row.stage}</span></td>
                  <td><strong>{row.quantity} шт.</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && !data && <div className="empty">Загружаю живые заказы Kaspi…</div>}
        {!loading && !error && !filtered.length && <div className="empty">По заданным фильтрам активных заказов нет</div>}
      </div>
    </>
  );
}
