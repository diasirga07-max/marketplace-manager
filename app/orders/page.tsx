"use client";

import { useMemo, useState } from "react";
import { formatMoney, orderFinancials } from "@/lib/finance";
import { orders, productById } from "@/lib/mock-data";

const statuses = ["Все", "Новый", "На сборке", "Собран", "Передан в доставку", "Завершён", "Отменён"];

export default function OrdersPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Все");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesStatus = status === "Все" || order.status === status;
      const productText = order.items.map((item) => `${productById[item.productId]?.name ?? ""} ${productById[item.productId]?.sku ?? ""}`).join(" ").toLowerCase();
      const matchesQuery = !normalized || order.id.toLowerCase().includes(normalized) || productText.includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [query, status]);

  return (
    <>
      <header className="header">
        <div><div className="eyebrow">KASPI</div><h1>Заказы</h1><p className="muted">Поиск, статусы и финансовый результат каждого заказа</p></div>
        <div className="order-count"><strong>{filtered.length}</strong><span>заказов найдено</span></div>
      </header>

      <div className="panel filters">
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по заказу, товару или SKU" />
        <select className="input select" value={status} onChange={(event) => setStatus(event.target.value)}>
          {statuses.map((value) => <option key={value}>{value}</option>)}
        </select>
      </div>

      <div className="panel table-panel">
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Заказ</th><th>Дата</th><th>Товары</th><th>Статус</th><th>Выручка</th><th>Прибыль</th></tr></thead>
            <tbody>
              {filtered.map((order) => {
                const finances = orderFinancials(order);
                return (
                  <tr key={order.id}>
                    <td><strong>{order.id}</strong></td>
                    <td>{new Date(order.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>
                      <div className="order-items">
                        {order.items.map((item) => {
                          const product = productById[item.productId];
                          return <span key={item.productId}>{product?.emoji} {product?.name} <b>×{item.quantity}</b></span>;
                        })}
                      </div>
                    </td>
                    <td><span className={`status status-${order.status === "Отменён" ? "danger" : order.status === "Завершён" ? "success" : "info"}`}>{order.status}</span></td>
                    <td>{formatMoney(finances.revenue)}</td>
                    <td className={finances.profit > 0 ? "positive" : order.status === "Отменён" ? "muted" : "negative"}>{formatMoney(finances.profit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!filtered.length && <div className="empty">По заданным фильтрам заказов нет</div>}
      </div>
    </>
  );
}
