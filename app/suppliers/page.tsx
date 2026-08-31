const rows=[
  ["Кабель USB-C 2м","WB Алматы","24","18","6"],
  ["Чехол iPhone 15","Курдай","12","12","0"],
  ["Зарядное устройство 20W","WB Алматы","15","7","8"],
];
export default function SuppliersPage(){return <><header className="header"><div><h1>Сортировка поставщикам</h1><p className="muted">Агрегированные потребности из заказов</p></div></header><div className="panel"><table className="table"><thead><tr><th>Товар</th><th>Поставщик</th><th>Нужно</th><th>Получено</th><th>Не хватает</th></tr></thead><tbody>{rows.map(r=><tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td><td className={r[4]==="0"?"positive":"negative"}>{r[4]}</td></tr>)}</tbody></table></div></>}
