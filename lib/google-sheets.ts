import { createSign } from "node:crypto";

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type SheetsValuesResponse = {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

let tokenCache: { token: string; expiresAt: number } | null = null;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function serviceAccountCredentials(): ServiceAccountCredentials {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    let parsed: Partial<ServiceAccountCredentials>;
    try {
      parsed = JSON.parse(json) as Partial<ServiceAccountCredentials>;
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON содержит некорректный JSON");
    }

    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        "В GOOGLE_SERVICE_ACCOUNT_JSON отсутствуют client_email или private_key",
      );
    }

    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, "\n"),
    };
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (!clientEmail || !privateKey) {
    throw new Error(
      "Не настроен Google Service Account: задайте GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
    );
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
  };
}

async function googleAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.token;
  }

  const credentials = serviceAccountCredentials();
  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const unsignedJwt = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer.sign(credentials.private_key);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });

  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Google OAuth error ${response.status}: ${payload.error_description || payload.error || "access_token не получен"}`,
    );
  }

  tokenCache = {
    token: payload.access_token,
    expiresAt: now + Math.max(300, payload.expires_in || 3600) * 1000,
  };
  return payload.access_token;
}

async function sheetsRequest<T>(
  spreadsheetId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await googleAccessToken();
  const response = await fetch(
    `${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
      cache: "no-store",
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Google Sheets API ${response.status}: ${text.slice(0, 700) || response.statusText}`,
    );
  }

  return (text ? JSON.parse(text) : {}) as T;
}

export async function readSheetValues(
  spreadsheetId: string,
  range: string,
): Promise<unknown[][]> {
  const payload = await sheetsRequest<SheetsValuesResponse>(
    spreadsheetId,
    `/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
  );
  return Array.isArray(payload.values) ? payload.values : [];
}

export async function writeSheetValues(
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<void> {
  await sheetsRequest(
    spreadsheetId,
    `/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    },
  );
}
