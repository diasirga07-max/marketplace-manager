const metrics = [
  ["Выручка", "₸ 1 284 500", "+12.4%"],
  ["Заказы", "184", "+8.1%"],
  ["Расходы", "₸ 346 200", "26.9%"],
  ["Чистая прибыль", "₸ 412 760", "+15.7%"],
];

export default function Dashboard() {
  return (
    <>
      <header className="header">
        <div><h1>Аналитика Kaspi</h1><p className="muted">Финансовая сводка магазина</p></div>
        <div className="toolbar"><button className="button secondary">День</button><button className="button">Неделя</button><button className="button secondary">Месяц</button><button className="button secondary">Год</button></div>
      </header>
      <section className="cards">
        {metrics.map(([label,value,change]) => <article className="card" key={label}><span className="muted">{label}</span><b>{value}</b><span className="positive">{change}</span></article>)}
      </section>
      <section className="grid2">
        <div className="panel"><h2>Продажи по дням</h2><p className="muted">Здесь будет график после подключения реальных данных Kaspi.</p><div style={{height:220,display:"grid",placeItems:"center",border:"1px dashed #ccd2d9",borderRadius:12}}>График продаж</div></div>
        <div className="panel"><h2>Расходы</h2><table className="table"><tbody><tr><td>Себестоимость</td><td>₸ 185 000</td></tr><tr><td>Доставка</td><td>₸ 62 400</td></tr><tr><td>Комиссия Kaspi</td><td>₸ 73 800</td></tr><tr><td>Налог</td><td>₸ 25 000</td></tr></tbody></table></div>
      </section>
    </>
  );
}
