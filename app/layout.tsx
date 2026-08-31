import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import "./grants-book.css";

export const metadata: Metadata = {
  title: "Marketplace Manager",
  description: "Управление продажами Kaspi, Flip и Teez",
  robots: { index: false, follow: false }
};

const nav = [
  ["/", "Аналитика", "▦"],
  ["/products", "Товары", "□"],
  ["/orders", "Заказы", "≡"],
  ["/suppliers", "Поставщики", "⇄"],
  ["/assembly", "Сборка", "▥"],
  ["/settings", "Настройки", "⚙"]
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand-row"><div className="brand">MM</div><div><strong>Marketplace</strong><span>Manager</span></div></div>
            <div className="market-chip"><span className="kaspi-dot" />Kaspi · GRANTS BOOK</div>
            <nav>
              {nav.map(([href, label, icon]) => (
                <Link key={href} href={href}><span className="nav-icon">{icon}</span>{label}</Link>
              ))}
            </nav>
            <div className="sidebar-footer"><span>Этап 1</span><strong>Kaspi</strong><small>Далее: Flip и Teez</small></div>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
