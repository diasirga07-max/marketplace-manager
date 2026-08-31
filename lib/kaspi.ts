const baseUrl = process.env.KASPI_API_BASE_URL ?? "https://kaspi.kz/shop/api/v2";

export async function kaspiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.KASPI_API_KEY;
  if (!token) throw new Error("KASPI_API_KEY is not configured");

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/vnd.api+json",
      "X-Auth-Token": token,
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`Kaspi API error: ${response.status}`);
  return response.json() as Promise<T>;
}
