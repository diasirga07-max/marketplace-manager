const orders = [
  ["KSP-10452","Кабель USB-C 2м","2","Новый"],
  ["KSP-10451","Чехол iPhone 15","1","На сборке"],
  ["KSP-10450","Зарядное устройство 20W","3","Собран"],
];
export default function OrdersPage(){return <><header className="header"><div><h1>Заказы</h1><p className="muted">Заказы Kaspi и статусы сборки</p></div></header><div className="panel"><table className="table"><thead><tr><th>Заказ</th><th>Товар</th><th>Кол-во</th><th>Статус</th></tr></thead><tbody>{orders.map(o=><tr key={o[0]}><td>{o[0]}</td><td>{o[1]}</td><td>{o[2]}</td><td><span className="badge">{o[3]}</span></td></tr>)}</tbody></table></div></>}
