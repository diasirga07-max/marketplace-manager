"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import { assemblyNeeds } from "@/lib/finance";
import { Product, products } from "@/lib/mock-data";

type ScanMessage = { type: "success" | "warning" | "danger"; text: string } | null;

export default function AssemblyPage() {
  const needs = useMemo(() => assemblyNeeds(), []);
  const tasks = useMemo(() => products.filter((product) => (needs.get(product.id) ?? 0) > 0), [needs]);
  const [code, setCode] = useState("");
  const [current, setCurrent] = useState<Product | null>(null);
  const [scanned, setScanned] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<ScanMessage>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalRequired = tasks.reduce((sum, product) => sum + (needs.get(product.id) ?? 0), 0);
  const totalScanned = tasks.reduce((sum, product) => sum + Math.min(scanned[product.id] ?? 0, needs.get(product.id) ?? 0), 0);

  function scan(value: string) {
    const barcode = value.trim();
    if (!barcode) return;
    const product = products.find((item) => item.barcode === barcode);

    if (!product) {
      setCurrent(null);
      setMessage({ type: "danger", text: `Штрихкод ${barcode} не найден в каталоге` });
      setCode("");
      inputRef.current?.focus();
      return;
    }

    const required = needs.get(product.id) ?? 0;
    const already = scanned[product.id] ?? 0;
    setCurrent(product);

    if (required === 0) {
      setMessage({ type: "warning", text: "Товар найден, но в текущей сборке он не требуется" });
    } else if (already >= required) {
      setMessage({ type: "warning", text: `Позиция уже собрана полностью: ${required} из ${required}` });
    } else {
      const next = already + 1;
      setScanned((prev) => ({ ...prev, [product.id]: next }));
      setMessage({ type: "success", text: next === required ? "Позиция собрана полностью" : `Товар принят: ${next} из ${required}` });
    }

    setCode("");
    inputRef.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    scan(code);
  }

  const requiredForCurrent = current ? needs.get(current.id) ?? 0 : 0;
  const scannedForCurrent = current ? scanned[current.id] ?? 0 : 0;
  const progress = totalRequired ? Math.round((totalScanned / totalRequired) * 100) : 0;

  return (
    <div className="assembly-page">
      <header className="header">
        <div><div className="eyebrow">СКЛАД · СБОРКА</div><h1>Сканирование товаров</h1><p className="muted">Сканер может работать как обычная клавиатура: штрихкод + Enter</p></div>
        <div className="assembly-total"><strong>{totalScanned} / {totalRequired}</strong><span>товаров собрано</span></div>
      </header>

      <div className="panel assembly-progress-panel">
        <div className="progress-head"><span>Прогресс текущей сборки</span><strong>{progress}%</strong></div>
        <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
      </div>

      <form onSubmit={submit} className="scan-form">
        <input
          ref={inputRef}
          autoFocus
          className="scan-input"
          placeholder="Отсканируйте штрихкод…"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode="numeric"
        />
        <button className="button scan-button" type="submit">Проверить</button>
      </form>

      {message && <div className={`scan-message scan-${message.type}`}>{message.text}</div>}

      {current ? (
        <div className="panel product-card">
          <div className="product-image">{current.emoji}</div>
          <div className="product-info">
            <span className="badge">{current.supplier}</span>
            <h2>{current.name}</h2>
            <p className="muted">SKU: {current.sku}</p>
            <p className="muted">Штрихкод: {current.barcode}</p>
            <div className="qty-row"><span>Нужно</span><strong>{requiredForCurrent} шт.</strong></div>
            <div className="qty-row"><span>Отсканировано</span><strong className={scannedForCurrent >= requiredForCurrent && requiredForCurrent > 0 ? "positive" : ""}>{scannedForCurrent} шт.</strong></div>
          </div>
        </div>
      ) : (
        <div className="panel scan-placeholder"><div className="scan-icon">▥</div><strong>Ожидаю штрихкод</strong><span className="muted">После сканирования здесь появятся товар, количество и поставщик</span></div>
      )}

      <section className="panel assembly-list">
        <div className="panel-title"><div><h2>Что нужно собрать</h2><p className="muted">Демо-позиции из активных заказов</p></div><button type="button" className="button secondary" onClick={() => { setScanned({}); setCurrent(null); setMessage(null); inputRef.current?.focus(); }}>Сбросить</button></div>
        <div className="task-grid">
          {tasks.map((product) => {
            const required = needs.get(product.id) ?? 0;
            const done = scanned[product.id] ?? 0;
            return (
              <button type="button" className={`task-item ${done >= required ? "task-done" : ""}`} key={product.id} onClick={() => scan(product.barcode)}>
                <span className="task-emoji">{product.emoji}</span>
                <span><strong>{product.name}</strong><small>{product.barcode}</small></span>
                <b>{Math.min(done, required)} / {required}</b>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
