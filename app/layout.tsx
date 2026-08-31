import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marketplace Manager",
  description: "Управление продажами Kaspi, Flip и Teez",
};

const nav = [
  ["/", "Аналитика"],
  ["/orders", "Заказы"],
  ["/suppliers", "Поставщики"],
  ["/assembly", "Сборка"],
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">MM</div>
            <div>
              <strong>Marketplace Manager</strong>
              <p className="muted">Kaspi · MVP</p>
            </div>
            <nav>
              {nav.map(([href, label]) => (
                <Link key={href} href={href}>{label}</Link>
              ))}
            </nav>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
