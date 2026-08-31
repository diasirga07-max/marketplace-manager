export const GRANTS_BOOK_URL = "https://docs.google.com/spreadsheets/d/1dLU5KOi3WBLy3uNEiqGv5rf9ka0OwcEw_RjhDQW3H1E/edit";

export type GrantsPeriod = "day" | "week" | "month" | "year";

export type GrantsBookMetric = {
  revenue: number;
  orders: number;
  missingProfit: number;
  profit: number;
  averageCheck: number;
  label: string;
};

export const grantsBookUpdatedAt = "29.08.2026 19:09";

export const grantsBookMetrics: Record<GrantsPeriod, GrantsBookMetric | null> = {
  day: {
    revenue: 104230,
    orders: 43,
    missingProfit: 5,
    profit: 20487,
    averageCheck: 2424,
    label: "29.08.2026"
  },
  week: {
    revenue: 1329365,
    orders: 372,
    missingProfit: 95,
    profit: 280621,
    averageCheck: 3574,
    label: "22.08–29.08.2026"
  },
  month: {
    revenue: 4620294,
    orders: 1158,
    missingProfit: 469,
    profit: 1076477,
    averageCheck: 3990,
    label: "01.08–29.08.2026"
  },
  year: null
};

export const grantsBookTopProducts = [
  { rank: 1, sku: "147236320_909948224", name: "Нет названия в Прайс KASPI", units: 20, unitProfit: null, profit: null, status: "Нет в прайсе" },
  { rank: 2, sku: "143654326_078013334", name: "Essential Grammar in Use with Answers and Interactive eBook", units: 14, unitProfit: 2075, profit: 29050, status: "Рассчитано" },
  { rank: 3, sku: "OPTBOOK558", name: "Н.Н.Талеб: Антихрупкость. Как извлечь выгоду из хаоса", units: 14, unitProfit: 1183, profit: 16562, status: "Рассчитано" },
  { rank: 4, sku: "KITAPENT00088", name: "Математика Рустюмова қазақ тілінде", units: 13, unitProfit: 1500, profit: 19500, status: "Рассчитано" },
  { rank: 5, sku: "103885134_935512928", name: "Нет названия в Прайс KASPI", units: 11, unitProfit: null, profit: null, status: "Нет в прайсе" },
  { rank: 6, sku: "WBBOOK1250", name: "English File Elementary. 4th Edition Student's Book + Workbook + CD", units: 10, unitProfit: 1467, profit: 14670, status: "Рассчитано" },
  { rank: 7, sku: "AR194234614", name: "Глобус 10,6", units: 10, unitProfit: 116, profit: 1160, status: "Рассчитано" },
  { rank: 8, sku: "117084016_764475312", name: "Ручка шариковая Triangle 1 шт, 0.7 мм, цвет чернил синий", units: 10, unitProfit: null, profit: null, status: "Нет прибыли" },
  { rank: 9, sku: "166128998_832307966", name: "Книга Джеймс К.: Атомные привычки", units: 9, unitProfit: 1194, profit: 10746, status: "Рассчитано" },
  { rank: 10, sku: "147236353_039571452", name: "Нет названия в Прайс KASPI", units: 9, unitProfit: null, profit: null, status: "Нет в прайсе" },
  { rank: 11, sku: "WBBOOK1272", name: "English Vocabulary in Use Pre-intermediate and Intermediate", units: 8, unitProfit: 1315, profit: 10520, status: "Рассчитано" },
  { rank: 12, sku: "OPTBOOK041", name: "Бакман Ф.: Вторая жизнь Уве", units: 8, unitProfit: 782, profit: 6256, status: "Рассчитано" },
  { rank: 13, sku: "136723958_044354724", name: "Учебник Murphy R.: Essential Grammar in Use with audio", units: 7, unitProfit: 1900, profit: 13300, status: "Рассчитано" },
  { rank: 14, sku: "OPTBOOK518", name: "Бакман Ф.: Медвежий угол", units: 7, unitProfit: 1183, profit: 8281, status: "Рассчитано" },
  { rank: 15, sku: "117155763_322446166", name: "Ручка шариковая Obama Marble 1 шт, 0.7 мм", units: 7, unitProfit: null, profit: null, status: "Нет прибыли" },
  { rank: 16, sku: "121212641_549676662", name: "Нет названия в Прайс KASPI", units: 7, unitProfit: null, profit: null, status: "Нет в прайсе" },
  { rank: 17, sku: "OPTBOOK578", name: "Тысячи сияющих солнц", units: 6, unitProfit: 1240, profit: 7440, status: "Рассчитано" },
  { rank: 18, sku: "OPTBOOK595", name: "Гибкое сознание", units: 6, unitProfit: 1240, profit: 7440, status: "Рассчитано" },
  { rank: 19, sku: "146453310_166683933", name: "Держатель для мела 22company 394949 желтый", units: 6, unitProfit: 67, profit: 402, status: "Рассчитано" },
  { rank: 20, sku: "143467487_019604207", name: "Нет названия в Прайс KASPI", units: 6, unitProfit: null, profit: null, status: "Нет в прайсе" }
] as const;

export const grantsBookCatalogStats = {
  rowsInPriceSheet: 6365,
  recognizedProducts: 5858,
  productsWithProfit: 4244
};
