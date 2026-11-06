export const SETUP_HINT = 'Did you run npm run setup?';

export function checkAsset(res: Response, url: string): void {
  if (!res.ok || !res.body) throw new Error(`Could not load ${url} (HTTP ${res.status}). ${SETUP_HINT}`);
  if (res.headers.get('content-type')?.toLowerCase().startsWith('text/html'))
    throw new Error(`Could not load ${url} (the server returned a web page, so the file is missing). ${SETUP_HINT}`);
}
