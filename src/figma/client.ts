export interface FigmaApi {
  get<T>(path: string): Promise<T>;
}

export class FigmaClient implements FigmaApi {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly token: string) {}

  async get<T>(path: string): Promise<T> {
    if (this.cache.has(path)) return this.cache.get(path) as T;

    // Personal access tokens (figd_) must go in X-Figma-Token; Authorization: Bearer is OAuth-only.
    const response = await fetch(`https://api.figma.com/v1${path}`, {
      headers: { "X-Figma-Token": this.token },
    });

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 400);
      throw new Error(`Figma API returned ${response.status} for ${path}: ${body}`);
    }

    const data = (await response.json()) as T;
    this.cache.set(path, data);
    return data;
  }
}
