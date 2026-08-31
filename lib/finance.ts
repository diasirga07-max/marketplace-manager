import { Order, orders, productById } from "./mock-data";

export function formatMoney(value: number) {
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(value))} ₸`;
}

export function orderFinancials(order: Order) {
  if (order.status === "Отменён") {
    return { revenue: 0, cost: 0, delivery: 0, commission: 0, tax: 0, profit: 0 };
  }

  const revenue = order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const cost = order.items.reduce((sum, item) => sum + (productById[item.productId]?.cost ?? 0) * item.quantity, 0);
  const delivery = order.deliveryCost;
  const commission = revenue * order.commissionRate;
  const tax = revenue * order.taxRate;
  const profit = revenue - cost - delivery - commission - tax;

  return { revenue, cost, delivery, commission, tax, profit };
}

export function summarize(source: Order[]) {
  return source.reduce(
    (acc, order) => {
      const f = orderFinancials(order);
      acc.revenue += f.revenue;
      acc.cost += f.cost;
      acc.delivery += f.delivery;
      acc.commission += f.commission;
      acc.tax += f.tax;
      acc.profit += f.profit;
      if (order.status !== "Отменён") acc.orders += 1;
      acc.units += order.status === "Отменён" ? 0 : order.items.reduce((sum, item) => sum + item.quantity, 0);
      return acc;
    },
    { revenue: 0, cost: 0, delivery: 0, commission: 0, tax: 0, profit: 0, orders: 0, units: 0 }
  );
}

export function filterByPeriod(period: "day" | "week" | "month" | "year") {
  const valid = orders.filter((order) => order.status !== "Отменён");
  const reference = new Date(Math.max(...valid.map((order) => new Date(order.createdAt).getTime())));
  const start = new Date(reference);

  if (period === "day") start.setHours(0, 0, 0, 0);
  if (period === "week") {
    start.setDate(reference.getDate() - 6);
    start.setHours(0, 0, 0, 0);
  }
  if (period === "month") start.setDate(1), start.setHours(0, 0, 0, 0);
  if (period === "year") start.setMonth(0, 1), start.setHours(0, 0, 0, 0);

  return valid.filter((order) => new Date(order.createdAt) >= start && new Date(order.createdAt) <= reference);
}

export function salesByDay(source: Order[]) {
  const map = new Map<string, number>();
  for (const order of source) {
    const key = order.createdAt.slice(0, 10);
    map.set(key, (map.get(key) ?? 0) + orderFinancials(order).revenue);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export function supplierNeeds() {
  const active = orders.filter((order) => order.status === "Новый" || order.status === "На сборке");
  const demand = new Map<string, number>();

  for (const order of active) {
    for (const item of order.items) demand.set(item.productId, (demand.get(item.productId) ?? 0) + item.quantity);
  }

  return [...demand.entries()].map(([productId, needed]) => {
    const product = productById[productId];
    const available = Math.min(product.stock, needed);
    return {
      productId,
      product,
      needed,
      available,
      shortage: Math.max(needed - product.stock, 0)
    };
  });
}

export function assemblyNeeds() {
  const active = orders.filter((order) => order.status === "Новый" || order.status === "На сборке");
  const demand = new Map<string, number>();
  for (const order of active) {
    for (const item of order.items) demand.set(item.productId, (demand.get(item.productId) ?? 0) + item.quantity);
  }
  return demand;
}
