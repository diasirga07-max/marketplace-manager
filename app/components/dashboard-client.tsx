"use client";

import { useMemo, useState } from "react";
import { filterByPeriod, formatMoney, salesByDay, summarize } from "@/lib/finance";

const periods = [
  ["day", "День"],
  ["week", "Неделя"],
  ["month", "Месяц"],
  ["year", "Год"]
] as const;

type Period = (typeof periods)[number][0];

export default function DashboardClient() {
  const [period, setPeriod] = useState<Period>("week");
  const source = useMemo(() => filterByPeriod(period), [period]);
  const summary = useMemo(() => summarize(source), [source]);
  const chart = useMemo(() => salesByDay(source), [source]);
  const maxSale = Math.max(...chart.map((item) => item.value), 1);
  const averageCheck = summary.orders ? summary.revenue / summary.orders : 0;
  const margin = summary.revenue ? (summary.profit / summary.revenue) * 100 : 0;

  return (
    <>
      <header className="header">
        <div>
          <div className="eyebrow">KASPI · ДЕМО-ДАННЫЕ</div>
          <h1>Аналитика продаж</h1>
          <p className="muted">Финансовая сводка магазина. Расчёты уже работают, API подключим следующим шагом.</p>
        </div>
        <div className="toolbar period-tabs">
          {periods.map(([value, label]) => (
            <button
              type="button"
              className={`button ${period === value ? "" : "secondary"}`}
              key={value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <section className="cards">
        <article className="card metric-card"><span className="muted">Выручка</span><b>{formatMoney(summary.revenue)}</b><span className="metric-note">{summary.units} шт. продано</span></article>
        <article className="card metric-card"><span className="muted">Заказы</span><b>{summary.orders}</b><span className="metric-note">Средний чек {formatMoney(averageCheck)}</span></article>
        <article className="card metric-card"><span className="muted">Расходы</span><b>{formatMoney(summary.cost + summary.delivery + summary.commission + summary.tax)}</b><span className="metric-note">Все учтённые расходы</span></article>
        <article className="card metric-card profit-card"><span className="muted">Чистая прибыль</span><b>{formatMoney(summary.profit)}</b><span className="positive">Маржа {margin.toFixed(1)}%</span></article>
      </section>

      <section className="grid2">
        <div className="panel">
          <div className="panel-title"><div><h2>Продажи по дням</h2><p className="muted">Выручка по выбранному периоду</p></div></div>
          {chart.length ? (
            <div className="sales-chart">
              {chart.map((item) => (
                <div className="bar-row" key={item.date}>
                  <span className="bar-date">{new Date(`${item.date}T12:00:00`).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max((item.value / maxSale) * 100, 4)}%` }} /></div>
                  <strong>{formatMoney(item.value)}</strong>
                </div>
              ))}
            </div>
          ) : <div className="empty">Нет продаж за период</div>}
        </div>

        <div className="panel">
          <div className="panel-title"><div><h2>Структура расходов</h2><p className="muted">Что уменьшает прибыль</p></div></div>
          <div className="expense-list">
            <div><span>Себестоимость</span><strong>{formatMoney(summary.cost)}</strong></div>
            <div><span>Доставка</span><strong>{formatMoney(summary.delivery)}</strong></div>
            <div><span>Комиссия Kaspi</span><strong>{formatMoney(summary.commission)}</strong></div>
            <div><span>Налог</span><strong>{formatMoney(summary.tax)}</strong></div>
            <div className="expense-total"><span>Всего расходов</span><strong>{formatMoney(summary.cost + summary.delivery + summary.commission + summary.tax)}</strong></div>
          </div>
        </div>
      </section>
    </>
  );
}
