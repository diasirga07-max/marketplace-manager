export type OrderStatus = "Новый" | "На сборке" | "Собран" | "Передан в доставку" | "Завершён" | "Отменён";

export type Product = {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  supplier: "WB Алматы" | "Курдай";
  cost: number;
  stock: number;
  emoji: string;
};

export type OrderItem = {
  productId: string;
  quantity: number;
  unitPrice: number;
};

export type Order = {
  id: string;
  createdAt: string;
  status: OrderStatus;
  items: OrderItem[];
  deliveryCost: number;
  commissionRate: number;
  taxRate: number;
};

export const products: Product[] = [
  { id: "p1", name: "Кабель USB-C 2м", sku: "USB-C-2M-BLK", barcode: "4870000000012", supplier: "WB Алматы", cost: 1450, stock: 2, emoji: "🔌" },
  { id: "p2", name: "Чехол iPhone 15", sku: "CASE-IP15-BLK", barcode: "4870000000029", supplier: "Курдай", cost: 1900, stock: 4, emoji: "📱" },
  { id: "p3", name: "Зарядное устройство 20W", sku: "CHARGE-20W", barcode: "4870000000036", supplier: "WB Алматы", cost: 3100, stock: 1, emoji: "🔋" },
  { id: "p4", name: "Защитное стекло iPhone 15", sku: "GLASS-IP15", barcode: "4870000000043", supplier: "Курдай", cost: 650, stock: 8, emoji: "🛡️" },
  { id: "p5", name: "Автодержатель MagSafe", sku: "CAR-MAGSAFE", barcode: "4870000000050", supplier: "WB Алматы", cost: 4200, stock: 0, emoji: "🚗" }
];

export const orders: Order[] = [
  { id: "KSP-10458", createdAt: "2026-08-31T10:35:00+05:00", status: "Новый", deliveryCost: 950, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p1", quantity: 2, unitPrice: 3990 }, { productId: "p4", quantity: 1, unitPrice: 1990 }] },
  { id: "KSP-10457", createdAt: "2026-08-31T09:10:00+05:00", status: "На сборке", deliveryCost: 850, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p3", quantity: 1, unitPrice: 7490 }] },
  { id: "KSP-10456", createdAt: "2026-08-30T18:22:00+05:00", status: "Новый", deliveryCost: 1100, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p5", quantity: 2, unitPrice: 9990 }] },
  { id: "KSP-10455", createdAt: "2026-08-29T14:05:00+05:00", status: "Собран", deliveryCost: 800, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p2", quantity: 2, unitPrice: 4990 }, { productId: "p4", quantity: 2, unitPrice: 1990 }] },
  { id: "KSP-10454", createdAt: "2026-08-28T11:40:00+05:00", status: "Передан в доставку", deliveryCost: 900, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p1", quantity: 3, unitPrice: 3990 }] },
  { id: "KSP-10453", createdAt: "2026-08-27T16:18:00+05:00", status: "Завершён", deliveryCost: 1200, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p3", quantity: 2, unitPrice: 7490 }, { productId: "p5", quantity: 1, unitPrice: 9990 }] },
  { id: "KSP-10452", createdAt: "2026-08-26T12:02:00+05:00", status: "Завершён", deliveryCost: 750, commissionRate: 0.109, taxRate: 0.03, items: [{ productId: "p2", quantity: 1, unitPrice: 4990 }, { productId: "p4", quantity: 3, unitPrice: 1990 }] },
  { id: "KSP-10451", createdAt: "2026-08-25T08:44:00+05:00", status: "Отменён", deliveryCost: 0, commissionRate: 0, taxRate: 0, items: [{ productId: "p1", quantity: 1, unitPrice: 3990 }] }
];

export const productById = Object.fromEntries(products.map((product) => [product.id, product])) as Record<string, Product>;
