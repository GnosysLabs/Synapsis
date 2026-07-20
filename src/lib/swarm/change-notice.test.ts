import { describe, expect, it } from 'vitest';
import {
  CHANGE_NOTICE_CLOCK_SKEW_MS,
  CHANGE_NOTICE_LIFETIME_MS,
  changeNoticeV1Schema,
  type ChangeNoticeV1,
  validateChangeNoticeTiming,
} from './change-notice';

function noticeAt(nowMs: number): ChangeNoticeV1 {
  return {
    type: 'ChangeNotice',
    version: 1,
    origin: 'origin.social',
    cursor: 42,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + CHANGE_NOTICE_LIFETIME_MS).toISOString(),
  };
}

describe('ChangeNoticeV1 bounds', () => {
  it('accepts a fresh, strict, positive-cursor notice', () => {
    const now = Date.parse('2026-07-20T20:00:00.000Z');
    const notice = changeNoticeV1Schema.parse(noticeAt(now));
    expect(validateChangeNoticeTiming(notice, now)).toBeNull();
  });

  it('rejects unknown fields, non-positive cursors, and excessive lifetimes', () => {
    const now = Date.parse('2026-07-20T20:00:00.000Z');
    expect(() => changeNoticeV1Schema.parse({ ...noticeAt(now), relayCanEdit: true })).toThrow();
    expect(() => changeNoticeV1Schema.parse({ ...noticeAt(now), cursor: 0 })).toThrow();
    expect(validateChangeNoticeTiming({
      ...noticeAt(now),
      expiresAt: new Date(now + CHANGE_NOTICE_LIFETIME_MS + 1).toISOString(),
    }, now)).toBe('invalid lifetime');
  });

  it('rejects notices outside the clock-skew window', () => {
    const now = Date.parse('2026-07-20T20:00:00.000Z');
    expect(validateChangeNoticeTiming({
      ...noticeAt(now),
      issuedAt: new Date(now + CHANGE_NOTICE_CLOCK_SKEW_MS + 1).toISOString(),
      expiresAt: new Date(now + CHANGE_NOTICE_CLOCK_SKEW_MS + CHANGE_NOTICE_LIFETIME_MS).toISOString(),
    }, now)).toBe('issued in the future');
    expect(validateChangeNoticeTiming({
      ...noticeAt(now - CHANGE_NOTICE_LIFETIME_MS - CHANGE_NOTICE_CLOCK_SKEW_MS - 1),
    }, now)).toBe('expired');
  });
});
