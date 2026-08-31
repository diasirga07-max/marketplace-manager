"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { grantsBookMetrics, grantsBookUpdatedAt, GRANTS_BOOK_URL, type GrantsPeriod } from "@/lib/grants-book";
import type { KaspiStats } from "@/lib/kaspi-control";

const periods: Array<[GrantsPeriod, string]> = [
  ["day", "День"],
  ["week", "7 дней"],
  ["month", "Месяц"],
  ["year", "Год"]
];

const money = (value: number | null | undefined) => value == null ? "—" : `₸ ${Math.round(value).toLocaleString("ru-RU")}`;

export default function DashboardClient() {
  const [period, setPeriod] = useState<GrantsPeriod>("week");
  const [live, setLive] = useState<KaspiStats | null>(null);
  const [apiError, setApiError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const snapshot = grantsBookMetrics[period];

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/kaspi/stats?period=${period}&t=${Date.now()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setLive(payload);
      setApiError("");
    } catch (cause) {
      setLive(null);
      setApiError(cause instanceof Error ? cause.message : "Не удалось получить статистику Kaspi");
    } finally {
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const values = useMemo(() => {
    const revenue = live?.summary.sales ?? snapshot?.revenue ?? null;
    const orders = live?.orders?.length ?? snapshot?.orders ?? null;
    const profit = snapshot?.profit ?? null;
    const averageCheck = revenue != null && orders ? revenue / orders : snapshot?.averageCheck ?? null;
    const margin = revenue && profit != null ? (profit / revenue) * 100 : null;
    return { revenue, orders, profit, averageCheck, margin, delivery: live?.summary.delivery ?? null };
  }, [live, snapshot]);

  const rangeLabel = live?.range ? `${live.range.fromDate} — ${live.range.toDate}` : snapshot?.label ?? "—";

  return (
    <>
      <header className="header">
        <div>
          <div className="eyebrow">KASPI LIVE · GRANTS BOOK</div>
          <h1>Аналитика продаж</h1>
          <p className="muted">Продажи и заказы — Kaspi LIVE. Чистая прибыль — GRANTS BOOK, снимок {grantsBookUpdatedAt}.</p>
        </div>
        <div className="toolbar period-tabs">
          {periods.map(([value, label]) => (
            <button type="button" className={`button ${period === value ? "" : "secondary"}`} key={value} onClick={() => setPeriod(value)}>
              {label}
            </button>
          ))}
          <button className="button secondary" type="button" onClick={() => void load()} disabled={refreshing}>{refreshing ? "Обновляю…" : "↻ Live"}</button>
          <a className="button secondary link-button" href={GRANTS_BOOK_URL} target="_blank" rel="noreferrer">GRANTS BOOK ↗</a>
        </div>
      </header>

      {apiError && (
        <div className="panel api-warning">
          <strong>Kaspi LIVE временно недоступен.</strong> Показываю последний снимок GRANTS BOOK там, где он есть. <span>{apiError}</span>
        </div>
      )}

      <section className="cards">
        <article className="card metric-card"><span className="muted">Выручка</span><b>{money(values.revenue)}</b><span className="metric-note">Период: {rangeLabel}</span></article>
        <article className="card metric-card"><span className="muted">Заказы</span><b>{values.orders?.toLocaleString("ru-RU") ?? "—"}</b><span className="metric-note">Средний чек {money(values.averageCheck)}</span></article>
        <article className="card metric-card profit-card"><span className="muted">Чистая прибыль</span><b>{money(values.profit)}</b><span className={values.margin != null ? "positive" : "metric-note"}>{values.margin != null ? `Маржа ${values.margin.toFixed(1)}%` : "Будет рассчитана из GRANTS BOOK"}</span></article>
        <article className="card metric-card"><span className="muted">Доставка Kaspi</span><b>{money(values.delivery)}</b><span className="metric-note">Live API, если доступно</span></article>
      </section>

      <section className="grid2">
        <div className="panel">
          <div className="panel-title"><div><h2>Продажи и чистая прибыль</h2><p className="muted">Комбинация Kaspi LIVE + GRANTS BOOK</p></div></div>
          {values.revenue != null ? (
            <div className="value-bars">
              <div className="value-bar-row"><div><span>Выручка</span><strong>{money(values.revenue)}</strong></div><div className="value-track"><div className="value-fill" style={{ width: "100%" }} /></div></div>
              <div className="value-bar-row"><div><span>Чистая прибыль</span><strong>{money(values.profit)}</strong></div><div className="value-track"><div className="value-fill profit-fill" style={{ width: `${values.revenue && values.profit != null ? Math.max((values.profit / values.revenue) * 100, 2) : 0}%` }} /></div></div>
            </div>
          ) : <div className="empty">Нет данных за выбранный период</div>}
        </div>

        <div className="panel">
          <div className="panel-title"><div><h2>Источники данных</h2><p className="muted">Что обновляется автоматически</p></div></div>
          <div className="expense-list">
            <div><span>Продажи / заказы</span><strong className={live ? "positive" : "negative"}>{live ? "Kaspi LIVE" : "Снимок"}</strong></div>
            <div><span>Прибыль / себестоимость</span><strong>GRANTS BOOK</strong></div>
            <div><span>Средний чек</span><strong>{money(values.averageCheck)}</strong></div>
            <div className="expense-total"><span>Период</span><strong>{rangeLabel}</strong></div>
          </div>
        </div>
      </section>
    </>
  );
}
