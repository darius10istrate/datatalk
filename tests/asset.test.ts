import { describe, expect, it } from 'vitest';
import { checkAsset } from '../src/db/asset.ts';
import { sqlString } from '../shared/sql.ts';

const URL = '/data/trips.parquet';

describe('checkAsset', () => {
  it('accepts a parquet response', () => {
    const res = new Response(new Uint8Array([0x50, 0x41, 0x52, 0x31]), { headers: { 'content-type': 'application/vnd.apache.parquet' } });
    expect(() => checkAsset(res, URL)).not.toThrow();
  });

  it('rejects the SPA fallback page served for a missing file', () => {
    const res = new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    expect(() => checkAsset(res, URL)).toThrow(/Did you run npm run setup\?/);
  });

  it('rejects a 404', () => {
    expect(() => checkAsset(new Response('', { status: 404 }), URL)).toThrow(/HTTP 404.*npm run setup/);
  });
});

describe('sqlString', () => {
  it('doubles single quotes in a path', () => {
    expect(sqlString("/Users/o'brien/datatalk")).toBe("'/Users/o''brien/datatalk'");
  });
});
