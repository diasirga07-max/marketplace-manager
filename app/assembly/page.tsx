"use client";
import { useState } from "react";

const demo: Record<string,{name:string;sku:string;need:number;emoji:string}>={
  "4870000000012":{name:"Кабель USB-C 2м",sku:"USB-C-2M-BLK",need:2,emoji:"🔌"},
  "4870000000029":{name:"Чехол iPhone 15",sku:"CASE-IP15-BLK",need:1,emoji:"📱"},
};

export default function AssemblyPage(){
 const [code,setCode]=useState(""); const product=demo[code];
 return <div className="scan"><header className="header"><div><h1>Сборка заказов</h1><p className="muted">Отсканируйте штрихкод товара</p></div></header><input autoFocus className="scan-input" placeholder="Штрихкод…" value={code} onChange={e=>setCode(e.target.value.trim())}/>{product?<div className="panel product-card"><div className="product-image">{product.emoji}</div><div><span className="badge">Найден</span><h2>{product.name}</h2><p className="muted">SKU: {product.sku}</p><p>Штрихкод: {code}</p><div className="qty">Нужно: {product.need} шт.</div></div></div>:code?<div className="panel" style={{marginTop:20}}><strong className="negative">Товар с таким штрихкодом не найден</strong></div>:null}<p className="muted">Для демо: 4870000000012 или 4870000000029. После подключения базы данные будут загружаться автоматически.</p></div>
}
