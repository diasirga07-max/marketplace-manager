"use client";

import { useState } from "react";
import { grantsBookMetrics, grantsBookUpdatedAt, GRANTS_BOOK_URL, type GrantsPeriod } from "@/lib/grants-book";

const periods: Array<[GrantsPeriod, string]> = [
  ["day", "День"],
  ["week", "7 дней"],
  ["month", "Месяц"],
  ["year", "Год"]
];

const money = (value: number) => `₸ ${Math.round(value).toLocaleString("ru-RU")}`;

export default function DashboardClient() {
  const [period, setPeriod] = useState<GrantsPeriod>("week");
  const summary = grantsBookMetrics[period];

  return (
    <>
      <header className="header">
        <div>
          <div className="eyebrow">KASPI · GRANTS BOOK</div>
          <h1>Аналитика продаж</h1>
          <p className="muted">Фактическая сводка из листа KASPI_ПРОДАЖИ. Обновление Excel: {grantsBookUpdatedAt}.</p>
        </div>
        <div className="toolbar period-tabs">
          {periods.map(([value, label]) => (
            <button type="button" className={`button ${period === value ? "" : "secondary"}`} key={value} onClick={() => setPeriod(value)}>
              {label}
            </button>
          ))}
          <a className="button secondary link-button" href={GRANTS_BOOK_URL} target="_blank" rel="noreferrer">Открыть GRANTS BOOK ↗</a>
        </div>
      </header>

      {!summary ? (
        <div className="panel empty-state">
          <h2>Годовая сводка ещё не сформирована</h2>
          <p className="muted">В текущем листе KASPI_ПРОДАЖИ есть готовые показатели за день, 7 дней и текущий месяц. После подключения Kaspi API год будет рассчитываться автоматически.</p>
        </div>
      ) : (
        <>
          <section className="cards">
            <article className="card metric-card"><span className="muted">Выручка</span><b>{money(summary.revenue)}</b><span className="metric-note">Период: {summary.label}</span></article>
            <article className="card metric-card"><span className="muted">Завершённые заказы</span><b>{summary.orders.toLocaleString("ru-RU")}</b><span className="metric-note">Средний чек {money(summary.averageCheck)}</span></article>
            <article className="card metric-card profit-card"><span className="muted">Чистая прибыль</span><b>{money(summary.profit)}</b><span className="positive">Маржа {((summary.profit / summary.revenue) * 100).toFixed(1)}%</span></article>
            <article className="card metric-card"><span className="muted">Без расчёта прибыли</span><b>{summary.missingProfit.toLocaleString("ru-RU")}</b><span className="metric-note">Позиции, которые нужно сопоставить с прайсом</span></article>
          </section>

          <section className="grid2">
            <div className="panel">
              <div className="panel-title"><div><h2>Продажи и чистая прибыль</h2><p className="muted">Данные из GRANTS BOOK</p></div></div>
              <div className="value-bars">
                <div className="value-bar-row"><div><span>Выручка</span><strong>{money(summary.revenue)}</strong></div><div className="value-track"><div className="value-fill" style={{ width: "100%" }} /></div></div>
                <div className="value-bar-row"><div><span>Чистая прибыль</span><strong>{money(summary.profit)}</strong></div><div className="value-track"><div className="value-fill profit-fill" style={{ width: `${Math.max((summary.profit / summary.revenue) * 100, 2)}%` }} /></div></div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title"><div><h2>Контроль качества данных</h2><p className="muted">Что влияет на точность прибыли</p></div></div>
              <div className="expense-list">
                <div><span>Средний чек</span><strong>{money(summary.averageCheck)}</strong></div>
                <div><span>Завершённых заказов</span><strong>{summary.orders.toLocaleString("ru-RU")}</strong></div>
                <div><span>Позиций без прибыли</span><strong className={summary.missingProfit ? "negative" : "positive"}>{summary.missingProfit.toLocaleString("ru-RU")}</strong></div>
                <div className="expense-total"><span>Источник</span><strong>GRANTS BOOK</strong></div>
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
